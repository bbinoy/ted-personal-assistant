import { createHash } from "node:crypto";
import { closeSync, copyFileSync, cpSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  convIdOfKey, friendConvId, groupConvId, hashOf, isConvId, LAYOUT_VERSION, layout, legacyLayout, tenantIdOfConv, type ConvId,
} from "./convpaths.ts";
import { writeFileAtomic } from "./state.ts";

// The move from the old layout (state/, memory/, tenants/, logs/ by kind of file) to layout version 2 (instance/, conversations/<convId>/, logs/): core/convpaths.ts describes both.
//
//   planMigration(root, fs)   PURE (given a view of the files): the whole list of moves, computed before anything is touched. Written to instance/migration-plan.json.
//   migrate(root)             does the moves with renameSync (copy, fsync, verify, delete across devices), records each one in the plan, writes instance/layout-version LAST.
//
// Properties, each tested (test/migrate.test.ts):
//   * idempotent and resumable: a crash after k moves is continued from the stored plan; every move looks at what is there first (source gone and target present = done);
//   * nothing is deleted except after a verified move; a source whose target exists already with other content is MOVED to instance/migration-orphans/ instead, never overwritten;
//   * a file whose conversation cannot be told (a group folder with no id in its meta.json, a pending file whose hash matches nobody, an unknown file in state/) is an orphan: moved
//     to instance/migration-orphans/<its old path> and listed in agent.log, never dropped;
//   * a conversation folder (a friend's, a group's) is renamed WHOLE, then the few names that changed are renamed inside it; per-file moves into a conversation come after;
//   * the plan holds paths and folder names only: no raw group id (the group ids are read from meta.json while planning and hashed on the spot);
//   * one process at a time (instance/migration.lock, a directory made atomically, stale when its pid is gone).
// What stays: state/openbao and state/tts-qwen (installed software whose paths are baked into its config and launchd job), state/voice's own reference clip (named in .env).

export type OpKind = "move" | "rekey" | "split-sources" | "orphan";
export interface Op {
  id: number;
  kind: OpKind;
  from: string;
  to: string; // for a split: the old file's orphan copy of what belongs to nobody (written only when there is such a remainder)
  rekey?: "group-cost" | "cap-notices";
  friends?: string[]; // split-sources: the friends (tenant ids) and groups (folder names) that exist, so a key is mapped only to a conversation that is there
  groups?: ConvId[];
  note?: string;
  done?: true;
}
export interface Plan {
  version: typeof LAYOUT_VERSION;
  createdAt: string;
  root: string;
  ops: Op[];
  completedAt?: string;
  ownerTold?: boolean; // the owner has been told once, in her chat, that storage was reorganised
}

// ---- the files, as the planner sees them (a real folder, or a fake in a test) ----

export interface Entry {
  name: string;
  dir: boolean;
}
export interface FsView {
  exists(path: string): boolean;
  isDir(path: string): boolean;
  list(dir: string): Entry[];
  readJson(path: string): unknown;
}
export const realFs: FsView = {
  exists: (p) => { try { lstatSync(p); return true; } catch { return false; } },
  isDir: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
  list: (d) => { try { return readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() || (e.isSymbolicLink() && realFs.isDir(join(d, e.name))) })); } catch { return []; } },
  readJson: (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } },
};

const TENANT_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const SIDE = /^(?:\d+|corrupt-.+)$/; // the rotated generations (.1, .2) and the moved-aside copies (.corrupt-<time>) of a file travel with it
const HASH16 = /^[0-9a-f]{16}$/;

// ---- the plan ----

export function planMigration(root: string, fs: FsView = realFs, now: Date = new Date()): Plan {
  const L = layout(root);
  const old = legacyLayout(root);
  const ops: Op[] = [];
  const claimed = new Set<string>(); // old paths that have a move (or are deliberately left)
  const add = (kind: OpKind, from: string, to: string, extra: Partial<Op> = {}) => void ops.push({ id: ops.length, kind, from, to, ...extra });
  const move = (from: string, to: string, note?: string) => {
    claimed.add(from);
    add("move", from, to, note ? { note } : {});
  };
  const orphan = (from: string, why: string) => {
    claimed.add(from);
    add("orphan", from, join(L.instance.migrationOrphans, relative(L.root, from)), { note: why });
  };
  // a file with its rotated generations and moved-aside copies
  const moveWithSides = (from: string, to: string) => {
    if (fs.exists(from)) move(from, to);
    const dir = dirname(from);
    const base = basename(from);
    for (const e of fs.list(dir)) if (e.name.startsWith(`${base}.`) && SIDE.test(e.name.slice(base.length + 1))) move(join(dir, e.name), `${to}${e.name.slice(base.length)}`);
  };

  // who exists: friends (the registry and the tenants/ folder), groups (memory/groups/<key>/meta.json), and the hash each is known by in old file names
  const registry = fs.readJson(old.registry) as { tenants?: { id?: unknown }[] } | undefined;
  const friendIds = new Set<string>([
    ...((registry && Array.isArray(registry.tenants) ? registry.tenants : []).map((t) => t?.id).filter((i): i is string => typeof i === "string" && TENANT_ID.test(i) && i !== "owner")),
    ...fs.list(old.tenants).filter((e) => e.dir && TENANT_ID.test(e.name) && e.name !== "owner").map((e) => e.name),
  ]);
  const groupDirs = new Map<string, ConvId>(); // old folder name (key) -> convId
  const groupConvs = new Set<ConvId>();
  const dupes: string[] = [];
  const groupsListed = fs.list(old.groupsDir);
  for (const e of groupsListed.filter((x) => x.dir).sort((a, b) => a.name.localeCompare(b.name))) {
    const meta = fs.readJson(old.groupMeta(e.name)) as { id?: unknown } | undefined;
    if (!meta || typeof meta.id !== "string" || meta.id === "") continue;
    const conv = groupConvId(meta.id);
    if (groupConvs.has(conv)) { dupes.push(e.name); continue; } // two old folders for one group: the first keeps the name, the other is kept apart
    groupConvs.add(conv);
    groupDirs.set(e.name, conv);
  }
  const hashToConv = new Map<string, ConvId>(); // the 16 hex of an old pending file or voice folder -> the conversation it was of
  for (const c of groupConvs) hashToConv.set(c.slice("group-".length), c);
  for (const id of friendIds) hashToConv.set(hashOf(`tenant:${id}`), friendConvId(id));

  // 1. whole conversation folders first (nothing else may create a target folder before they move)
  for (const e of fs.list(old.tenants)) {
    if (e.dir && friendIds.has(e.name)) move(join(old.tenants, e.name), L.conv(friendConvId(e.name)).dir, "a friend's folder");
    else orphan(join(old.tenants, e.name), "not a friend's folder");
  }
  for (const e of groupsListed) {
    const from = join(old.groupsDir, e.name);
    const conv = groupDirs.get(e.name);
    if (e.dir && conv) move(from, L.conv(conv).dir, "a group's folder");
    else orphan(from, e.dir ? (dupes.includes(e.name) ? "a second folder for a group that has one already" : "a group folder with no id in its meta.json") : "not a group folder");
  }
  // 2. the names that changed inside a moved folder
  const renames = (conv: ConvId, oldDir: string) => {
    for (const [was, now2] of old.renamedInFolder) if (fs.exists(join(oldDir, was))) move(join(L.conv(conv).dir, was), join(L.conv(conv).dir, now2));
  };
  for (const e of fs.list(old.tenants)) if (e.dir && friendIds.has(e.name)) renames(friendConvId(e.name), join(old.tenants, e.name));
  for (const [key, conv] of groupDirs) renames(conv, join(old.groupsDir, key));

  // 3. the owner's own files
  for (const m of old.owner) if (fs.exists(m.from)) moveWithSides(m.from, m.to);
  // 4. group histories and pending approvals
  const logNames = fs.list(old.logs).filter((e) => !e.dir).map((e) => e.name);
  for (const name of logNames) {
    const m = /^group-([0-9a-f]{12})\.jsonl(\.(?:\d+|corrupt-.+))?$/.exec(name);
    if (!m) continue;
    const conv = groupDirs.get(m[1]!);
    const from = join(old.logs, name);
    if (conv) move(from, `${L.conv(conv).messages}${m[2] ?? ""}`);
    else orphan(from, "a group history whose group folder has no id");
  }
  if (fs.exists(old.pendingOwner)) move(old.pendingOwner, L.conv("owner").pending);
  for (const e of fs.list(old.state)) {
    const m = /^pending-([0-9a-f]{16})\.json$/.exec(e.name);
    if (!m) continue;
    const conv = hashToConv.get(m[1]!);
    if (conv) move(join(old.state, e.name), L.conv(conv).pending);
    else orphan(join(old.state, e.name), "pending approvals of a conversation that is not here");
  }
  // 5. voices: the owner's library at the top of state/voice, each other conversation's under groups/<hash>/; the default reference clip stays where it is
  const libraryOf = (from: string, conv: ConvId) => {
    if (fs.exists(join(from, "active.json"))) move(join(from, "active.json"), join(L.conv(conv).voices, "active.json"));
    for (const v of fs.list(join(from, "voices"))) {
      if (v.dir) move(join(from, "voices", v.name), join(L.conv(conv).voices, v.name));
      else orphan(join(from, "voices", v.name), "not a voice");
    }
  };
  libraryOf(old.voice.dir, "owner");
  for (const e of fs.list(old.voice.groups)) {
    const conv = e.dir && HASH16.test(e.name) ? hashToConv.get(e.name) : undefined;
    if (conv) libraryOf(join(old.voice.groups, e.name), conv);
    else orphan(join(old.voice.groups, e.name), "voices of a conversation that is not here");
  }
  if (fs.exists(old.voice.sources)) {
    claimed.add(old.voice.sources);
    add("split-sources", old.voice.sources, join(L.instance.migrationOrphans, relative(L.root, old.voice.sources)), { friends: [...friendIds].sort(), groups: [...groupConvs].sort(), note: "voice-note sources, one file per conversation" });
  }
  // 6. process-wide files
  for (const m of old.instance) {
    if (m.rekey) {
      if (fs.exists(m.from)) { claimed.add(m.from); add("rekey", m.from, m.to, { rekey: m.rekey }); }
      for (const e of fs.list(dirname(m.from))) if (e.name.startsWith(`${basename(m.from)}.`) && SIDE.test(e.name.slice(basename(m.from).length + 1))) move(join(dirname(m.from), e.name), `${m.to}${e.name.slice(basename(m.from).length)}`);
    } else moveWithSides(m.from, m.to);
  }
  // 7. what is left in state/ and memory/ and belongs to nobody we know: kept apart, listed, never dropped
  const stays = new Set(old.staysInState);
  for (const e of fs.list(old.state)) {
    const p = join(old.state, e.name);
    if (stays.has(p) || claimed.has(p)) continue;
    orphan(p, "an unknown entry of state/");
  }
  for (const e of fs.list(old.memory)) {
    const p = join(old.memory, e.name);
    if (p === old.groupsDir || claimed.has(p)) continue;
    orphan(p, "an unknown entry of memory/");
  }
  return { version: LAYOUT_VERSION, createdAt: now.toISOString(), root: L.root, ops };
}

/** Pure: the plan as lines for `npm run migrate -- --dry-run`. */
export function describePlan(plan: Plan): string[] {
  const rel = (p: string) => relative(plan.root, p) || ".";
  const counts: Record<string, number> = {};
  for (const o of plan.ops) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
  if (plan.ops.length === 0) return ["Nothing to move: the data folder is in the current layout already (or is new)."];
  return [
    ...plan.ops.map((o) => {
      const tail = o.note ? `   (${o.note})` : "";
      if (o.kind === "split-sources") return `split    ${rel(o.from)}  into each conversation's voices/ folder${tail}`;
      if (o.kind === "rekey") return `rekey    ${rel(o.from)}  ->  ${rel(o.to)}   (raw group ids become folder names)`;
      return `${o.kind === "orphan" ? "ORPHAN  " : "move    "} ${rel(o.from)}  ->  ${rel(o.to)}${tail}`;
    }),
    `${plan.ops.length} step(s): ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}.`,
  ];
}

// ---- state of a data folder ----

export type LayoutState = { state: "fresh" | "current" | "unmigrated" } | { state: "newer"; version: number };

export function readVersion(root: string): number | undefined {
  try {
    const n = Number(readFileSync(layout(root).instance.layoutVersion, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function layoutState(root: string, fs: FsView = realFs): LayoutState {
  const v = readVersion(root);
  if (v !== undefined) return v > LAYOUT_VERSION ? { state: "newer", version: v } : v === LAYOUT_VERSION ? { state: "current" } : { state: "unmigrated" };
  if (fs.exists(layout(root).instance.migrationPlan)) return { state: "unmigrated" }; // interrupted
  return { state: planMigration(root, fs).ops.length > 0 ? "unmigrated" : "fresh" };
}

export const MIGRATE_HINT = "run `npm run migrate` (it moves the data into the new layout, safely and once), or just start the agent";
/** The sentence a tool that will not migrate gives instead (null when it may go on). */
export function refusal(s: LayoutState): string | null {
  if (s.state === "newer") return `This data folder is in a newer layout (version ${s.version}) than this code understands (${LAYOUT_VERSION}): update the code; it will not touch the data.`;
  if (s.state === "unmigrated") return `This data folder is in the old layout (state/, memory/, tenants/): ${MIGRATE_HINT}.`;
  return null;
}

// ---- doing it ----

export interface MigrateOptions {
  fs?: FsView;
  log?: (line: string) => void;
  now?: () => Date;
  crashAfter?: number; // tests: throw after this many steps have been recorded, as a crash would
  forceCopy?: boolean; // tests: take the cross-device path (copy, verify, delete) for every move
}
export interface MigrateResult {
  already: boolean;
  moved: number; // steps done in this run
  orphans: string[]; // the old paths that were set aside
  plan?: Plan;
}

const exists = (p: string): boolean => realFs.exists(p);
const hashFile = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

function fsyncPath(p: string): void {
  try {
    const fd = openSync(p, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* best effort: a folder cannot be opened everywhere */ }
}
function files(p: string, out: string[] = [], base = p): string[] {
  const st = lstatSync(p);
  if (st.isDirectory()) { out.push(`${relative(base, p) || "."}/`); for (const n of readdirSync(p).sort()) files(join(p, n), out, base); } else out.push(relative(base, p));
  return out;
}
/** Are the two trees the same: every name, and every file's size and bytes? (the check before a copied source is deleted) */
export function sameTree(a: string, b: string): boolean {
  try {
    const la = files(a);
    const lb = files(b);
    if (la.join("\n") !== lb.join("\n")) return false;
    return la.every((f) => f.endsWith("/") || (lstatSync(join(a, f)).size === lstatSync(join(b, f)).size && hashFile(join(a, f)) === hashFile(join(b, f))));
  } catch {
    return false;
  }
}
const emptyTree = (p: string): boolean => {
  try {
    return files(p).every((f) => f.endsWith("/"));
  } catch {
    return false;
  }
};

function fsyncTree(p: string): void {
  if (lstatSync(p).isDirectory()) { for (const n of readdirSync(p)) fsyncTree(join(p, n)); } else fsyncPath(p);
  fsyncPath(p);
}

/** Moves one thing. rename when it can; across devices copy, fsync, verify, then delete. Returns what happened. */
function moveOne(from: string, to: string, forceCopy = false): "moved" | "copied" {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    if (forceCopy) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
    renameSync(from, to);
    fsyncPath(dirname(to));
    return "moved";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
  }
  if (lstatSync(from).isDirectory()) cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  else copyFileSync(from, to);
  fsyncTree(to);
  if (!sameTree(from, to)) {
    rmSync(to, { recursive: true, force: true }); // (the copy only; the source is untouched)
    throw new Error(`copy of ${from} did not verify; left in place`);
  }
  rmSync(from, { recursive: true, force: true });
  return "copied";
}

function orphanPath(root: string, from: string): string {
  const base = join(layout(root).instance.migrationOrphans, relative(root, from));
  let p = base;
  for (let n = 2; exists(p); n++) p = `${base}.${n}`;
  return p;
}

// The rewrites of two process-wide files whose keys held raw group ids. Pure.
export function rekeyGroupCost(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  const o = v as { day?: unknown; usd?: Record<string, number> };
  const usd: Record<string, number> = {};
  for (const [k, n] of Object.entries(o.usd ?? {})) {
    const c = isConvId(k) ? k : convIdOfKey(k);
    usd[c] = (usd[c] ?? 0) + (typeof n === "number" ? n : 0);
  }
  return { ...o, usd };
}
const noticeKey = (k: string): string => {
  const m = /^(group|group-budget|warn):(.*)$/.exec(k);
  if (!m) return k;
  const [, kind, rest] = m as unknown as [string, string, string];
  if (kind === "warn") return isConvId(rest) ? k : `warn:${convIdOfKey(rest)}`;
  return isConvId(rest) ? k : `${kind}:${convIdOfKey(rest)}`;
};
export function rekeyCapNotices(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  const o = v as { keys?: unknown; at?: Record<string, number> };
  return {
    ...o,
    ...(Array.isArray(o.keys) ? { keys: [...new Set(o.keys.map((k) => (typeof k === "string" ? noticeKey(k) : k)))] } : {}),
    ...(o.at && typeof o.at === "object" ? { at: Object.fromEntries(Object.entries(o.at).map(([k, t]) => [noticeKey(k), t])) } : {}),
  };
}

interface SourcesFile {
  notes?: Record<string, unknown[]>;
  quotes?: Record<string, Record<string, number>>;
}

class Mover {
  orphans: string[] = [];
  readonly root: string;
  readonly o: MigrateOptions;
  constructor(root: string, o: MigrateOptions) {
    this.root = root;
    this.o = o;
  }
  private log = (l: string) => (this.o.log ?? (() => {}))(l);

  /** Set a source aside in instance/migration-orphans/ (never overwriting anything there), and list it. */
  setAside(from: string, why: string): void {
    const to = orphanPath(this.root, from);
    moveOne(from, to, this.o.forceCopy);
    this.orphans.push(from);
    this.log(`migrate: set aside ${relative(this.root, from)} -> ${relative(this.root, to)} (${why})`);
  }

  run(op: Op): void {
    if (op.kind === "move" || op.kind === "orphan") return this.move(op);
    if (op.kind === "rekey") return this.rekey(op);
    return this.split(op);
  }

  private move(op: Op): void {
    const { from, to } = op;
    if (!exists(from)) return; // done before (a resumed run), or never there
    if (op.kind === "orphan") {
      if (exists(to) && sameTree(from, to)) return void rmSync(from, { recursive: true, force: true }); // an earlier, interrupted copy that verifies
      this.orphans.push(from);
      this.log(`migrate: set aside ${relative(this.root, from)} (${op.note ?? "orphan"})`);
      moveOne(from, orphanPath(this.root, from), this.o.forceCopy);
      return;
    }
    if (exists(to)) {
      const dirs = lstatSync(from).isDirectory() && lstatSync(to).isDirectory();
      if (dirs && emptyTree(to)) rmSync(to, { recursive: true, force: true }); // an empty skeleton made at start-up
      else if (sameTree(from, to)) return void rmSync(from, { recursive: true, force: true }); // the same content is there already: the source is a verified duplicate
      else return this.setAside(from, `${relative(this.root, to)} exists with other content`);
    }
    moveOne(from, to, this.o.forceCopy);
  }

  private readTransformWrite(op: Op, f: (v: unknown) => unknown): void {
    const { from, to } = op;
    if (!exists(from)) return;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(from, "utf8"));
    } catch {
      return this.setAside(from, "not JSON"); // kept for a human, not dropped
    }
    const out = JSON.stringify(f(value));
    if (exists(to)) {
      if (readFileSync(to, "utf8") === out) return void rmSync(from, { force: true }); // written by an earlier, interrupted run
      return this.setAside(from, `${relative(this.root, to)} exists with other content`);
    }
    writeFileAtomic(to, out);
    if (readFileSync(to, "utf8") !== out) throw new Error(`${to} did not verify`);
    rmSync(from, { force: true });
  }

  private rekey(op: Op): void {
    this.readTransformWrite(op, op.rekey === "group-cost" ? rekeyGroupCost : rekeyCapNotices);
  }

  // state/voice/sources.json: notes and quotes by conversation key -> one voices/sources.json per conversation. What belongs to nobody that exists goes to the orphans, whole.
  private split(op: Op): void {
    const from = op.from;
    if (!exists(from)) return;
    let src: SourcesFile;
    try {
      src = JSON.parse(readFileSync(from, "utf8")) as SourcesFile;
    } catch {
      return this.setAside(from, "not JSON");
    }
    const friends = new Set(op.friends ?? []);
    const groups = new Set(op.groups ?? []);
    const mapKey = (k: string): ConvId | undefined => {
      const c = convIdOfKey(k);
      const t = tenantIdOfConv(c);
      return c === "owner" || (t !== undefined && friends.has(t)) || groups.has(c) ? c : undefined;
    };
    const by = new Map<ConvId, { notes: unknown[]; quotes: Record<string, number> }>();
    const rest: SourcesFile = { notes: {}, quotes: {} };
    for (const [k, list] of Object.entries(src.notes ?? {})) {
      const c = mapKey(k);
      if (c) by.set(c, { notes: list, quotes: by.get(c)?.quotes ?? {} });
      else rest.notes![k] = list;
    }
    for (const [k, q] of Object.entries(src.quotes ?? {})) {
      const c = mapKey(k);
      if (c) by.set(c, { notes: by.get(c)?.notes ?? [], quotes: q });
      else rest.quotes![k] = q;
    }
    for (const [c, data] of by) {
      const target = layout(this.root).conv(c).voiceSources;
      const text = JSON.stringify(data);
      if (exists(target) && readFileSync(target, "utf8") !== text) {
        rest.notes![c] = data.notes; // that conversation has sources already (other content): these are set aside whole, not merged
        continue;
      }
      writeFileAtomic(target, text);
      if (readFileSync(target, "utf8") !== text) throw new Error(`${target} did not verify`);
    }
    if (Object.keys(rest.notes!).length || Object.keys(rest.quotes!).length) {
      const aside = orphanPath(this.root, from);
      writeFileAtomic(aside, JSON.stringify(rest));
      this.orphans.push(from);
      this.log(`migrate: voice-note sources of conversations that are not here set aside in ${relative(this.root, aside)}`);
    }
    rmSync(from, { force: true });
  }
}

// ---- the lock: one process migrates at a time ----

function takeLock(root: string, wait = 0): () => void {
  const lock = layout(root).instance.migrationLock;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const until = Date.now() + wait;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "pid"), String(process.pid));
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let alive = false;
      try {
        const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
        process.kill(pid, 0);
        alive = pid !== process.pid;
      } catch { /* no pid file or no such process: stale */ }
      if (!alive) { rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() >= until) throw new Error("another process is migrating the data folder right now; try again in a minute");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

function loadPlan(root: string): Plan | undefined {
  try {
    const p = JSON.parse(readFileSync(layout(root).instance.migrationPlan, "utf8")) as Plan;
    return p && p.version === LAYOUT_VERSION && Array.isArray(p.ops) ? p : undefined;
  } catch {
    return undefined;
  }
}
const savePlan = (root: string, plan: Plan): void => writeFileAtomic(layout(root).instance.migrationPlan, `${JSON.stringify(plan, null, 1)}\n`);

/** After the moves: the old folders that are empty now go (rmdir only: a folder with anything in it stays). */
function sweepEmpty(root: string, plan: Plan): void {
  const keep = new Set([layout(root).root, layout(root).logs.dir]);
  const dirs = new Set<string>();
  for (const o of plan.ops) {
    let p = o.from;
    while (p !== dirname(p) && !keep.has(p) && p.startsWith(layout(root).root + sep)) { dirs.add(p); p = dirname(p); }
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) try { rmdirSync(d); } catch { /* not empty, or not there */ }
}

/**
 * The whole migration. Safe to call at every start: a current layout returns at once; an interrupted one continues from its stored plan.
 * `wait`: how long to wait for another process that is migrating (ms).
 */
export function migrate(root: string, o: MigrateOptions = {}, wait = 30_000): MigrateResult {
  const L = layout(root);
  if (readVersion(root) !== undefined) {
    const v = readVersion(root)!;
    if (v > LAYOUT_VERSION) throw new Error(refusal({ state: "newer", version: v })!);
    if (v === LAYOUT_VERSION) return { already: true, moved: 0, orphans: [] };
  }
  const release = takeLock(root, wait);
  try {
    if (readVersion(root) === LAYOUT_VERSION) return { already: true, moved: 0, orphans: [] };
    const fs = o.fs ?? realFs;
    let plan = loadPlan(L.root);
    const resumed = plan !== undefined;
    if (!plan) {
      plan = planMigration(L.root, fs, (o.now ?? (() => new Date()))());
      if (plan.ops.length > 0) savePlan(L.root, plan);
    }
    const log = o.log ?? (() => {});
    if (plan.ops.length > 0) log(`migrate: ${resumed ? "continuing" : "starting"}: ${plan.ops.filter((x) => !x.done).length} of ${plan.ops.length} step(s) to do (instance/migration-plan.json)`);
    const mover = new Mover(L.root, o);
    let done = 0;
    for (const op of plan.ops) {
      if (op.done) continue;
      mover.run(op);
      op.done = true;
      savePlan(L.root, plan);
      done++;
      if (o.crashAfter !== undefined && done >= o.crashAfter) throw new Error("simulated crash");
    }
    sweepEmpty(L.root, plan);
    mkdirSync(L.instance.dir, { recursive: true, mode: 0o700 });
    if (plan.ops.length > 0) {
      plan.completedAt = (o.now ?? (() => new Date()))().toISOString();
      savePlan(L.root, plan);
    }
    writeFileAtomic(L.instance.layoutVersion, `${LAYOUT_VERSION}\n`); // LAST: until it exists, the next start continues from the plan
    if (plan.ops.length > 0) {
      const aside = new Set([...plan.ops.filter((x) => x.kind === "orphan").map((x) => x.from), ...mover.orphans]).size;
      log(`migrate: data folder is in layout version ${LAYOUT_VERSION}: ${plan.ops.length} step(s)${aside ? `, ${aside} set aside in instance/migration-orphans/ (listed above)` : ""}`);
    }
    return { already: false, moved: done, orphans: mover.orphans, plan };
  } finally {
    release();
  }
}

// ---- telling the owner once ----

export const REORGANISED_TEXT = "I reorganised how I store my data on this Mac: one folder per conversation now, instead of files sorted by kind. Nothing was lost and there is nothing for you to do.";
/** The one-time notice for the owner's chat (undefined when there is nothing to tell, or she has been told). Marking it told is separate: call `markOwnerTold` once it is sent. */
export function ownerNotice(root: string): string | undefined {
  const plan = loadPlan(root);
  return plan && plan.ops.length > 0 && !plan.ownerTold && readVersion(root) === LAYOUT_VERSION ? REORGANISED_TEXT : undefined;
}
export function markOwnerTold(root: string): void {
  const plan = loadPlan(root);
  if (plan && !plan.ownerTold) savePlan(root, { ...plan, ownerTold: true });
}

