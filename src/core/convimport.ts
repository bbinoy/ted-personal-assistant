import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { convDbAt } from "./convdb.ts";
import { isConvId, layout, layout3, type ConvId } from "./convpaths.ts";
import type { Db } from "./db.ts";
import { writeFileAtomic } from "./state.ts";

// Layout version 4: the small per-conversation files of layout 3 are imported into the conversation's own assistant.db, once (docs/ARCHITECTURE.md "assistant.db"; the tables: core/convdb.ts).
//
//   file (in conversations/<convId>/)       becomes
//   session.json                            the `session` row
//   dream.json                              the `dream` row
//   held-posts.json                         the `hold` row and `held_posts` rows (newest 30)
//   seen-mail.json                          `seen_mail` rows, oldest first (newest 2000)
//   quiet.json                              the `quiet` row (an empty file is "until /unquiet": a row with '')
//   pending.json                            `pending_state`, `pending_items`, `pending_expired`, `pending_blocked`
//   voices/sources.json                     `voice_notes` (newest 50) and `voice_quotes` (newest 100)
//   meta.json (a FRIEND's only)             the `friend` row and `friend_notices` rows; a group's meta.json stays a file (its id and name: core/convpaths.ts ConvPaths.meta)
//
// Properties (each tested, test/convimport.test.ts), the same as the instance import's (core/dbimport.ts):
//   * one transaction per file, in the conversation's OWN database: the rows and the note in legacy_imports (name, sha256, rows) commit together or not at all; the row count is checked against
//     the file's before it commits;
//   * the original is COPIED to instance/migration-backup/<time>/conversations/<convId>/<its name> before anything is written, and removed only after the commit: a crash at any point leaves it
//     where it was or in the backup, never nowhere; a second run finds the note (same name AND same bytes) and only removes the leftover original: nothing is imported twice;
//   * a file that does not parse is backed up and noted with 0 rows (the old code moved such a file aside and went on with defaults);
//   * LATE files (an older process wrote one after the move; reconcile and the leftovers sweep bring it here): what the database holds wins for the one-record stores (session, dream, /quiet, a friend's
//     bookkeeping, a non-empty approval inbox), which are backed up and noted with 0 rows; the lists (seen mail, held posts, voice notes) are MERGED (an id or text already there is not repeated).
//   * a `.corrupt-<time>` copy of one of these files that readJson once set aside stays where it is (a human's), it is not imported.

export const CONV_FILES = ["session", "dream", "heldPosts", "seenMail", "quiet", "pending", "voiceSources", "friendMeta"] as const;
export type ConvFileKind = (typeof CONV_FILES)[number];

export interface ConvImportItem {
  name: string; // relative to the data folder, for messages and the note
  path: string;
  conv: ConvId;
  kind: ConvFileKind;
  target: string; // the table(s), for the dry run
}

const TARGET: Record<ConvFileKind, string> = {
  session: "session",
  dream: "dream",
  heldPosts: "hold, held_posts",
  seenMail: "seen_mail",
  quiet: "quiet",
  pending: "pending_*",
  voiceSources: "voice_notes, voice_quotes",
  friendMeta: "friend, friend_notices",
};

const exists = (p: string): boolean => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};
const listDir = (d: string): string[] => {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
};
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/**
 * The layout-3 files to import, conversation by conversation (the owner first). `willExist`: paths a move will create; `folderMoves`: conversation folders a move will rename into place
 * (their files are listed from the folder they come from): both for the dry run, which lists what the whole migration will do.
 */
export function convImportItems(root: string, willExist: readonly string[] = [], folderMoves: readonly { from: string; to: string }[] = []): ConvImportItem[] {
  const L = layout(root);
  const L3 = layout3(root);
  const convs = new Set<ConvId>();
  for (const n of listDir(L.conversations)) if (isConvId(n)) convs.add(n);
  for (const p of willExist) {
    const first = relative(L.conversations, p).split("/")[0] ?? "";
    if (isConvId(first) && !p.startsWith("..")) convs.add(first);
  }
  const out: ConvImportItem[] = [];
  for (const conv of [...convs].sort((a, b) => (a === "owner" ? -1 : b === "owner" ? 1 : a < b ? -1 : 1))) {
    const files = L3.conv(conv);
    const moved = folderMoves.find((m) => m.to === L.conv(conv).dir);
    for (const kind of CONV_FILES) {
      if (kind === "friendMeta" && !conv.startsWith("friend-")) continue; // (a group's meta.json is its identity and stays a file)
      const path = files[kind];
      const old = moved ? join(moved.from, relative(L.conv(conv).dir, path)) : undefined;
      if (exists(path) || willExist.includes(path) || (old !== undefined && exists(old))) out.push({ name: relative(L.root, path), path, conv, kind, target: TARGET[kind] });
    }
  }
  return out;
}

/** Pure on the files: the dry run's lines. */
export function describeConvImport(root: string, willExist: readonly string[] = [], folderMoves: readonly { from: string; to: string }[] = []): string[] {
  const items = convImportItems(root, willExist, folderMoves);
  if (items.length === 0) return [];
  return [
    ...items.map((i) => `import   ${i.name}  ->  conversations/${i.conv}/assistant.db (${i.target})   (original kept in instance/migration-backup/, then removed)`),
    `${items.length} file(s) to import into ${new Set(items.map((i) => i.conv)).size} conversation database(s).`,
  ];
}

export const hasConvLegacyFiles = (root: string): boolean => convImportItems(root).length > 0;

// ---- the readers: a file's text -> rows ----

interface Counted {
  rows: number; // rows written
  expect: number; // rows the file should have produced (the check before the commit)
  note?: string;
  lost?: { n: number; label: string }[]; // approvals of a late pending.json that were NOT restored: surfaced to the owner and the doctor (pending_lost)
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const flag = (v: unknown): number | null => (typeof v === "boolean" ? (v ? 1 : 0) : null);
const present = (db: Db, table: string): boolean => db.num(`SELECT COUNT(*) FROM ${table}`) > 0;
const kept = (what: string, lost?: Counted["lost"]): Counted => ({ ...(lost?.length ? { lost } : {}), rows: 0, expect: 0, note: `the database already holds ${what}; the file is only backed up` });

// (the bounds the stores keep: modules/seenmail SEEN_MAX, heartbeat/notices MAX_HELD, modules/voice/voicenote NOTES_PER_CONVERSATION, approvals/pending MAX_BLOCKED; spelled as numbers here so the importer needs none of them)
const SEEN_MAX = 2000;
const MAX_HELD = 30;
const NOTES_MAX = 50;
const QUOTES_MAX = 100;
const BLOCKED_MAX = 100;

function importFile(db: Db, it: ConvImportItem, text: string): Counted {
  const bad = (): Counted => ({ rows: 0, expect: 0, note: "does not parse; backed up only" });
  if (it.kind === "quiet") {
    if (present(db, "quiet")) return kept("a /quiet switch");
    db.run("INSERT INTO quiet (id, until) VALUES (1, ?)", text); // (the text as it was: "" = until /unquiet)
    return { rows: 1, expect: 1 };
  }
  const j = parseJson(text);
  if (!isObj(j)) return bad();
  switch (it.kind) {
    case "session": {
      if (present(db, "session")) return kept("a session record");
      db.run(
        "INSERT INTO session (id, session_id, cost_usd, last_turn_at, last_context_tokens, compact_failed_at, base_tokens, seen_at, untrusted_in) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)",
        str(j.sessionId), int(j.costUsd) ?? 0, str(j.lastTurnAt), int(j.lastContextTokens), str(j.compactFailedAt), int(j.baseTokens), str(j.seenAt), str(j.untrustedIn),
      );
      return { rows: 1, expect: 1 };
    }
    case "dream": {
      if (present(db, "dream")) return kept("the dream's day");
      db.run("INSERT INTO dream (id, day, last_run_at) VALUES (1, ?, ?)", str(j.day), str(j.lastRunAt));
      return { rows: 1, expect: 1 };
    }
    case "heldPosts": {
      const late = db.get("SELECT 1 FROM legacy_imports WHERE name = ?", it.name) !== undefined; // an earlier import of this name: this is a late file, and only then is a post that is held already not repeated
      const held = (Array.isArray(j.held) ? j.held : []).filter((h): h is Record<string, unknown> => isObj(h) && typeof h.text === "string").slice(-MAX_HELD);
      let rows = 0;
      let expect = held.length;
      if (!present(db, "hold") && typeof j.day === "string") {
        db.run("INSERT INTO hold (id, day, posted) VALUES (1, ?, ?)", j.day, int(j.posted) ?? 0);
        rows++;
        expect++;
      }
      for (const h of held) {
        if (late && db.get("SELECT 1 FROM held_posts WHERE text = ?", h.text as string)) { expect--; continue; } // (a late file: not repeated)
        db.run("INSERT INTO held_posts (text, why, at) VALUES (?, ?, ?)", h.text as string, h.why === "cap" ? "cap" : "quiet", int(h.at));
        rows++;
      }
      return { rows, expect };
    }
    case "seenMail": {
      const ids = [...new Set((Array.isArray(j.ids) ? j.ids : []).filter((x): x is string => typeof x === "string").reverse())].reverse().slice(-SEEN_MAX); // (distinct, the last occurrence counts, newest 2000)
      let rows = 0;
      let expect = ids.length;
      for (const id of ids) {
        if (db.get("SELECT 1 FROM seen_mail WHERE id = ?", id)) { expect--; continue; }
        db.run("INSERT INTO seen_mail (id) VALUES (?)", id);
        rows++;
      }
      return { rows, expect };
    }
    case "pending": {
      const seen = new Set<number>();
      const items = (Array.isArray(j.items) ? j.items : []).filter((p): p is Record<string, unknown> => {
        if (!isObj(p) || typeof p.n !== "number" || typeof p.tool !== "string" || !isObj(p.input) || seen.has(p.n)) return false;
        seen.add(p.n);
        return true;
      });
      if (present(db, "pending_items") || (db.get<{ next: number }>("SELECT next FROM pending_state WHERE id = 1")?.next ?? 1) > 1) {
        const lost = items.map((p) => ({ n: p.n as number, label: (str(p.label) ?? "").slice(0, 120) }));
        for (const l of lost) db.run("INSERT INTO pending_lost (n, label, why, at) VALUES (?, ?, 'late-file', ?)", l.n, l.label, new Date().toISOString());
        return kept("an approval inbox", lost);
      }
      const expired = (Array.isArray(j.expired) ? j.expired : []).filter((d): d is Record<string, unknown> => isObj(d) && typeof d.n === "number");
      const blocked = (Array.isArray(j.blocked) ? j.blocked : []).filter((b): b is Record<string, unknown> => isObj(b) && typeof b.key === "string" && typeof b.until === "number");
      db.run("INSERT INTO pending_state (id, next) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET next = excluded.next", typeof j.next === "number" && j.next >= 1 ? j.next : 1);
      let rows = 1;
      for (const p of items) {
        const exec = isObj(p.executing) ? int(p.executing.at) : null;
        const retry = isObj(p.retry) ? (p.retry.told ? 1 : 0) : null;
        const sent = isObj(p.sent) ? p.sent : undefined;
        db.run(
          "INSERT INTO pending_items (n, tool, input, label, question, footer, scope, source, created_at, urgent, details_hash, deferred, executing_at, retry_told, interrupted, sent_at, sent_ts, sent_held) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          p.n as number, p.tool as string, JSON.stringify(p.input), str(p.label) ?? "", str(p.question) ?? "", str(p.footer) ?? "", str(p.scope) ?? "", str(p.source) ?? "", int(p.createdAt) ?? 0,
          flag(p.urgent), str(p.detailsHash), p.deferred ? 1 : null, exec, retry, p.interrupted ? 1 : null, int(sent?.at), int(sent?.ts), sent?.held ? 1 : null,
        );
        rows++;
      }
      for (const d of expired) {
        db.run("INSERT INTO pending_expired (n, label) VALUES (?, ?)", d.n as number, str(d.label) ?? "");
        rows++;
      }
      for (const b of blocked.slice(-BLOCKED_MAX)) {
        db.run("INSERT INTO pending_blocked (key, n, at, until, kind) VALUES (?, ?, ?, ?, ?)", b.key as string, int(b.n) ?? 0, int(b.at) ?? 0, b.until as number, b.kind === "done" ? "done" : "expired");
        rows++;
      }
      return { rows, expect: 1 + items.length + expired.length + Math.min(blocked.length, BLOCKED_MAX) };
    }
    case "voiceSources": {
      const byTs = new Map<number, Record<string, unknown>>(); // distinct, the last occurrence of a timestamp counts
      for (const n of Array.isArray(j.notes) ? j.notes : []) {
        if (!isObj(n) || int(n.ts) === null || typeof n.id !== "string") continue;
        byTs.delete(n.ts as number);
        byTs.set(n.ts as number, n);
      }
      const notes = [...byTs.values()].slice(-NOTES_MAX);
      let rows = 0;
      let expect = notes.length;
      for (const n of notes) {
        if (db.get("SELECT 1 FROM voice_notes WHERE ts = ?", n.ts as number)) { expect--; continue; }
        db.run(
          "INSERT INTO voice_notes (ts, id, size, by, by_name, snippet, kind, name, seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          n.ts as number, n.id as string, int(n.size) ?? 0, str(n.by) ?? "", str(n.byName), str(n.snippet) ?? "", n.kind === "file" ? "file" : n.kind === "voice" ? "voice" : null, str(n.name), int(n.seconds),
        );
        rows++;
      }
      const quotes = isObj(j.quotes) ? Object.entries(j.quotes).filter(([k, v]) => /^\d+$/.test(k) && int(v) !== null).slice(-QUOTES_MAX) : [];
      expect += quotes.length;
      for (const [k, v] of quotes) {
        if (db.get("SELECT 1 FROM voice_quotes WHERE message_ts = ?", Number(k))) { expect--; continue; }
        db.run("INSERT INTO voice_quotes (message_ts, quoted_ts) VALUES (?, ?)", Number(k), v as number);
        rows++;
      }
      return { rows, expect };
    }
    case "friendMeta": {
      let rows = 0;
      let expect = 0;
      const disclosed = str(j.disclosedAt);
      const paused = int(j.pausedUntil);
      if (disclosed !== null || paused !== null) {
        expect++;
        if (present(db, "friend")) { expect--; } // (a late file: the database's record stays)
        else {
          db.run("INSERT INTO friend (id, paused_until, disclosed_at) VALUES (1, ?, ?)", paused, disclosed);
          rows++;
        }
      }
      if (isObj(j.noticeAt)) {
        for (const [kind, at] of Object.entries(j.noticeAt)) {
          if (typeof at !== "string") continue;
          expect++;
          if (db.get("SELECT 1 FROM friend_notices WHERE kind = ?", kind)) { expect--; continue; }
          db.run("INSERT INTO friend_notices (kind, at) VALUES (?, ?)", kind, at);
          rows++;
        }
      }
      return { rows, expect };
    }
    default:
      return bad();
  }
}

export interface ConvImportOptions {
  now?: () => Date;
  log?: (line: string) => void;
  crashAfter?: number; // tests: throw after this many files are done, as a crash would
  crashAfterCommit?: number; // tests: throw right after this many commits, before the original is removed
  backupDir?: string; // default: instance/migration-backup/<time>/
}
export interface ConvImportResult {
  files: number; // imported in this run
  skipped: number; // already imported (same name and bytes): only the leftover original removed
  rows: number;
  conversations: number; // databases written to
  backup?: string;
}

/**
 * Imports every layout-3 file that is still in a conversation's folder. Idempotent and resumable (see the header). The caller holds the migration lock.
 * Each conversation's database is opened here (core/convdb.ts); nothing is imported into another conversation's.
 */
export function importConvLegacy(root: string, o: ConvImportOptions = {}): ConvImportResult {
  const items = convImportItems(root);
  const res: ConvImportResult = { files: 0, skipped: 0, rows: 0, conversations: 0 };
  if (items.length === 0) return res;
  const L = layout(root);
  const log = o.log ?? (() => {});
  const now = (o.now ?? (() => new Date()))();
  const backup = o.backupDir ?? join(L.instance.migrationBackup, now.toISOString().replace(/[:.]/g, "-"));
  const touched = new Set<ConvId>();
  const lostLines: string[] = [];
  for (const it of items) {
    const db = convDbAt(L.root, it.conv);
    const bytes = readFileSync(it.path);
    const hash = sha(bytes);
    const done = db.get<{ rows: number }>("SELECT rows FROM legacy_imports WHERE name = ? AND sha256 = ?", it.name, hash);
    const keep = join(backup, it.name);
    mkdirSync(dirname(keep), { recursive: true, mode: 0o700 });
    copyFileSync(it.path, keep); // FIRST: the original is safe before anything else happens
    if (done) {
      rmSync(it.path, { force: true }); // (a crash between the commit and this removal)
      res.skipped++;
      log(`migrate: ${it.name} was imported already (${done.rows} row(s)); the leftover original is removed (a copy is in ${relative(L.root, backup)}/)`);
      continue;
    }
    const counted = db.tx(
      () => {
        const c = importFile(db, it, bytes.toString("utf8"));
        if (c.rows !== c.expect) throw new Error(`${it.name}: ${c.rows} row(s) written, ${c.expect} expected; nothing was imported from it`); // the check before the commit
        db.run("INSERT INTO legacy_imports (name, sha256, rows, imported_at, backup, note) VALUES (?, ?, ?, ?, ?, ?)", it.name, hash, c.rows, now.toISOString(), relative(L.root, keep), c.note ?? null);
        return c;
      },
      { durable: true },
    );
    if (o.crashAfterCommit !== undefined && res.files + 1 >= o.crashAfterCommit) throw new Error("simulated crash");
    rmSync(it.path, { force: true }); // only after the commit
    res.files++;
    res.rows += counted.rows;
    touched.add(it.conv);
    for (const l of counted.lost ?? []) lostLines.push(`${it.conv === "owner" ? "your chat" : it.conv} #${l.n}${l.label ? ` ${l.label}` : ""}`);
    log(`migrate: ${it.name} -> ${it.conv}/assistant.db: ${counted.rows} row(s)${counted.note ? ` (${counted.note})` : ""}`);
    if (o.crashAfter !== undefined && res.files >= o.crashAfter) throw new Error("simulated crash");
  }
  if (lostLines.length) recordLostApprovals(root, lostLines);
  res.conversations = touched.size;
  res.backup = relative(L.root, backup);
  return res;
}

/**
 * A forgotten conversation (a friend, a group): the import left copies of its files in instance/migration-backup/<time>/conversations/<convId>/ (its session pointer, held posts, approvals, voice notes: her
 * words). They go with her. Returns how many backups held a folder of hers. (Every backup path carries only its own convId: no other conversation's data is in that folder.)
 */
export function forgetConvInBackups(root: string, conv: ConvId): number {
  const L = layout(root);
  let n = 0;
  for (const stamp of listDir(L.instance.migrationBackup)) {
    const own = join(L.instance.migrationBackup, stamp, "conversations", conv);
    if (exists(own)) {
      rmSync(own, { recursive: true, force: true });
      n++;
    }
  }
  return n;
}

/** Approvals of a late pending.json that could not be restored: told to the owner once (migrate.ts lateNotice, from instance/migration-late.json) and listed by the doctor (the pending_lost table). */
function recordLostApprovals(root: string, lines: readonly string[]): void {
  const file = layout(root).instance.migrationLate;
  let prior: { files?: string[]; lost?: string[]; told?: boolean } = {};
  try {
    prior = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* the first time */
  }
  writeFileAtomic(file, JSON.stringify({ files: prior.told ? [] : (prior.files ?? []), lost: [...(prior.told ? [] : (prior.lost ?? [])), ...lines] }));
}
