import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// <conversation>/assistant.db (src/core/convdb.ts): one file per conversation, its policy for a damaged file, the closing before a folder is deleted, no reading across conversations, and the stores over it.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "convdb-test-"));

const { CONV_SCHEMA, checkConvDbFile, clearDamage, closeAllConvDbs, closeConvDb, closeIdleConvDbs, convDamage, convDb, damagedConvs, openConvDbCount, removeConvDir } = await import("../src/core/convdb.ts");
const { convPaths, friendConvId, groupConvId, OWNER_CONV } = await import("../src/core/convpaths.ts");
const { openDb } = await import("../src/core/db.ts");
const { readSession, writeSession } = await import("../src/run/sessionstore.ts");
const { clearQuiet, isQuiet, quietValue, setQuiet } = await import("../src/conversation/quiet.ts");
const { mayRun, isRefusal } = await import("../src/tenants/payer.ts");
const { convDbCheck } = await import("../src/doctor.ts");
const { owner, group } = await import("../src/conversation/conversationmodel.ts");
const { addPending, markExecuting, openItems, pruneBlocked, recordDone, sweepExpired, takeExpired } = await import("../src/approvals/pending.ts");
const { createSeenMail, SEEN_MAX, trimSeenMail } = await import("../src/modules/seenmail/seenmail.ts");
const { holdQuote, holdVoiceNote, MAX_AGE_MS, NOTES_PER_CONVERSATION, pruneVoiceNotes, quotedVoiceNote, voiceNotes } = await import("../src/modules/voice/voicenote.ts");
const { heldPosts, resetHeld, submitPost, MAX_HELD, noticeDamaged, ownerNotices } = await import("../src/heartbeat/notices.ts");
const { convDbRule } = await import("../src/heartbeat/convretention.ts");
const { layout } = await import("../src/core/convpaths.ts");
const { dataRoot } = await import("../src/core/convpaths.ts");

const G1 = groupConvId("convdb-g1");
const G2 = groupConvId("convdb-g2");
const mode = (p: string) => statSync(p).mode & 0o777;

test("one database per conversation, in its folder: WAL, owner-only, the schema's version, a full check on open", () => {
  const db = convDb(G1);
  assert.equal(db.path, convPaths(G1).db);
  assert.equal(db.journalMode, "wal");
  assert.equal(db.version, CONV_SCHEMA.length);
  assert.equal(mode(db.path), 0o600);
  assert.equal(db.check(true), "ok");
  assert.equal(convDb(G1), db, "the same connection while it is in use");
  assert.notEqual(convDb(G2).path, db.path);
  assert.equal(checkConvDbFile(db.path), "ok");
});

test("isolation: what one conversation writes is in its file only; a store asks for ITS conversation and has no connection to another's rows", () => {
  writeSession(G1, { sessionId: "one", costUsd: 1 });
  writeSession(G2, { sessionId: "two", costUsd: 2 });
  setQuiet({ kind: "group", convId: G1 }, "");
  assert.equal(readSession(G1).sessionId, "one");
  assert.equal(readSession(G2).sessionId, "two");
  assert.equal(isQuiet({ kind: "group", convId: G1 }, new Date()), true);
  assert.equal(isQuiet({ kind: "group", convId: G2 }, new Date()), false);
  assert.equal(addPending(`k-${G1}`, { tool: "t", input: { a: 1 }, label: "l", question: "q", footer: "", source: "background" }, 1) !== undefined, true);
  holdVoiceNote(G1, { ts: Date.now(), id: "g1.aac", size: 1, by: "x", snippet: "one" });
  assert.equal(voiceNotes(G1).length, 1);
  assert.equal(voiceNotes(G2).length, 0, "a lookup in another conversation never sees it");
  // the databases are separate files: nothing of G1 is in G2's
  const other = convDb(G2);
  for (const t of ["session", "quiet", "voice_notes", "pending_items"]) assert.equal(other.num(`SELECT COUNT(*) FROM ${t}`) > 0 && t !== "session", false, t);
  assert.equal(other.get<{ session_id: string }>("SELECT session_id FROM session")?.session_id, "two");
  assert.throws(() => convPaths("../" + G1), /not a conversation id/);
  // a conversation id never reaches another folder
  assert.ok(convPaths(G1).db.startsWith(convPaths(G1).dir) && !convPaths(G1).db.startsWith(convPaths(G2).dir));
});

test("a new table is one migration: a step appended to the list is applied once, at the next open, to a database that is already in use", () => {
  const EXT = groupConvId("convdb-ext");
  writeSession(EXT, { sessionId: "two", costUsd: 2 });
  closeConvDb(EXT);
  const path = convPaths(EXT).db;
  const tasks = { version: CONV_SCHEMA.length + 1, name: "tasks", up: "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE task_events (id INTEGER PRIMARY KEY, item INTEGER NOT NULL REFERENCES items (id), at INTEGER NOT NULL);" };
  const db = openDb(path, { migrations: [...CONV_SCHEMA, tasks], rebuildable: false });
  assert.equal(db.version, CONV_SCHEMA.length + 1);
  db.run("INSERT INTO items (title) VALUES ('first')");
  assert.equal(db.get<{ session_id: string }>("SELECT session_id FROM session")?.session_id, "two", "the existing rows are untouched");
  db.close();
  // the code of today refuses a file that a newer step made (it will not write to what it does not know)
  assert.throws(() => convDb(EXT), /newer than this code knows/);
  removeConvDir(EXT);
});

// ---- the policy for a damaged file ----

test("a damaged assistant.db: set aside (not deleted), a marker written, a fresh database started so CHAT keeps working; the other conversations are unaffected", () => {
  const bad = friendConvId("hurt-1");
  writeSession(bad, { sessionId: "before", costUsd: 1 });
  writeSession(G1, { sessionId: "intact", costUsd: 1 });
  closeConvDb(bad);
  const p = convPaths(bad);
  writeFileSync(p.db, "this is not a database at all, not even close, SQLite will say so ".repeat(40));
  const errors: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    assert.deepEqual(readSession(bad), { costUsd: 0 }, "a fresh start: the session pointer is gone, the next message starts a new session");
  } finally {
    console.error = was;
  }
  assert.ok(errors.some((e) => /assistant\.db is damaged/.test(e)));
  const d = convDamage(bad)!;
  assert.ok(d && Date.parse(d.at) > 0 && existsSync(d.keptAs), "the damaged file is kept for a human");
  assert.match(d.keptAs, /assistant\.db\.corrupt-/);
  assert.equal(readFileSync(d.keptAs, "utf8").slice(0, 20), "this is not a databa");
  writeSession(bad, { sessionId: "after", costUsd: 0 });
  assert.equal(readSession(bad).sessionId, "after", "chat writes and reads the fresh database");
  assert.deepEqual(damagedConvs().map((x) => x.conv), [bad]);
  assert.equal(readSession(G1).sessionId, "intact", "another conversation is not touched");
  assert.equal(convDamage(G1), undefined);
});

test("while it is damaged that conversation's BACKGROUND work is refused (mayRun 'damaged'), its chat is not; others run; clearing the marker lets it run again", () => {
  const bad = friendConvId("hurt-1");
  const conv = { kind: "tenant" as const, tenantId: "hurt-1" };
  const ok = { paused: () => false, spent: () => false, key: () => "k", now: Date.now() };
  assert.deepEqual(mayRun(conv, "look", ok), { refused: "damaged" });
  assert.deepEqual(mayRun(conv, "dream", ok), { refused: "damaged" });
  assert.equal(isRefusal(mayRun(conv, "chat", { ...ok, chat: true })) && (mayRun(conv, "chat", { ...ok, chat: true }) as { refused: string }).refused === "damaged", false, "a chat turn is not held back by it");
  assert.equal(isRefusal(mayRun({ kind: "group", groupId: "convdb-g1" }, "look", ok)), false);
  assert.equal(isRefusal(mayRun({ kind: "owner" }, "look", ok)), false);
  clearDamage(bad);
  assert.equal(convDamage(bad), undefined);
  assert.notEqual((mayRun(conv, "look", ok) as { refused?: string }).refused, "damaged");
});

test("the owner is told once a day while a database stays damaged, and the doctor FAILS with the file and what to do", () => {
  const bad = groupConvId("convdb-hurt-2");
  writeSession(bad, { sessionId: "x", costUsd: 0 });
  closeConvDb(bad);
  writeFileSync(convPaths(bad).db, Buffer.alloc(8192, 7));
  const was = console.error;
  console.error = () => {};
  try {
    readSession(bad);
  } finally {
    console.error = was;
  }
  const told: string[] = [];
  ownerNotices.sendTo((t) => told.push(t));
  const now = new Date(2026, 9, 21, 14, 0, 0); // (daytime: not held)
  assert.equal(noticeDamaged(now), 1);
  assert.equal(noticeDamaged(now), 0, "once a day");
  assert.equal(told.length, 1);
  assert.match(told[0]!, /group-[0-9a-f]{16}.*was damaged.*set the file aside.*background work.*stopped/s);
  ownerNotices.sendTo(undefined);
  const lines: [boolean | "warn", string, string][] = [];
  convDbCheck((ok, what, detail = "") => void lines.push([ok, what, detail]), dataRoot());
  const fail = lines.find((l) => l[0] === false && l[1] === `conversation database ${bad}`);
  assert.ok(fail, JSON.stringify(lines));
  assert.match(fail[2], /set aside as .*assistant\.db\.corrupt-.*Restore the set-aside file with the agent stopped.*delete .*assistant\.db\.damaged/s);
  assert.ok(lines.some((l) => l[1] === "conversation databases"), "the healthy ones are one line");
  clearDamage(bad);
});

test("a database file with a damaged page that opens fine is found by the check on open, not at the first query in a turn", () => {
  const bad = friendConvId("hurt-3");
  const db = convDb(bad);
  for (let i = 0; i < 2000; i++) db.run("INSERT INTO seen_mail (id) VALUES (?)", `id-${i}-${"x".repeat(60)}`);
  db.checkpoint();
  closeConvDb(bad);
  const p = convPaths(bad).db;
  const bytes = readFileSync(p);
  assert.ok(bytes.length > 8192);
  for (let i = 4096 * 2; i < 4096 * 2 + 300; i++) bytes[i] = 0xff; // a smashed page in the middle of the file
  writeFileSync(p, bytes);
  assert.notEqual(checkConvDbFile(p), "ok");
  const was = console.error;
  console.error = () => {};
  try {
    convDb(bad);
  } finally {
    console.error = was;
  }
  assert.ok(convDamage(bad), "set aside, marked");
  clearDamage(bad);
});

// ---- forgetting, idle ----

test("forgetting closes the connection FIRST and deletes the folder with the database, its -wal and -shm; a second forget finds nothing", () => {
  const f = friendConvId("forgotten-1");
  const db = convDb(f);
  db.run("INSERT INTO seen_mail (id) VALUES ('m')");
  assert.ok(existsSync(`${convPaths(f).db}-wal`) || existsSync(`${convPaths(f).db}-shm`), "open: the side files exist");
  assert.equal(removeConvDir(f), true);
  assert.equal(db.isOpen, false, "closed before the folder went");
  assert.equal(existsSync(convPaths(f).dir), false);
  assert.equal(removeConvDir(f), false, "idempotent");
  const fresh = convDb(f); // (a write after it was forgotten starts an empty database: it is a new conversation)
  assert.equal(fresh.num("SELECT COUNT(*) FROM seen_mail"), 0);
  removeConvDir(f);
});

test("idle connections are closed by the tick and opened again by the next use; a connection inside a transaction is never closed", () => {
  closeAllConvDbs();
  const a = convDb(G1);
  convDb(G2);
  assert.equal(openConvDbCount(), 2);
  assert.equal(closeIdleConvDbs(Date.now(), 60_000), 0, "just used");
  assert.equal(closeIdleConvDbs(Date.now() + 3_600_000, 60_000), 2);
  assert.equal(a.isOpen, false);
  assert.equal(readSession(G1).sessionId, "intact", "the next use opens it again, the data is there");
  const b = convDb(G2);
  convDb(G1);
  b.tx(() => {
    assert.equal(closeIdleConvDbs(Date.now() + 3_600_000, 60_000), 1, "only the one that is not in a transaction");
    assert.equal(b.isOpen, true);
  });
});

// ---- parity of the stores ----

test("session record: whole-record read and write, optional fields stay absent, the record of a fresh conversation is { costUsd: 0 }", () => {
  const c = friendConvId("parity-1");
  assert.deepEqual(readSession(c), { costUsd: 0 });
  const full = { sessionId: "s", costUsd: 2.5, lastTurnAt: "2026-10-20T10:00:00.000Z", lastContextTokens: 5, compactFailedAt: "2026-10-20T11:00:00.000Z", baseTokens: 3, seenAt: "x", untrustedIn: "pending" };
  writeSession(c, full);
  assert.deepEqual(readSession(c), full);
  writeSession(c, { costUsd: 0 });
  assert.deepEqual(readSession(c), { costUsd: 0 }, "a write replaces the record, as the file did");
  removeConvDir(c);
});

test("/quiet: no row = off; '' = until /unquiet; a time; cleared", () => {
  const c = { kind: "group" as const, convId: groupConvId("parity-quiet") };
  assert.equal(quietValue(c), undefined);
  setQuiet(c, "");
  assert.equal(quietValue(c), "");
  setQuiet(c, "2099-01-01T00:00:00.000Z");
  assert.equal(isQuiet(c, new Date()), true);
  clearQuiet(c);
  assert.equal(quietValue(c), undefined);
  removeConvDir(c.convId);
});

test("the approval inbox is transactional: a change that fails half way changes nothing (numbering included), and a restart finds the executing mark", () => {
  const scope = "tenant:parity-2";
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => addPending(scope, { tool: "t", input: circular, label: "l", question: "q", footer: "", source: "background" }, 1));
  assert.deepEqual(openItems(scope), []);
  const a = addPending(scope, { tool: "t", input: { a: 1 }, label: "l", question: "q", footer: "", source: "background" }, 1);
  assert.deepEqual(a, { n: 1, duplicate: false }, "the failed attempt did not use up a number");
  assert.equal(markExecuting(scope, [1], 50).length, 1);
  closeConvDb(friendConvId("parity-2")); // a crash: only the file is left
  assert.deepEqual(openItems(scope).map((p) => [p.n, p.executing]), [[1, { at: 50 }]]);
  removeConvDir(friendConvId("parity-2"));
});

test("the approval inbox's block list is a retention query: past its window and past 100, with a dry run that removes nothing", () => {
  const scope = "tenant:parity-3";
  for (let i = 0; i < 120; i++) recordDone(scope, "t", { i }, i, 1_000 + i);
  const db = convDb(friendConvId("parity-3"));
  assert.equal(db.num("SELECT COUNT(*) FROM pending_blocked"), 100, "bounded where it is written");
  db.run("INSERT INTO pending_blocked (key, n, at, until, kind) VALUES ('x', 1, 1, 5, 'done')");
  assert.equal(pruneBlocked(db, 10_000_000_000, true), 101, "dry run: all are past their window");
  assert.equal(db.num("SELECT COUNT(*) FROM pending_blocked"), 101);
  assert.equal(pruneBlocked(db, 10_000_000_000), 101);
  assert.equal(db.num("SELECT COUNT(*) FROM pending_blocked"), 0);
  sweepExpired(scope, 1);
  assert.deepEqual(takeExpired(scope), []);
  removeConvDir(friendConvId("parity-3"));
});

test("seen mail: the bound is a retention query, newest kept; a dry run counts only", () => {
  const c = groupConvId("parity-seen");
  const db = convDb(c);
  for (let i = 0; i < SEEN_MAX + 25; i++) db.run("INSERT INTO seen_mail (id) VALUES (?)", `m${i}`);
  assert.equal(trimSeenMail(db, SEEN_MAX, true), 25);
  assert.equal(db.num("SELECT COUNT(*) FROM seen_mail"), SEEN_MAX + 25);
  assert.equal(trimSeenMail(db), 25);
  assert.equal(db.get<{ id: string }>("SELECT id FROM seen_mail ORDER BY seq LIMIT 1")?.id, "m25");
  const s = createSeenMail(c);
  assert.deepEqual(s.unseen(["m0", "m30", "brand-new"]), ["m0", "brand-new"], "an id that fell off the bound is new again");
  removeConvDir(c);
});

test("held posts: the bound and the day's count are in the database; the retention rule keeps the same bound; voice notes keep their window and their numbers", () => {
  const c = group("parity-held");
  resetHeld(c);
  const NIGHT = new Date(2026, 9, 14, 23, 30, 0);
  for (let i = 0; i < MAX_HELD + 5; i++) submitPost(c, `post ${i}`, false, NIGHT);
  assert.equal(heldPosts(c).length, MAX_HELD);
  assert.equal(heldPosts(c)[0]!.text, "post 5", "oldest dropped first");
  const db = convDb(c.convId);
  db.run("INSERT INTO held_posts (text, why) VALUES ('extra', 'quiet')"); // (over the bound again: what the rule is for)
  const root = dataRoot();
  const rule = convDbRule(() => layout(root));
  assert.equal(rule.run(new Date(), { dryRun: true }).removed >= 1, true);
  assert.equal(db.num("SELECT COUNT(*) FROM held_posts"), MAX_HELD + 1, "a dry run removes nothing");
  rule.run(new Date(), { dryRun: false });
  assert.equal(db.num("SELECT COUNT(*) FROM held_posts"), MAX_HELD);
  // voice notes
  const key = c.key;
  const now = Date.now();
  holdVoiceNote(key, { ts: now - MAX_AGE_MS - 1000, id: "old.aac", size: 1, by: "x", snippet: "s" }, now - MAX_AGE_MS - 500); // (held when it was fresh)
  for (let i = 0; i < NOTES_PER_CONVERSATION + 3; i++) holdVoiceNote(key, { ts: now - i, id: `n${i}.aac`, size: 1, by: "x", snippet: "s" }, now);
  assert.equal(voiceNotes(key, now).length, NOTES_PER_CONVERSATION);
  holdQuote(key, 5, now - 52);
  assert.equal(quotedVoiceNote(key, 5, now)?.id, "n52.aac");
  assert.equal(quotedVoiceNote(key, 6, now), undefined);
  assert.equal(pruneVoiceNotes(db, now, true), 0);
  removeConvDir(c.convId);
});

test("the rule visits only conversations that have a database, and makes none", () => {
  const root = dataRoot();
  const before = readdirSync(layout(root).conversations).sort();
  convDbRule(() => layout(root)).run(new Date(), { dryRun: false });
  assert.deepEqual(readdirSync(layout(root).conversations).sort(), before);
  assert.equal(OWNER_CONV, owner().convId);
});
