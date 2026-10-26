import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "../src/core/paths.ts";
import { friendConvId, groupConvId, INSTANCE_DB_VERSION, layout, layout3, LAYOUT_VERSION, MOVES_VERSION } from "../src/core/convpaths.ts";
import { closeAllConvDbs, convDbAt } from "../src/core/convdb.ts";
import { closeInstanceDb } from "../src/core/instancedb.ts";
import { convImportItems, describeConvImport, forgetConvInBackups, hasConvLegacyFiles, importConvLegacy } from "../src/core/convimport.ts";
import { lateNotice, migrate, readVersion, stragglers } from "../src/core/migrate.ts";
import { migrateSafely } from "../src/core/migrateservices.ts";
import { buildOld, GID_A, FRIENDS } from "./oldlayout.ts";

// Layout 4: each conversation's small files are imported into its own assistant.db once (core/convimport.ts), with a backup, and removed.

const GA = groupConvId("import-group-a");
const FA = friendConvId("anna-1a2b");
const pendingItem = (n: number, tool = "mcp__mail__send") => ({ n, tool, input: { to: `a${n}@example.com` }, label: `L${n}`, question: "q?", footer: "f", scope: "tenant:anna-1a2b", source: "background", createdAt: 1000 + n });

/** A data folder in layout 3: the files of every conversation in their folders, instance.db imported already (stamp 3). */
function layout3Folder(): string {
  const root = mkdtempSync(join(tmpdir(), "convimport-"));
  const put = (rel: string, text: string) => (mkdirSync(dirname(join(root, rel)), { recursive: true }), writeFileSync(join(root, rel), text));
  put("instance/layout-version", `${INSTANCE_DB_VERSION}\n`);
  put("instance/tenants.json", '{"tenants":[{"id":"anna-1a2b"},{"id":"bo-3c4d"}]}');
  // the owner
  put("conversations/owner/session.json", JSON.stringify({ sessionId: "owner-s", costUsd: 1.5, lastTurnAt: "2026-10-20T10:00:00.000Z", lastContextTokens: 1234, baseTokens: 100, seenAt: "x", untrustedIn: "owner-s", compactFailedAt: "2026-10-19T00:00:00.000Z" }));
  put("conversations/owner/dream.json", JSON.stringify({ day: "2026-10-19", lastRunAt: "2026-10-19T21:00:00.000Z" }));
  put("conversations/owner/held-posts.json", JSON.stringify({ day: "2026-10-20", posted: 3, held: [{ text: "p1", why: "quiet", at: 5, day: "2026-10-20" }, { text: "p2", why: "cap", notice: true, needsYou: true, sameDay: true }, { nope: 1 }] }));
  put("conversations/owner/seen-mail.json", JSON.stringify({ ids: ["m1", "m2", "m3", "m2", 7] }));
  put("conversations/owner/quiet.json", "");
  put("conversations/owner/pending.json", JSON.stringify({
    next: 5,
    items: [pendingItem(1), { ...pendingItem(2), executing: { at: 50 }, urgent: true, detailsHash: "h", sent: { at: 9, ts: 99, held: true } }, { ...pendingItem(3), retry: { told: true }, deferred: true }, { ...pendingItem(3), tool: "dup-number" }, { bad: true }],
    expired: [{ n: 4, label: "old" }],
    blocked: [{ key: "k1", n: 4, at: 1, until: 2, kind: "done" }, { key: "k2", n: 5, at: 1, until: 3, kind: "expired" }],
  }));
  put("conversations/owner/voices/sources.json", JSON.stringify({ notes: [{ ts: 1, id: "o1.aac", size: 5, by: "+1", byName: "Me", snippet: "hi" }, { ts: 2, id: "o2.mp3", size: 6, by: "+1", snippet: "s", kind: "file", name: "n.mp3", seconds: 4.5 }], quotes: { "10": 1, "11": 2, "x": 3 } }));
  // a friend: bookkeeping too
  put(`conversations/${FA}/session.json`, JSON.stringify({ sessionId: "anna-s", costUsd: 0 }));
  put(`conversations/${FA}/meta.json`, JSON.stringify({ disclosedAt: "2026-10-01T00:00:00.000Z", pausedUntil: 4_000_000_000_000, noticeAt: { cooldown: "2026-10-02T00:00:00.000Z", setup: "2026-10-03T00:00:00.000Z" } }));
  put(`conversations/${FA}/tenant.json`, '{"language":"de"}');
  put(`conversations/${FA}/pending.json`, JSON.stringify({ next: 3, items: [pendingItem(2)], expired: [], blocked: [] }));
  // a group: meta.json stays a file
  put(`conversations/${GA}/meta.json`, JSON.stringify({ id: "import-group-a", name: "Alpha" }));
  put(`conversations/${GA}/session.json`, JSON.stringify({ sessionId: "ga-s", costUsd: 2 }));
  put(`conversations/${GA}/quiet.json`, "2099-01-01T00:00:00.000Z");
  // a second friend with nothing but a damaged file
  put(`conversations/${friendConvId("bo-3c4d")}/session.json`, "{torn");
  return root;
}
const fileNames = ["session.json", "dream.json", "held-posts.json", "seen-mail.json", "quiet.json", "pending.json", "voices/sources.json"];
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x ?? null)); // (rows come with a null prototype)
const oneRow = <T>(root: string, conv: string, sql: string): T | undefined => plain(convDbAt(root, conv).get<T>(sql));

test("the plan: every layout-3 file that is there, the owner first, a friend's meta.json but never a group's; the dry run lists them", () => {
  const root = layout3Folder();
  const items = convImportItems(root).map((i) => i.name);
  assert.deepEqual(items.slice(0, 7), fileNames.map((f) => `conversations/owner/${f}`));
  assert.ok(items.includes(`conversations/${FA}/meta.json`));
  assert.ok(!items.includes(`conversations/${GA}/meta.json`), "a group's meta.json is its identity and stays a file");
  assert.equal(items.length, 7 + 3 + 2 + 1);
  const lines = describeConvImport(root);
  assert.match(lines.at(-1)!, /13 file\(s\) to import into 4 conversation database\(s\)/);
  assert.match(lines[0]!, /import\s+conversations\/owner\/session\.json\s+->\s+conversations\/owner\/assistant\.db \(session\)/);
  assert.equal(hasConvLegacyFiles(root), true);
  assert.deepEqual(describeConvImport(mkdtempSync(join(tmpdir(), "convimport-empty-"))), []);
});

test("migrate from layout 3: every file imported in one transaction, counts verified, originals copied to migration-backup/<time>/conversations/<id>/ and removed, version 4 last", () => {
  const root = layout3Folder();
  const L = layout(root);
  const log: string[] = [];
  const r = migrate(root, { log: (l) => log.push(l), now: () => new Date("2026-10-21T08:00:00.000Z") });
  assert.equal(r.already, false);
  assert.equal(readVersion(root), LAYOUT_VERSION);
  assert.equal(hasConvLegacyFiles(root), false);
  for (const f of fileNames) assert.equal(existsSync(join(L.conv("owner").dir, f)), false, `${f} was removed`);
  assert.equal(existsSync(layout3(root).conv(FA).friendMeta), false);
  assert.equal(existsSync(L.conv(GA).meta), true, "a group's meta.json stays");
  assert.equal(readFileSync(L.conv(FA).tenantJson, "utf8"), '{"language":"de"}', "hand-edited overrides stay");
  const backup = join(L.instance.migrationBackup, "2026-10-21T08-00-00-000Z", "conversations");
  assert.equal(JSON.parse(readFileSync(join(backup, "owner", "session.json"), "utf8")).sessionId, "owner-s", "byte-identical copies of the originals");
  assert.equal(readFileSync(join(backup, "owner", "quiet.json"), "utf8"), "");
  assert.equal(readFileSync(join(backup, "friend-bo-3c4d", "session.json"), "utf8"), "{torn", "a file that does not parse is backed up too");
  assert.ok(log.some((l) => /13 file\(s\) imported into 4 conversation database/.test(l)));
  // the owner's rows
  assert.deepEqual(oneRow(root, "owner", "SELECT session_id, cost_usd, last_turn_at, last_context_tokens, base_tokens, seen_at, untrusted_in, compact_failed_at FROM session"), {
    session_id: "owner-s", cost_usd: 1.5, last_turn_at: "2026-10-20T10:00:00.000Z", last_context_tokens: 1234, base_tokens: 100, seen_at: "x", untrusted_in: "owner-s", compact_failed_at: "2026-10-19T00:00:00.000Z",
  });
  assert.deepEqual(oneRow(root, "owner", "SELECT day, last_run_at FROM dream"), { day: "2026-10-19", last_run_at: "2026-10-19T21:00:00.000Z" });
  assert.deepEqual(oneRow(root, "owner", "SELECT day, posted FROM hold"), { day: "2026-10-20", posted: 3 });
  assert.deepEqual(plain(convDbAt(root, "owner").all("SELECT text, why, notice, needs_you, at, day, same_day FROM held_posts ORDER BY seq")), [
    { text: "p1", why: "quiet", notice: null, needs_you: null, at: 5, day: "2026-10-20", same_day: null },
    { text: "p2", why: "cap", notice: 1, needs_you: 1, at: null, day: null, same_day: 1 },
  ]);
  assert.deepEqual(convDbAt(root, "owner").all<{ id: string }>("SELECT id FROM seen_mail ORDER BY seq").map((x) => x.id), ["m1", "m3", "m2"], "distinct, the last occurrence counts, a number is no id");
  assert.deepEqual(oneRow(root, "owner", "SELECT until FROM quiet"), { until: "" });
  const o = convDbAt(root, "owner");
  assert.equal(o.num("SELECT next FROM pending_state"), 5);
  assert.deepEqual(o.all<{ n: number }>("SELECT n FROM pending_items ORDER BY n").map((x) => x.n), [1, 2, 3], "a duplicate number and a record without a tool are not imported");
  assert.deepEqual(plain(o.get("SELECT executing_at, urgent, details_hash, sent_at, sent_ts, sent_held FROM pending_items WHERE n = 2")), { executing_at: 50, urgent: 1, details_hash: "h", sent_at: 9, sent_ts: 99, sent_held: 1 });
  assert.deepEqual(plain(o.get("SELECT retry_told, deferred FROM pending_items WHERE n = 3")), { retry_told: 1, deferred: 1 });
  assert.equal(o.num("SELECT COUNT(*) FROM pending_expired"), 1);
  assert.equal(o.num("SELECT COUNT(*) FROM pending_blocked"), 2);
  assert.equal(o.num("SELECT COUNT(*) FROM voice_notes"), 2);
  assert.deepEqual(plain(o.all("SELECT message_ts, quoted_ts FROM voice_quotes ORDER BY seq")), [{ message_ts: 10, quoted_ts: 1 }, { message_ts: 11, quoted_ts: 2 }]);
  // her bookkeeping, only in her database
  const a = convDbAt(root, FA);
  assert.deepEqual(plain(a.get("SELECT paused_until, disclosed_at FROM friend")), { paused_until: 4_000_000_000_000, disclosed_at: "2026-10-01T00:00:00.000Z" });
  assert.equal(a.num("SELECT COUNT(*) FROM friend_notices"), 2);
  assert.equal(a.num("SELECT COUNT(*) FROM pending_items"), 1);
  assert.equal(o.num("SELECT COUNT(*) FROM friend"), 0, "nothing of hers in the owner's");
  assert.equal(o.num("SELECT COUNT(*) FROM legacy_imports"), 7, "the note of every file is in the database it went to");
  assert.equal(convDbAt(root, GA).get<{ until: string }>("SELECT until FROM quiet")?.until, "2099-01-01T00:00:00.000Z");
  assert.equal(convDbAt(root, friendConvId("bo-3c4d")).get<{ rows: number }>("SELECT rows FROM legacy_imports")?.rows, 0, "0 rows for the damaged file, noted");
  // and a second run finds nothing to do
  assert.equal(migrate(root).already, true);
  closeAllConvDbs();
});

test("a full migration from the old layout (layout 1) ends in layout 4 with the same state in the databases", () => {
  const root = mkdtempSync(join(tmpdir(), "convimport-old-"));
  buildOld(root);
  const r = migrate(root);
  assert.equal(r.already, false);
  assert.equal(readVersion(root), LAYOUT_VERSION);
  assert.equal(hasConvLegacyFiles(root), false);
  assert.equal(oneRow<{ session_id: string }>(root, "owner", "SELECT session_id FROM session")?.session_id, "owner-s");
  assert.equal(oneRow<{ until: string }>(root, "owner", "SELECT until FROM quiet")?.until, "", "the empty quiet.json: until /unquiet");
  assert.deepEqual(convDbAt(root, "owner").all<{ id: string }>("SELECT id FROM seen_mail").map((x) => x.id), ["m1"]);
  assert.equal(convDbAt(root, "owner").num("SELECT next FROM pending_state"), 2);
  assert.deepEqual(convDbAt(root, "owner").all<{ ts: number; id: string }>("SELECT ts, id FROM voice_notes").map((x) => [x.ts, x.id]), [[1, "o.aac"]], "the voice sources the old layout kept in one file are split per conversation, then imported");
  for (const id of FRIENDS) {
    const f = convDbAt(root, friendConvId(id));
    assert.equal(f.get<{ session_id: string }>("SELECT session_id FROM session")?.session_id, `${id}-s`);
    assert.equal(f.get<{ disclosed_at: string }>("SELECT disclosed_at FROM friend")?.disclosed_at, "x");
  }
  assert.equal(convDbAt(root, "owner").num("SELECT COUNT(*) FROM legacy_imports") >= 6, true);
  assert.ok(existsSync(layout(root).conv(groupConvId(GID_A)).meta));
  closeAllConvDbs();
  closeInstanceDb();
});

/** Every row of every conversation database except the import notes (their time differs between runs): what two runs must agree on. */
function dump(root: string): Record<string, Record<string, unknown[]>> {
  const out: Record<string, Record<string, unknown[]>> = {};
  for (const conv of readdirSync(layout(root).conversations)) {
    if (!existsSync(layout(root).conv(conv).db)) continue;
    const db = convDbAt(root, conv);
    out[conv] = {};
    for (const { name } of db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'legacy_imports' ORDER BY name")) out[conv]![name] = plain(db.all(`SELECT * FROM ${name} ORDER BY 1`));
  }
  return out;
}

test("the stamps: a crash between the two imports leaves layout 3, and the next start does only the conversations' part", async () => {
  const { importItems } = await import("../src/core/dbimport.ts");
  const root = mkdtempSync(join(tmpdir(), "convimport-stamps-"));
  buildOld(root);
  const clean = mkdtempSync(join(tmpdir(), "convimport-stamps-clean-"));
  buildOld(clean);
  migrate(clean);
  migrate(root, { movesOnly: true });
  assert.equal(readVersion(root), MOVES_VERSION);
  const nInstance = importItems(root).length;
  assert.throws(() => migrate(root, { crashAfter: nInstance + 3 }), /simulated crash/); // the instance part finished and stamped 3, three conversation files were imported
  assert.equal(readVersion(root), INSTANCE_DB_VERSION);
  assert.equal(hasConvLegacyFiles(root), true);
  const log: string[] = [];
  migrate(root, { log: (l) => log.push(l) });
  assert.equal(readVersion(root), LAYOUT_VERSION);
  assert.ok(!log.some((l) => /instance\.db:/.test(l)), "the instance part is not done again");
  closeAllConvDbs();
  assert.deepEqual(dump(root), dump(clean), "the same state as a run that was never interrupted");
  closeAllConvDbs();
  closeInstanceDb();
});

test("a crash at any point is continued: after the k-th file, or after a commit before the original is removed; nothing is imported twice or lost", () => {
  const reference = layout3Folder();
  importConvLegacy(reference);
  const want = dump(reference);
  closeAllConvDbs();
  const total = convImportItems(layout3Folder()).length;
  for (const mode of ["crashAfter", "crashAfterCommit"] as const) {
    for (let k = 1; k < total; k++) {
      const root = layout3Folder();
      assert.throws(() => importConvLegacy(root, { [mode]: k }), /simulated crash/, `${mode} ${k}`);
      closeAllConvDbs();
      importConvLegacy(root); // the resume
      assert.equal(hasConvLegacyFiles(root), false, `${mode} ${k}`);
      assert.deepEqual(dump(root), want, `${mode} ${k}`);
      assert.deepEqual(importConvLegacy(root), { files: 0, skipped: 0, rows: 0, conversations: 0 }, "idempotent");
      closeAllConvDbs();
    }
  }
});

test("a crash after the commit but before the original is removed: the second run sees the note (same name and bytes), removes the leftover and imports nothing again", () => {
  const root = layout3Folder();
  assert.throws(() => importConvLegacy(root, { crashAfterCommit: 1 }), /simulated crash/);
  assert.equal(existsSync(join(layout(root).conv("owner").dir, "session.json")), true, "still there");
  const r = importConvLegacy(root);
  assert.equal(r.skipped, 1);
  assert.equal(existsSync(join(layout(root).conv("owner").dir, "session.json")), false);
  assert.equal(convDbAt(root, "owner").num("SELECT COUNT(*) FROM session"), 1);
  closeAllConvDbs();
});

test("late files from an older process: the database wins for a one-record store (the late bytes are backed up and noted), the lists are merged, nothing is repeated", () => {
  const root = layout3Folder();
  migrate(root);
  const put = (rel: string, text: string) => (mkdirSync(dirname(join(root, rel)), { recursive: true }), writeFileSync(join(root, rel), text));
  put("conversations/owner/session.json", JSON.stringify({ sessionId: "late-s" }));
  put("conversations/owner/seen-mail.json", JSON.stringify({ ids: ["m1", "late1"] }));
  put("conversations/owner/held-posts.json", JSON.stringify({ day: "2026-10-22", posted: 9, held: [{ text: "p1", why: "quiet" }, { text: "late post", why: "quiet" }] }));
  put("conversations/owner/pending.json", JSON.stringify({ next: 2, items: [pendingItem(1, "late-tool")], expired: [], blocked: [] }));
  put("conversations/owner/quiet.json", "2099-01-01T00:00:00.000Z");
  assert.equal(hasConvLegacyFiles(root), true);
  const log: string[] = [];
  const r = migrateSafely(root, { agentLabel: "x", mode: "agent", log: (l) => log.push(l), services: { running: () => false, stop() {}, start() {}, agentPids: () => [] } });
  assert.equal(r.already, true);
  assert.equal(hasConvLegacyFiles(root), false);
  const o = convDbAt(root, "owner");
  assert.equal(o.get<{ session_id: string }>("SELECT session_id FROM session")?.session_id, "owner-s", "the database's session stays");
  assert.deepEqual(o.all<{ id: string }>("SELECT id FROM seen_mail ORDER BY seq").map((x) => x.id), ["m1", "m3", "m2", "late1"], "merged: the new id at the newest end, the known one not repeated");
  assert.deepEqual(o.all<{ text: string }>("SELECT text FROM held_posts ORDER BY seq").map((x) => x.text), ["p1", "p2", "late post"]);
  assert.deepEqual(plain(o.get("SELECT day, posted FROM hold")), { day: "2026-10-20", posted: 3 }, "the day's count stays");
  assert.equal(o.num("SELECT COUNT(*) FROM pending_items WHERE tool = 'late-tool'"), 0, "an approval inbox that has items is not mixed with another");
  // ... and the approvals that were dropped are not silent: recorded, and told to the owner
  assert.deepEqual(plain(o.all("SELECT n, label, why FROM pending_lost")), [{ n: 1, label: "L1", why: "late-file" }]);
  assert.match(lateNotice(root) ?? "", /approvals an older version of me had parked could not be restored.*your chat #1 L1/s);
  assert.equal(o.get<{ until: string }>("SELECT until FROM quiet")?.until, "", "the switch stays as it is");
  const notes = o.all<{ name: string; note: string | null; backup: string }>("SELECT name, note, backup FROM legacy_imports WHERE note IS NOT NULL");
  assert.deepEqual(notes.map((n) => n.name).sort(), ["conversations/owner/pending.json", "conversations/owner/quiet.json", "conversations/owner/session.json"]);
  for (const n of notes) assert.ok(existsSync(join(root, n.backup)), `${n.name} is in the backup`);
  closeAllConvDbs();
  closeInstanceDb();
});

test("a stamped folder keeps no reason to run the instance part again: stragglers in the OLD places are moved into place and imported like the first time", () => {
  const root = mkdtempSync(join(tmpdir(), "convimport-old-late-"));
  buildOld(root);
  migrate(root);
  assert.deepEqual(stragglers(root), []);
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state/seen-mail.json"), JSON.stringify({ ids: ["from-old-code"] }));
  assert.equal(stragglers(root).length, 1);
  migrateSafely(root, { agentLabel: "x", mode: "agent", services: { running: () => false, stop() {}, start() {}, agentPids: () => [] } });
  assert.deepEqual(stragglers(root), []);
  assert.deepEqual(convDbAt(root, "owner").all<{ id: string }>("SELECT id FROM seen_mail ORDER BY seq").map((x) => x.id), ["m1", "from-old-code"]);
  closeAllConvDbs();
  closeInstanceDb();
});

test("forgetting a conversation removes its copies from the import's backups, and only its", () => {
  const root = layout3Folder();
  migrate(root, { now: () => new Date("2026-10-21T08:00:00.000Z") });
  const backup = join(layout(root).instance.migrationBackup, "2026-10-21T08-00-00-000Z", "conversations");
  assert.ok(existsSync(join(backup, FA)) && existsSync(join(backup, "owner")));
  assert.equal(forgetConvInBackups(root, FA), 1);
  assert.equal(existsSync(join(backup, FA)), false);
  assert.ok(existsSync(join(backup, "owner")) && existsSync(join(backup, GA)));
  assert.equal(forgetConvInBackups(root, FA), 0, "idempotent");
  closeAllConvDbs();
  closeInstanceDb();
});

test("npm run migrate -- --dry-run on an old folder lists the imports into each conversation's database, files that a move will bring included, and touches nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "convimport-dry-"));
  buildOld(root);
  const r = spawnSync(process.execPath, ["--conditions=workspace-source", "scripts/migrate.ts", "--dry-run"], { cwd: ROOT, env: { ...process.env, HARNESS_DATA_DIR: root }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /import\s+conversations\/owner\/session\.json\s+->\s+conversations\/owner\/assistant\.db \(session\)/);
  assert.match(r.stdout, /import\s+conversations\/friend-anna-1a2b\/meta\.json\s+->\s+conversations\/friend-anna-1a2b\/assistant\.db \(friend, friend_notices\)/, "inside a folder that a move will rename into place");
  assert.match(r.stdout, new RegExp(`import\\s+conversations/${groupConvId(GID_A)}/quiet\\.json`));
  assert.doesNotMatch(r.stdout, /group-[0-9a-f]{16}\/meta\.json\s+->/, "a group's meta.json is not imported");
  assert.match(r.stdout, /file\(s\) to import into \d+ conversation database\(s\)/);
  assert.equal(readdirSync(root).includes("conversations"), false, "nothing was moved or made");
});

test("identical held posts inside ONE normal import are all kept; only a late file (a name already imported) is deduplicated against what is held", () => {
  const root = layout3Folder();
  const f = join(root, "conversations/owner/held-posts.json");
  writeFileSync(f, JSON.stringify({ day: "2026-10-20", posted: 1, held: [{ text: "same", why: "quiet" }, { text: "same", why: "quiet" }, { text: "other", why: "cap" }] }));
  importConvLegacy(root);
  assert.deepEqual(convDbAt(root, "owner").all<{ text: string }>("SELECT text FROM held_posts ORDER BY seq").map((x) => x.text), ["same", "same", "other"], "as the file had them");
  writeFileSync(f, JSON.stringify({ day: "2026-10-20", posted: 1, held: [{ text: "same", why: "quiet" }, { text: "new", why: "quiet" }] }));
  importConvLegacy(root);
  assert.deepEqual(convDbAt(root, "owner").all<{ text: string }>("SELECT text FROM held_posts ORDER BY seq").map((x) => x.text), ["same", "same", "other", "new"], "a late file adds only what is not held");
  closeAllConvDbs();
});
