import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, copyFileSync, cpSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  convIdOfKey, friendConvId, groupConvId, hashOf, INSTANCE_DB_VERSION, isConvId, LAYOUT_VERSION, layout, layout3, legacyLayout, MOVES_VERSION, tenantIdOfConv, type ConvId,
} from "./convpaths.ts";
import { isInside } from "./contain.ts";
import { writeFileAtomic } from "./state.ts";
import { hasLegacyFiles as hasInstanceLegacy, importLegacy, type ImportResult } from "./dbimport.ts";
import { hasConvLegacyFiles, importConvLegacy, type ConvImportResult } from "./convimport.ts";

const hasLegacy = (root: string): boolean => hasInstanceLegacy(root) || hasConvLegacyFiles(root);

// The move from the old layout (state/, memory/, tenants/, logs/ by kind of file) to layout version 2 (instance/, conversations/<convId>/, logs/): core/convpaths.ts describes both. Two imports follow, each with
// its own stamp: layout 3 (the process-wide files into instance.db: core/dbimport.ts) and layout 4 (each conversation's small files into its assistant.db: core/convimport.ts). A crash between them leaves the
// stamp of the last finished one, and the next start continues with the next.
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
  cache?: true; // a cache folder: merged into one that exists, duplicates discarded, never a conflict
  copying?: true; // a cross-device copy was started: a partial target is deleted and copied again on resume
  friends?: string[]; // split-sources: the friends (tenant ids) and groups (folder names) that exist, so a key is mapped only to a conversation that is there
  groups?: ConvId[];
  note?: string;
  done?: true;
}
export interface Plan {
  version: typeof MOVES_VERSION;
  createdAt: string;
  root: string;
  ops: Op[];
  backup: string; // where the originals of what is REWRITTEN (not moved) are copied first: instance/migration-backup/<time>/<old path>
  aside?: string[]; // old paths (relative to the data folder) that were set aside instead of moved
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
const APPEND = /^(?:messages|payments|heartbeat)\.jsonl(?:\.\d+)?$/; // append-only logs: two writers' lines are merged, not one set aside

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
  // a folder with no file at any depth (what is left of a library whose contents were moved) is not data: it is never a step
  const hollow = (p: string): boolean => fs.isDir(p) && fs.list(p).every((e) => e.dir && hollow(join(p, e.name)));
  const orphan = (from: string, why: string) => {
    claimed.add(from);
    if (hollow(from)) return;
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
  const claims = new Map<ConvId, { name: string; own: boolean }[]>(); // convId -> the old folders that say they are that group's
  for (const e of groupsListed.filter((x) => x.dir).sort((a, b) => a.name.localeCompare(b.name))) {
    const meta = fs.readJson(old.groupMeta(e.name)) as { id?: unknown } | undefined;
    if (!meta || typeof meta.id !== "string" || meta.id === "") continue;
    const conv = groupConvId(meta.id);
    claims.set(conv, [...(claims.get(conv) ?? []), { name: e.name, own: e.name === createHash("sha256").update(meta.id).digest("hex").slice(0, 12) }]);
  }
  for (const [conv, list] of claims) {
    // two old folders for one group (one was made by someone grinding ids onto another's hash): the folder named by the group's own id wins, else the first; the others are kept apart
    const keep = list.find((c) => c.own) ?? list[0]!;
    groupConvs.add(conv);
    groupDirs.set(keep.name, conv);
    for (const c of list) if (c !== keep) dupes.push(c.name);
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
  if (fs.exists(old.pendingOwner)) move(old.pendingOwner, layout3(root).conv("owner").pending);
  for (const e of fs.list(old.state)) {
    const m = /^pending-([0-9a-f]{16})\.json$/.exec(e.name);
    if (!m) continue;
    const conv = hashToConv.get(m[1]!);
    if (conv) move(join(old.state, e.name), layout3(root).conv(conv).pending);
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
  // a cache is merged into a folder the new code made first (npm run setup:browse puts the Chromium in instance/browse/browsers before the first start): never a conflict
  for (const o of ops) if (o.kind === "move" && (o.to === L.instance.browse || o.to === L.instance.shore)) o.cache = true;
  for (const e of fs.list(old.state)) if (!e.dir && /^payments-\d{4}(-\d+)?\.jsonl$/.test(e.name)) move(join(old.state, e.name), join(L.instance.dir, e.name), "an archive of the payment ledger"); // (never deleted, so never an orphan)
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
  return { version: MOVES_VERSION, createdAt: now.toISOString(), root: L.root, ops, backup: join(L.instance.migrationBackup, now.toISOString().replace(/[:.]/g, "-")) };
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
  if (s.state === "unmigrated") return `This data folder is in the old layout (state/, memory/, tenants/; or layout 2 or 3, whose small files instance.db and each conversation's assistant.db now hold): ${MIGRATE_HINT}.`;
  return null;
}

// ---- doing it ----

export interface MigrateOptions {
  fs?: FsView;
  log?: (line: string) => void;
  now?: () => Date;
  crashAfter?: number; // tests: throw after this many steps have been recorded, as a crash would
  late?: boolean; // after the stamp: a conflict is set aside, never a reason to stop the agent
  forceCopy?: boolean; // tests: take the cross-device path (copy, verify, delete) for every move
  movesOnly?: boolean; // tests: stop at layout 2 (the files moved, the stamp 2), before the import into instance.db: the state a crash between the two leaves, and what the move tests look at
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
function moveOne(from: string, to: string, forceCopy = false, beforeCopy?: () => void): "moved" | "copied" {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    if (forceCopy) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
    renameSync(from, to);
    fsyncPath(dirname(to));
    return "moved";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
  }
  beforeCopy?.(); // (the plan records that a copy began: a crash leaves a partial target that a resume deletes and copies again)
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
  readonly backupDir: string;
  backedUp = 0;
  save: (() => void) | undefined; // records the plan (a copy has begun)
  merged: string[] = [];
  constructor(root: string, o: MigrateOptions, backupDir: string) {
    this.root = root;
    this.o = o;
    this.backupDir = backupDir;
  }

  /** Before a file is rewritten: its original, byte for byte, fsynced, in the backup folder (kept for good). A move by rename needs no copy. */
  private backup(from: string): void {
    const to = join(this.backupDir, relative(this.root, from));
    if (!exists(from) || exists(to)) return; // (an earlier, interrupted run copied it already)
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(from, to);
    fsyncPath(to);
    fsyncPath(dirname(to));
    if (!sameTree(from, to)) throw new Error(`the backup of ${from} did not verify`);
    this.backedUp++;
  }
  private log = (l: string) => (this.o.log ?? (() => {}))(l);

  /** Set a source aside in instance/migration-orphans/ (never overwriting anything there), and list it. */
  setAside(from: string, why: string): void {
    const to = orphanPath(this.root, from);
    moveOne(from, to, this.o.forceCopy);
    this.orphans.push(relative(this.root, from));
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
    const began = () => {
      op.copying = true;
      this.save?.();
    };
    if (op.copying && exists(to)) rmSync(to, { recursive: true, force: true }); // a copy was begun and not finished: the partial target is not data, the source is
    if (op.kind === "orphan") {
      if (exists(to) && sameTree(from, to)) return void rmSync(from, { recursive: true, force: true }); // an earlier, interrupted copy that verifies
      this.orphans.push(relative(this.root, from));
      this.log(`migrate: set aside ${relative(this.root, from)} (${op.note ?? "orphan"})`);
      moveOne(from, orphanPath(this.root, from), this.o.forceCopy, began);
      return;
    }
    if (exists(to)) {
      if (op.cache) return this.mergeCache(from, to);
      const dirs = lstatSync(from).isDirectory() && lstatSync(to).isDirectory();
      if (dirs && emptyTree(to)) rmSync(to, { recursive: true, force: true }); // an empty skeleton made at start-up
      else if (sameTree(from, to)) return void rmSync(from, { recursive: true, force: true }); // the same content is there already: the source is a verified duplicate
      else if (!dirs && APPEND.test(basename(to)) && lstatSync(from).isFile() && lstatSync(to).isFile()) return this.mergeLines(from, to); // a log two writers appended to: both keep their lines
      else if (!this.o.late && isInside(to, layout(this.root).conversations)) {
        throw new Error(`${relative(this.root, from)} and ${relative(this.root, to)} both exist with different content, and it is a conversation's data, so nothing is overwritten and the migration stops here. Keep the one that is right (move the other out of the way), then start again: it continues from instance/migration-plan.json.`);
      } else return this.setAside(from, `${relative(this.root, to)} exists with other content`);
    }
    moveOne(from, to, this.o.forceCopy, began);
  }

  // A cache (the downloaded browser, the shore outlines): what the new folder lacks is moved in, what it has already is discarded. Never a conflict.
  private mergeCache(from: string, to: string): void {
    if (lstatSync(from).isDirectory() && lstatSync(to).isDirectory()) {
      for (const n of readdirSync(from)) {
        if (!exists(join(to, n))) moveOne(join(from, n), join(to, n), this.o.forceCopy);
        else this.mergeCache(join(from, n), join(to, n));
      }
    }
    rmSync(from, { recursive: true, force: true });
  }

  // Two files of lines (a history, a ledger): the union, identical lines once, in time order where the lines say when (a line without a time keeps its neighbour's).
  private mergeLines(from: string, to: string): void {
    const lines = (p: string) => readFileSync(p, "utf8").split("\n").filter((l) => l !== "");
    const all = [...new Set([...lines(to), ...lines(from)])];
    const when = (l: string): number | undefined => {
      try {
        const o = JSON.parse(l) as { at?: unknown; ts?: unknown };
        const t = typeof o.at === "string" ? Date.parse(o.at) : typeof o.ts === "number" ? o.ts : typeof o.ts === "string" ? Date.parse(o.ts) : NaN;
        return Number.isFinite(t) ? t : undefined;
      } catch {
        return undefined;
      }
    };
    let last = -Infinity;
    const keyed = all.map((l, i) => ({ l, i, k: (last = when(l) ?? last) }));
    const ordered = keyed.some((x) => when(x.l) !== undefined) ? keyed.sort((a, b) => a.k - b.k || a.i - b.i) : keyed;
    const out = `${ordered.map((x) => x.l).join("\n")}\n`;
    writeFileAtomic(to, out);
    if (readFileSync(to, "utf8") !== out) throw new Error(`${to} did not verify`);
    rmSync(from, { force: true });
    this.merged.push(relative(this.root, from));
    this.log(`migrate: merged the lines of ${relative(this.root, from)} into ${relative(this.root, to)}`);
  }

  private readTransformWrite(op: Op, f: (v: unknown) => unknown): void {
    const { from, to } = op;
    if (!exists(from)) return;
    this.backup(from);
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
    this.backup(from);
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
      const target = layout3(this.root).conv(c).voiceSources;
      const text = JSON.stringify(data);
      if (exists(target) && readFileSync(target, "utf8") !== text) {
        rest.notes![c] = data.notes; // that conversation has sources already (other content): these are set aside whole (notes and quotes), not merged
        rest.quotes![c] = data.quotes;
        continue;
      }
      writeFileAtomic(target, text);
      if (readFileSync(target, "utf8") !== text) throw new Error(`${target} did not verify`);
    }
    if (Object.keys(rest.notes!).length || Object.keys(rest.quotes!).length) {
      const aside = orphanPath(this.root, from);
      writeFileAtomic(aside, JSON.stringify(rest));
      this.orphans.push(relative(this.root, from));
      this.log(`migrate: voice-note sources of conversations that are not here set aside in ${relative(this.root, aside)}`);
    }
    rmSync(from, { force: true });
  }
}

// ---- the lock: one process migrates at a time ----

const startOf = (pid: number): string => {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const LOCK_GRACE_MS = 10_000;

/** Is this lock held by a process that is still the one that took it? A lock with no readable pid is a new one being made (alive) for 10 s; a pid that now has another start time was reused. */
function lockHeld(lock: string): boolean {
  let text: string;
  try {
    text = readFileSync(join(lock, "pid"), "utf8");
  } catch {
    try {
      return Date.now() - statSync(lock).mtimeMs < LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }
  const [first, ...rest] = text.split("\n");
  const pid = Number(first);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false; // no such process
  }
  const recorded = rest.join("\n").trim();
  const now = recorded ? startOf(pid) : "";
  return !(recorded && now && recorded !== now); // alive, unless it started at another time than the one that took the lock
}

function takeLock(root: string, wait = 0): () => void {
  const lock = layout(root).instance.migrationLock;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const until = Date.now() + wait;
  const mine = `${lock}.${process.pid}.tmp`;
  for (;;) {
    // made complete (with its pid) in a temp folder and renamed into place: the rename succeeds for one process only, and nobody ever sees a lock without its pid
    rmSync(mine, { recursive: true, force: true });
    mkdirSync(mine, { mode: 0o700 });
    writeFileSync(join(mine, "pid"), `${process.pid}\n${startOf(process.pid)}`);
    try {
      renameSync(mine, lock);
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (e) {
      rmSync(mine, { recursive: true, force: true });
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw e;
    }
    if (!lockHeld(lock)) {
      const gone = `${lock}.stale.${process.pid}`;
      try {
        renameSync(lock, gone); // (taken away whole: only one process can)
        rmSync(gone, { recursive: true, force: true });
      } catch { /* someone else did */ }
      continue;
    }
    if (Date.now() >= until) throw new Error(`another process is migrating the data folder right now (lock: ${lock}); try again in a minute, or remove that folder if no migration is running`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

function loadPlan(root: string): Plan | undefined {
  try {
    const p = JSON.parse(readFileSync(layout(root).instance.migrationPlan, "utf8")) as Plan;
    return p && p.version === MOVES_VERSION && Array.isArray(p.ops) ? p : undefined;
  } catch {
    return undefined;
  }
}
const savePlan = (root: string, plan: Plan): void => writeFileAtomic(layout(root).instance.migrationPlan, `${JSON.stringify(plan, null, 1)}\n`);

/** After the moves: the old folders that are empty now go (rmdir only: a folder with anything in it stays). */
function sweepEmpty(root: string, ops: readonly Op[]): void {
  const keep = new Set([layout(root).root, layout(root).logs.dir]);
  const dirs = new Set<string>();
  for (const o of ops) {
    let p = o.from;
    while (p !== dirname(p) && !keep.has(p) && p.startsWith(layout(root).root + sep)) { dirs.add(p); p = dirname(p); }
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      if (emptyTree(d)) rmSync(d, { recursive: true, force: true }); // no file at any depth: only folders go, never a file
    } catch { /* not there */ }
  }
}

const nowOf = (o: MigrateOptions): Date => (o.now ?? (() => new Date()))();
const backupFolder = (root: string, now: Date): string => join(layout(root).instance.migrationBackup, now.toISOString().replace(/[:.]/g, "-"));

/**
 * The whole migration. Safe to call at every start: a current layout returns at once (but see `reconcile`); an interrupted one continues from its stored plan.
 * When the plan is done the old layout is planned AGAIN, and whatever is there (something an old process wrote meanwhile, or a plan resumed after a rollback to old code) is moved too, until nothing is.
 * `wait`: how long to wait for another process that is migrating (ms).
 */
export function migrate(root: string, o: MigrateOptions = {}, wait = 30_000): MigrateResult {
  const L = layout(root);
  if (readVersion(root) !== undefined) {
    const v = readVersion(root)!;
    if (v > LAYOUT_VERSION) throw new Error(refusal({ state: "newer", version: v })!);
    if (v === LAYOUT_VERSION || (o.movesOnly && v === MOVES_VERSION)) {
      if (v === LAYOUT_VERSION) importLeftovers(root, o, wait); // (files an old version wrote late and reconcile moved into instance/ or into a conversation's folder)
      return { already: true, moved: 0, orphans: [] };
    }
  }
  const release = takeLock(root, wait);
  try {
    if (readVersion(root) === LAYOUT_VERSION || (o.movesOnly && readVersion(root) === MOVES_VERSION)) return { already: true, moved: 0, orphans: [] };
    if (readVersion(root) === MOVES_VERSION) { // layout 2 (the files are where they belong): the imports are left
      const r = importAll(L.root, o);
      return { already: false, moved: r.files, orphans: [] };
    }
    if (readVersion(root) === INSTANCE_DB_VERSION) { // layout 3 (instance.db is filled): only the conversations' files are left
      const r = importAll(L.root, o);
      return { already: false, moved: r.files, orphans: [] };
    }
    const fs = o.fs ?? realFs;
    let plan = loadPlan(L.root);
    const resumed = plan !== undefined;
    if (!plan) {
      plan = planMigration(L.root, fs, nowOf(o));
      if (plan.ops.length > 0) savePlan(L.root, plan);
    }
    const log = o.log ?? (() => {});
    if (plan.ops.length > 0) log(`migrate: ${resumed ? "continuing" : "starting"}: ${plan.ops.filter((x) => !x.done).length} of ${plan.ops.length} step(s) to do (instance/migration-plan.json)`);
    const mover = new Mover(L.root, o, plan.backup ?? backupFolder(L.root, nowOf(o)));
    mover.save = () => savePlan(L.root, plan!);
    let done = 0;
    const runAll = (): void => {
      for (const op of plan!.ops) {
        if (op.done) continue;
        mover.run(op);
        delete op.copying;
        op.done = true;
        savePlan(L.root, plan!);
        done++;
        if (o.crashAfter !== undefined && done >= o.crashAfter) throw new Error("simulated crash");
      }
    };
    runAll();
    for (let round = 0; round < 5; round++) {
      // whatever is in the old places NOW (written meanwhile by an old process, or left by a plan resumed after a rollback) is part of this migration too
      const more = planMigration(L.root, fs, nowOf(o)).ops;
      if (more.length === 0) break;
      log(`migrate: ${more.length} more step(s): something was written to the old places meanwhile`);
      plan.ops.push(...more.map((x, i) => ({ ...x, id: plan!.ops.length + i })));
      runAll();
    }
    sweepEmpty(L.root, plan.ops);
    mkdirSync(L.instance.dir, { recursive: true, mode: 0o700 });
    const aside = [...new Set([...plan.ops.filter((x) => x.kind === "orphan").map((x) => relative(L.root, x.from)), ...mover.orphans])];
    if (plan.ops.length > 0) {
      plan.aside = [...new Set([...(plan.aside ?? []), ...aside])];
      plan.completedAt = nowOf(o).toISOString();
      savePlan(L.root, plan);
    }
    writeFileAtomic(L.instance.layoutVersion, `${MOVES_VERSION}\n`); // LAST of the moves: until it exists, the next start continues from the plan
    if (plan.ops.length > 0) {
      const rewrote = plan.ops.some((x) => x.kind === "rekey" || x.kind === "split-sources");
      log(`migrate: data folder is in layout version ${MOVES_VERSION}: ${plan.ops.length} step(s)${aside.length ? `, ${aside.length} set aside in instance/migration-orphans/ (listed above)` : ""}${rewrote ? `; originals of the files it rewrote are kept in ${relative(L.root, plan.backup)}/` : ""}; instance/migration-plan.json lists every move`);
    }
    if (o.movesOnly) return { already: false, moved: done, orphans: aside, plan };
    importAll(L.root, o); // layouts 3 and 4: the small files into instance.db, then each conversation's into its assistant.db
    return { already: false, moved: done, orphans: aside, plan };
  } finally {
    release();
  }
}

/** Layouts 3 and 4: the process-wide files into instance.db (stamp 3), then each conversation's into its own assistant.db (stamp 4, LAST). Either part is skipped when there is nothing in it. */
function importAll(root: string, o: MigrateOptions): { files: number } {
  const L = layout(root);
  const log = o.log ?? (() => {});
  const opts = { ...(o.now ? { now: o.now } : {}), ...(o.log ? { log: o.log } : {}), ...(o.crashAfter !== undefined ? { crashAfter: o.crashAfter } : {}) };
  let files = 0;
  if (readVersion(root) !== INSTANCE_DB_VERSION) {
    const imported = importLegacy(root, opts); // layout 3: the process-wide small files into instance.db
    writeFileAtomic(L.instance.layoutVersion, `${INSTANCE_DB_VERSION}\n`); // (until it exists, the next start continues with this part; a stamp of 2 means it is still left)
    files += imported.files;
    if (imported.files > 0) log(`migrate: ${imported.files} file(s) imported into instance/instance.db (${imported.rows} row(s)); originals kept in ${imported.backup}/`);
  }
  const conv: ConvImportResult = importConvLegacy(root, opts); // layout 4: each conversation's small files into its assistant.db
  mkdirSync(L.instance.dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(L.instance.layoutVersion, `${LAYOUT_VERSION}\n`); // LAST: until it exists, the next start continues (a stamp of 3 means only the conversations' files are left)
  files += conv.files;
  log(`migrate: data folder is in layout version ${LAYOUT_VERSION}${conv.files > 0 ? `: ${conv.files} file(s) imported into ${conv.conversations} conversation database(s) (${conv.rows} row(s)); originals kept in ${conv.backup}/` : ""}`);
  return { files };
}

/**
 * Layout-2 and layout-3 files that appeared in instance/ or in a conversation's folder of a folder that is already in layout 3 (reconcile moved an old version's late files there): imported like the first time. Takes the lock; no-op when
 * there are none. Returns what it imported.
 */
export function importLeftovers(root: string, o: MigrateOptions = {}, wait = 30_000): ImportResult | undefined {
  if (!hasLegacy(root)) return undefined;
  const release = takeLock(root, wait);
  try {
    const opts = { ...(o.now ? { now: o.now } : {}), ...(o.log ? { log: o.log } : {}) };
    const r = importLegacy(layout(root).root, opts);
    if (hasConvLegacyFiles(root)) importConvLegacy(layout(root).root, opts); // (an older process wrote a conversation's file after the move)
    return r;
  } finally {
    release();
  }
}

// ---- after the stamp: a straggler ----

export interface LateResult {
  files: string[]; // old paths (relative) found in the old places after the stamp
}

/** Old paths that exist again in the old places of a stamped folder (an old process still writing), as a plan. Empty when there are none. */
export const stragglers = (root: string, fs: FsView = realFs): Op[] => (readVersion(root) === LAYOUT_VERSION ? planMigration(root, fs).ops : []);

/**
 * A stamped folder where something has appeared in the old places again (an old process was still running, a rollback to old code and forward again): an append-only log is MERGED into its target
 * (identical lines once, in time order), anything else the new layout has already is set aside in instance/migration-orphans/ (a file the new layout lacks is simply moved into place). Each is
 * logged loudly and listed in instance/migration-late.json, from which the owner is told once. Never stops the agent.
 */
export function reconcile(root: string, o: MigrateOptions = {}, wait = 30_000): LateResult {
  const L = layout(root);
  const files: string[] = [];
  if (stragglers(root, o.fs).length === 0) return { files };
  const release = takeLock(root, wait);
  try {
    const log = o.log ?? (() => {});
    const ops = stragglers(root, o.fs);
    if (ops.length === 0) return { files };
    const mover = new Mover(L.root, { ...o, late: true }, backupFolder(L.root, nowOf(o)));
    log(`migrate: LATE FILES: ${ops.length} path(s) in the old places of a migrated folder (an old version is still writing?): merging or setting them aside`);
    for (const op of ops) {
      const before = mover.orphans.length + mover.merged.length;
      try {
        mover.run(op);
      } catch (e) {
        log(`migrate: late file ${relative(L.root, op.from)} could not be handled (${(e as Error).message}); left where it is`);
        continue;
      }
      files.push(relative(L.root, op.from));
      log(`migrate: late file ${relative(L.root, op.from)} ${mover.orphans.length + mover.merged.length > before ? "handled (merged or set aside, see above)" : `moved to ${relative(L.root, op.to)}`}`);
    }
    sweepEmpty(L.root, ops);
    let prior: { files: string[]; lost?: string[]; told?: boolean } = { files: [] };
    try { prior = JSON.parse(readFileSync(L.instance.migrationLate, "utf8")); } catch { /* the first time */ }
    writeFileAtomic(L.instance.migrationLate, JSON.stringify({ files: [...new Set([...(prior.told ? [] : prior.files), ...files])], lost: prior.told ? [] : (prior.lost ?? []) }));
    return { files };
  } finally {
    release();
  }
}

// ---- telling the owner once ----

export const REORGANISED_TEXT = "I reorganised how I store my data on this Mac: one folder per conversation now, instead of files sorted by kind. Nothing was lost and there is nothing for you to do.";
const asideText = (paths: readonly string[]): string => `I reorganised how I store my data on this Mac: one folder per conversation now, instead of files sorted by kind. ${paths.length} item(s) I could not place were set aside, not deleted, in the migration-orphans folder inside my instance folder: ${paths.slice(0, 8).join(", ")}${paths.length > 8 ? ", ..." : ""}. Everything else moved as it was.`;
/** The one-time notice for the owner's chat (undefined when there is nothing to tell, or she has been told). Marking it told is separate: call `markOwnerTold` once it is sent. */
export function ownerNotice(root: string): string | undefined {
  const plan = loadPlan(root);
  if (!plan || plan.ops.length === 0 || plan.ownerTold || readVersion(root) !== LAYOUT_VERSION) return undefined;
  return plan.aside?.length ? asideText(plan.aside) : REORGANISED_TEXT;
}
export function markOwnerTold(root: string): void {
  const plan = loadPlan(root);
  if (plan && !plan.ownerTold) savePlan(root, { ...plan, ownerTold: true });
}
/** Files an old version wrote after the move (reconcile), told once. */
export function lateNotice(root: string): string | undefined {
  try {
    const l = JSON.parse(readFileSync(layout(root).instance.migrationLate, "utf8")) as { files?: string[]; lost?: string[]; told?: boolean };
    if (l.told || (!l.files?.length && !l.lost?.length)) return undefined;
    const lost = l.lost?.length ? ` Some approvals an older version of me had parked could not be restored, because the new storage already held an approval list; they are not run, and you can ask me again: ${l.lost.slice(0, 8).join("; ")}${l.lost.length > 8 ? "; ..." : ""}.` : "";
    const files = l.files?.length ? `An older version of me was still writing to the old storage places after they were moved. I merged the logs and put the rest in the migration-orphans folder inside my instance folder (or moved it into place where nothing was there): ${l.files.slice(0, 8).join(", ")}${l.files.length > 8 ? ", ..." : ""}. Nothing was deleted.` : "An older version of me was still writing to its old storage after the move.";
    return files + lost;
  } catch {
    return undefined;
  }
}
export function markLateTold(root: string): void {
  try {
    const p = layout(root).instance.migrationLate;
    const l = JSON.parse(readFileSync(p, "utf8")) as { files?: string[] };
    writeFileAtomic(p, JSON.stringify({ ...l, told: true }));
  } catch { /* none */ }
}
