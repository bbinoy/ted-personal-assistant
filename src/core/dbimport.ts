import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { isConvId, layout, layout2, OWNER_CONV } from "./convpaths.ts";
import type { Db } from "./db.ts";
import { openInstanceDbAt } from "./instancedb.ts";

// Layout version 3: the process-wide files of layout 2 that instance.db replaced are imported into it, once (docs/ARCHITECTURE.md "instance.db"; the tables: core/instancedb.ts).
//
//   file                                   becomes
//   cost.json (owner's day, notifiedDay)   spend rows (login, the owner) + a notices row (budget:owner)
//   group-cost.json                        spend rows (login, each group)
//   key-cost.json                          spend rows (key): the part of the key's day no friend's own file explains
//   conversations/friend-*/cost.json       spend rows (key, that friend)
//   cap-notices.json                       notices rows
//   heartbeat.jsonl, .1, .2                looks rows, oldest generation first
//   heartbeat.json, connectors.json,       kv rows
//     tools-seen.json
//   payments.jsonl + payments-<year>*.jsonl  payments rows, EVERY historical row (the archives first, in year order; a row the current file repeats from an archive once)
//   intake-status.json, intake-problems.json intake rows
//
// Properties (each tested, test/dbimport.test.ts):
//   * one transaction per file: the rows and the note in legacy_imports (name, sha256, rows) commit together or not at all; the row count is checked against the file's before it commits;
//   * the original is COPIED to instance/migration-backup/<time>/<its path> before anything is written, and removed only after the commit: a crash at any point leaves it where it was or
//     in the backup, never nowhere; a second run finds the note (same name AND same bytes) and only removes the leftover original: nothing is imported twice;
//   * a file that does not parse is backed up and noted with 0 rows (the old code moved such a file aside and went on with defaults); a damaged line of a jsonl file is counted, not fatal;
//   * the day totals of cost.json and key-cost.json are split into per-owner/group/friend rows, and the remainder (the part the finer files do not explain) becomes the owner's/an unnamed row, so
//     "owner today" and "key today" read the same as before.

export interface ImportItem {
  name: string; // relative to the data folder, for messages and the note
  path: string;
  kind: "payments" | "looks" | "spend-friend" | "spend-group" | "spend-key" | "spend-owner" | "notices" | "kv" | "intake-status" | "intake-problems";
  target: string; // the table(s), for the dry run
}

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

/** The layout-2 files to import, in the order they are imported (the finer ledgers before the day totals that are split by them). `willExist`: paths a move will create (the dry run). */
export function importItems(root: string, willExist: readonly string[] = []): ImportItem[] {
  const L = layout(root);
  const V2 = layout2(root);
  const has = (p: string) => exists(p) || willExist.includes(p);
  const item = (path: string, kind: ImportItem["kind"], target: string): ImportItem => ({ name: relative(L.root, path), path, kind, target });
  const out: ImportItem[] = [];
  // payments: the archives by year and number, then the live file
  const instNames = new Set([...listDir(L.instance.dir), ...willExist.filter((p) => dirname(p) === L.instance.dir).map((p) => p.slice(L.instance.dir.length + 1))]);
  const archives = [...instNames].filter((n) => V2.paymentArchive.test(n)).map((n) => ({ n, m: /^payments-(\d{4})(?:-(\d+))?\.jsonl$/.exec(n)! })).sort((a, b) => Number(a.m[1]) - Number(b.m[1]) || Number(a.m[2] ?? 1) - Number(b.m[2] ?? 1));
  for (const a of archives) out.push(item(join(L.instance.dir, a.n), "payments", "payments"));
  if (has(V2.payments)) out.push(item(V2.payments, "payments", "payments"));
  // heartbeat rows: .2 (oldest), .1, current
  for (const gen of [`${V2.heartbeatRows}.2`, `${V2.heartbeatRows}.1`, V2.heartbeatRows]) if (has(gen)) out.push(item(gen, "looks", "looks"));
  // spend: friends' days, groups', then the key's and the owner's totals (split by those)
  const convDirs = [...listDir(L.conversations).filter((n) => isConvId(n) && n.startsWith("friend-")), ...willExist.map((p) => relative(L.conversations, p).split("/")[0]!).filter((n) => isConvId(n) && n.startsWith("friend-"))];
  for (const conv of [...new Set(convDirs)].sort()) if (has(V2.friendCost(conv))) out.push(item(V2.friendCost(conv), "spend-friend", "spend"));
  if (has(V2.groupCost)) out.push(item(V2.groupCost, "spend-group", "spend"));
  if (has(V2.keyCost)) out.push(item(V2.keyCost, "spend-key", "spend"));
  if (has(V2.cost)) out.push(item(V2.cost, "spend-owner", "spend, notices"));
  if (has(V2.capNotices)) out.push(item(V2.capNotices, "notices", "notices"));
  for (const [p, key] of [[V2.heartbeat, "heartbeat"], [V2.connectors, "connectors"], [V2.toolsSeen, "tools-seen"]] as const) if (has(p)) out.push(item(p, "kv", `kv:${key}`));
  if (has(V2.intakeStatus)) out.push(item(V2.intakeStatus, "intake-status", "intake"));
  if (has(V2.intakeProblems)) out.push(item(V2.intakeProblems, "intake-problems", "intake"));
  return out;
}

/** Pure on the files: the dry run's lines. */
export function describeImport(root: string, willExist: readonly string[] = []): string[] {
  const items = importItems(root, willExist);
  if (items.length === 0) return [];
  return [...items.map((i) => `import   ${i.name}  ->  instance.db (${i.target.split(":")[0]})   (original kept in instance/migration-backup/, then removed)`), `${items.length} file(s) to import into instance/instance.db.`];
}

export const hasLegacyFiles = (root: string): boolean => importItems(root).length > 0;

// ---- the readers: a file's text -> rows ----

interface Counted {
  rows: number; // rows written
  expect: number; // rows the file should have produced (the check before the commit)
  note?: string;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const dayStr = (v: unknown): string | undefined => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

function spendRow(db: Db, at: number, day: string, conv: string, payer: "login" | "key", kind: string, usd: number): number {
  if (!(usd > 0)) return 0;
  db.run("INSERT INTO spend (at, day, conv, payer, kind, usd) VALUES (?, ?, ?, ?, ?, ?)", at, day, conv, payer, kind, usd);
  return 1;
}
const sumSpend = (db: Db, sql: string, ...p: (string | number)[]): number => db.num(sql, ...p);

function importFile(db: Db, it: ImportItem, text: string, mtime: number): Counted {
  const j = it.kind === "payments" || it.kind === "looks" ? undefined : parseJson(text);
  const bad = (): Counted => ({ rows: 0, expect: 0, note: "does not parse; backed up only" });
  switch (it.kind) {
    case "payments": {
      let valid = 0;
      let dup = 0;
      let rows = 0;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const r = parseJson(line);
        if (!isObj(r) || typeof r.id !== "string" || typeof r.totalMinor !== "number") continue; // a damaged line (the old reader skipped it too)
        valid++;
        const ts = typeof r.ts === "string" ? r.ts : "";
        const status = String(r.status);
        if (db.get("SELECT 1 FROM payments WHERE id = ? AND ts = ? AND status = ? AND total_minor = ?", r.id, ts, status, r.totalMinor)) {
          dup++; // the live file repeats rows an archive has (the rotation kept the open and the recent ones): once
          continue;
        }
        db.run(
          "INSERT INTO payments (id, ts, merchant, total_minor, currency, last4, cart_hash, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          r.id, ts, String(r.merchant ?? ""), r.totalMinor, String(r.currency ?? ""), String(r.last4 ?? ""), String(r.cartHash ?? ""), status,
        );
        rows++;
      }
      return { rows, expect: valid - dup };
    }
    case "looks": {
      let valid = 0;
      let rows = 0;
      for (const line of text.split("\n")) {
        const r = line.trim() ? parseJson(line) : undefined;
        if (!isObj(r) || typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at))) continue;
        valid++;
        db.run(
          "INSERT INTO looks (at, at_ms, kind, night, message, sent, next_check_minutes, cost_usd, tool_calls, archived, delegations, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          r.at, Date.parse(r.at), typeof r.kind === "string" ? r.kind : "owner", r.night ? 1 : 0, r.message ? 1 : 0, typeof r.sent === "number" ? r.sent : null, num(r.nextCheckMinutes), num(r.costUsd), num(r.toolCalls), num(r.archived), num(r.delegations), String(r.outcome ?? "silent"),
        );
        rows++;
      }
      return { rows, expect: valid };
    }
    case "spend-friend": {
      const conv = basename(dirname(it.path)); // the folder's name: friend-<id>
      if (!isObj(j) || !dayStr(j.day)) return bad();
      const n = spendRow(db, mtime, j.day as string, conv, "key", "imported", num(j.usd));
      return { rows: n, expect: num(j.usd) > 0 ? 1 : 0 };
    }
    case "spend-group": {
      if (!isObj(j) || !dayStr(j.day) || !isObj(j.usd)) return bad();
      let rows = 0;
      let expect = 0;
      for (const [k, v] of Object.entries(j.usd)) {
        if (!(num(v) > 0)) continue;
        expect++;
        rows += spendRow(db, mtime, j.day as string, isConvId(k) ? k : "", "login", "imported", num(v)); // (a key that is no convId: the group is unnamed, its dollars still count)
      }
      return { rows, expect };
    }
    case "spend-key": {
      if (!isObj(j) || !dayStr(j.day)) return bad();
      const day = j.day as string;
      const explained = sumSpend(db, "SELECT SUM(usd) FROM spend WHERE payer = 'key' AND day = ?", day); // the friends' own files, imported before
      const rest = Math.round((num(j.usd) - explained) * 1e9) / 1e9;
      const n = rest > 1e-9 ? spendRow(db, mtime, day, "", "key", "imported", rest) : 0;
      return { rows: n, expect: rest > 1e-9 ? 1 : 0 };
    }
    case "spend-owner": {
      if (!isObj(j) || !dayStr(j.day)) return bad();
      const day = j.day as string;
      const explained = sumSpend(db, "SELECT SUM(usd) FROM spend WHERE payer = 'login' AND day = ?", day); // the groups', imported before
      const rest = Math.round((num(j.usd) - explained) * 1e9) / 1e9;
      let rows = rest > 1e-9 ? spendRow(db, mtime, day, OWNER_CONV, "login", "imported", rest) : 0;
      let expect = rest > 1e-9 ? 1 : 0;
      const told = dayStr(j.notifiedDay);
      if (told) {
        db.run("INSERT INTO notices (key, day) VALUES ('budget:owner', ?) ON CONFLICT (key) DO UPDATE SET day = excluded.day", told);
        rows++;
        expect++;
      }
      return { rows, expect };
    }
    case "notices": {
      if (!isObj(j)) return bad();
      let rows = 0;
      let expect = 0;
      const day = dayStr(j.day);
      if (Array.isArray(j.keys) && day) {
        for (const k of j.keys) {
          if (typeof k !== "string") continue;
          expect++;
          rows += db.run("INSERT INTO notices (key, day) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET day = excluded.day", k, day).changes;
        }
      }
      if (isObj(j.at)) {
        for (const [k, t] of Object.entries(j.at)) {
          if (typeof t !== "number" || !Number.isFinite(t)) continue;
          expect++;
          rows += db.run("INSERT INTO notices (key, last_at) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET last_at = excluded.last_at", k, t).changes;
        }
      }
      return { rows, expect };
    }
    case "kv": {
      const key = it.target.split(":")[1]!; // (importItems names the kv row after the table: "kv:heartbeat")
      if (j === undefined) return bad();
      if (key === "tools-seen" && !Array.isArray(j)) return bad();
      if (key !== "tools-seen" && !isObj(j)) return bad();
      db.run("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING", key, JSON.stringify(j), mtime); // (a value the new code already wrote is newer)
      return { rows: 1, expect: 1 };
    }
    case "intake-status": {
      if (!isObj(j)) return bad();
      let rows = 0;
      let expect = 0;
      for (const [tenant, purposes] of Object.entries(j)) {
        if (!isObj(purposes)) continue;
        for (const [purpose, done] of Object.entries(purposes)) {
          if (!isObj(done) || typeof done.at !== "string") continue;
          expect++;
          rows += db.run(
            "INSERT INTO intake (tenant, purpose, done_at, stored) VALUES (?, ?, ?, ?) ON CONFLICT (tenant, purpose) DO UPDATE SET done_at = excluded.done_at, stored = excluded.stored",
            tenant, purpose, done.at, JSON.stringify(Array.isArray(done.stored) ? done.stored : []),
          ).changes;
        }
      }
      return { rows, expect };
    }
    case "intake-problems": {
      if (!isObj(j)) return bad();
      let rows = 0;
      let expect = 0;
      for (const [tenant, purposes] of Object.entries(j)) {
        if (!isObj(purposes)) continue;
        for (const [purpose, at] of Object.entries(purposes)) {
          if (typeof at !== "string") continue;
          expect++;
          rows += db.run("INSERT INTO intake (tenant, purpose, problem_at) VALUES (?, ?, ?) ON CONFLICT (tenant, purpose) DO UPDATE SET problem_at = excluded.problem_at", tenant, purpose, at).changes;
        }
      }
      return { rows, expect };
    }
  }
}

export interface ImportOptions {
  now?: () => Date;
  log?: (line: string) => void;
  crashAfter?: number; // tests: throw after this many files are done, as a crash would
  crashAfterCommit?: number; // tests: throw right after this many commits, before the original is removed
  backupDir?: string; // default: instance/migration-backup/<time>/
}
export interface ImportResult {
  files: number; // imported in this run
  skipped: number; // already imported (same name and bytes): only the leftover original removed
  rows: number;
  backup?: string;
}

/**
 * Imports every layout-2 file that is still in instance/ (and the friends' cost files). Idempotent and resumable (see the header). The caller holds the migration lock.
 * The database is opened here (core/instancedb.ts); a damaged one throws LedgerCorruptError and nothing is imported or removed.
 */
export function importLegacy(root: string, o: ImportOptions = {}): ImportResult {
  const items = importItems(root);
  const res: ImportResult = { files: 0, skipped: 0, rows: 0 };
  if (items.length === 0) return res;
  const L = layout(root);
  const log = o.log ?? (() => {});
  const now = (o.now ?? (() => new Date()))();
  const backup = o.backupDir ?? join(L.instance.migrationBackup, now.toISOString().replace(/[:.]/g, "-"));
  const db = openInstanceDbAt(L.instance.db);
  for (const it of items) {
    const bytes = readFileSync(it.path);
    const hash = sha(bytes);
    const mtime = statSync(it.path).mtimeMs;
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
        const c = importFile(db, it, bytes.toString("utf8"), mtime);
        if (c.rows !== c.expect) throw new Error(`${it.name}: ${c.rows} row(s) written, ${c.expect} expected; nothing was imported from it`); // the check before the commit
        db.run("INSERT INTO legacy_imports (name, sha256, rows, imported_at, backup) VALUES (?, ?, ?, ?, ?)", it.name, hash, c.rows, now.toISOString(), relative(L.root, keep));
        return c;
      },
      { durable: true },
    );
    if (o.crashAfterCommit !== undefined && res.files + 1 >= o.crashAfterCommit) throw new Error("simulated crash");
    rmSync(it.path, { force: true }); // only after the commit
    res.files++;
    res.rows += counted.rows;
    log(`migrate: ${it.name} -> instance.db: ${counted.rows} row(s)${counted.note ? ` (${counted.note})` : ""}`);
    if (o.crashAfter !== undefined && res.files >= o.crashAfter) throw new Error("simulated crash");
  }
  res.backup = relative(L.root, backup);
  return res;
}
