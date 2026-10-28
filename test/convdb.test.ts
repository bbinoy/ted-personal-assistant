import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// <conversation>/assistant.db (src/core/convdb.ts): one file per conversation, its policy for a damaged file, the closing before a folder is deleted, no reading across conversations, and the stores over it.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "convdb-test-"));

const { CONV_SCHEMA, checkConvDbFile, clearDamage, closeAllConvDbs, closeConvDb, closeIdleConvDbs, ConvDbDamagedError, convDamage, convDb, damagedConvs, hasConvDb, openConvDbCount, removeConvDir, useConvDbAgentMode } = await import("../src/core/convdb.ts");
const { convPaths, friendConvId, groupConvId, OWNER_CONV } = await import("../src/core/convpaths.ts");
useConvDbAgentMode(); // (this test file plays the agent: only the agent applies the damage policy; the observer case is tested below)
const { openDb } = await import("../src/core/db.ts");
const { readSession, writeSession } = await import("../src/run/sessionstore.ts");
const { clearQuiet, isQuiet, quietValue, setQuiet } = await import("../src/conversation/quiet.ts");
const { mayRun, isRefusal } = await import("../src/tenants/payer.ts");
const { convDbCheck } = await import("../src/doctor.ts");
const { owner, group } = await import("../src/conversation/conversationmodel.ts");
const { createSeenMail, createSeenMailServer, SEEN_MAX, trimSeenMail } = await import("../src/modules/seenmail/seenmail.ts");
const { holdQuote, holdVoiceNote, MAX_AGE_MS, NOTES_PER_CONVERSATION, pruneVoiceNotes, quotedVoiceNote, voiceNotes } = await import("../src/modules/voice/voicenote.ts");
const { heldPosts, resetHeld, submitPost, noticeDamaged } = await import("../src/heartbeat/notices.ts");
const { MAX_HELD } = await import("../src/core/ownerfact.ts");
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
  holdVoiceNote(G1, { ts: Date.now(), id: "g1.aac", size: 1, by: "x", snippet: "one" });
  assert.equal(voiceNotes(G1).length, 1);
  assert.equal(voiceNotes(G2).length, 0, "a lookup in another conversation never sees it");
  // the databases are separate files: nothing of G1 is in G2's
  const other = convDb(G2);
  for (const t of ["session", "quiet", "voice_notes"]) assert.equal(other.num(`SELECT COUNT(*) FROM ${t}`) > 0 && t !== "session", false, t);
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
  const tasks = { version: CONV_SCHEMA.length + 1, name: "example", up: "CREATE TABLE example_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE example_events (id INTEGER PRIMARY KEY, item INTEGER NOT NULL REFERENCES example_items (id), at INTEGER NOT NULL);" };
  const db = openDb(path, { migrations: [...CONV_SCHEMA, tasks], rebuildable: false });
  assert.equal(db.version, CONV_SCHEMA.length + 1);
  db.run("INSERT INTO example_items (title) VALUES ('first')");
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
  resetHeld(owner());
  const now = new Date(2026, 9, 21, 14, 0, 0);
  assert.equal(noticeDamaged(now), 1);
  assert.equal(noticeDamaged(now), 0, "once a day");
  const told = heldPosts(owner()).map((h) => h.text); // (a friend's or a group's file: a fact for the owner's next look)
  assert.equal(told.length, 1);
  assert.match(told[0]!, /group-[0-9a-f]{16}.*was damaged.*set the file aside.*background work.*stopped/s);
  const lines: [boolean | "warn", string, string][] = [];
  convDbCheck((ok, what, detail = "") => void lines.push([ok, what, detail]), dataRoot());
  const fail = lines.find((l) => l[0] === false && l[1] === `conversation database ${bad}`);
  assert.ok(fail, JSON.stringify(lines));
  assert.match(fail[2], /set aside as .*assistant\.db\.corrupt-.*Restore the set-aside file with the agent stopped.*npm run convdb -- accept /s);
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

test("routine_runs: the rule removes the record of a routine whose note is gone; a note, a broken note and a run in progress keep theirs", () => {
  const c = group("routine-prune");
  const db = convDb(c.convId);
  const root = dataRoot();
  const notes = layout(root).conv(c.convId).notes;
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "routine-kept.md"), "---\nname: kept\ndescription: d\nwhen: every day at 08:00\n---\nSay hi.\n");
  writeFileSync(join(notes, "routine-broken.md"), "---\nname: broken\ndescription: d\nwhen: whenever\n---\nSay hi.\n");
  const now = Date.now();
  for (const [name, status, at] of [["routine-kept", "delivered", now], ["routine-broken", "failed", now], ["routine-gone", "delivered", now], ["routine-gone-running", "started", now - 60_000], ["routine-gone-dead", "started", now - 2 * 3_600_000]] as const)
    db.run("INSERT INTO routine_runs (name, since, status, at) VALUES (?, ?, ?, ?)", name, now, status, at);
  const names = () => db.all<{ name: string }>("SELECT name FROM routine_runs ORDER BY name").map((r) => r.name);
  const rule = convDbRule(() => layout(root));
  assert.equal(rule.run(new Date(now), { dryRun: true }).removed >= 2, true);
  assert.equal(names().length, 5, "a dry run removes nothing");
  rule.run(new Date(now), { dryRun: false });
  assert.deepEqual(names(), ["routine-broken", "routine-gone-running", "routine-kept"]);
  removeConvDir(c.convId);
});

test("reminders: a claimed or retry mark of a done or dropped task is pruned after a day; an open task keeps its marks, a fresh claim stays", () => {
  const c = group("reminder-prune");
  const db = convDb(c.convId);
  const now = Date.now();
  const item = (status: string) => Number(db.run("INSERT INTO items (title, status, created_at, updated_at) VALUES ('t', ?, ?, ?)", status, now, now).lastInsertRowid);
  const [open, done, dropped] = [item("open"), item("done"), item("dropped")];
  const mark = (id: number, key: string, state: string, at: number) => db.run("INSERT INTO reminders (item_id, key, state, fire_at, at) VALUES (?, ?, ?, ?, ?)", id, key, state, at, at);
  const old = now - 2 * 86_400_000;
  mark(open, "a", "claimed", old); mark(done, "a", "claimed", old); mark(dropped, "b", "retry", old); mark(done, "c", "sent", old); mark(done, "d", "claimed", now - 60_000);
  const keys = () => db.all<{ item_id: number; key: string }>("SELECT item_id, key FROM reminders ORDER BY item_id, key").map((r) => `${r.item_id}${r.key}`);
  const rule = convDbRule(() => layout(dataRoot()));
  rule.run(new Date(now), { dryRun: true });
  assert.equal(keys().length, 5, "a dry run removes nothing");
  rule.run(new Date(now), { dryRun: false });
  assert.deepEqual(keys(), [`${open}a`, `${done}c`, `${done}d`]);
  removeConvDir(c.convId);
});

test("the rule visits only conversations that have a database, and makes none", () => {
  const root = dataRoot();
  const before = readdirSync(layout(root).conversations).sort();
  convDbRule(() => layout(root)).run(new Date(), { dryRun: false });
  assert.deepEqual(readdirSync(layout(root).conversations).sort(), before);
  assert.equal(OWNER_CONV, owner().convId);
});

// ---- the adversarial review: damage mid-look, a reset never re-triages, only the agent applies the policy, marker first, reads make nothing, late approvals are surfaced ----

const smash = (p: string, from = 4096 * 2) => {
  const bytes = readFileSync(p);
  for (let i = from; i < from + 300; i++) bytes[i] = 0xff;
  writeFileSync(p, bytes);
};
const quiet = async <T>(f: () => T): Promise<T> => {
  const was = console.error;
  console.error = () => {};
  try {
    return f();
  } finally {
    console.error = was;
  }
};

test("damage found MID-LOOK (the idle connection was closed during a long look): the look's ids are NOT committed into the fresh database", async () => {
  const c = friendConvId("midlook-1");
  const first = createSeenMail(c);
  first.unseen(["old-1"]);
  first.commit();
  const running = createSeenMail(c); // a look that started before
  assert.deepEqual(running.unseen(["old-1", "new-1", "new-2"]), ["new-1", "new-2"]);
  closeIdleConvDbs(Date.now() + 3_600_000, 60_000); // the tick closed the idle connection while the look was parked
  const p = convPaths(c).db;
  writeFileSync(p, "garbage ".repeat(2000)); // damaged meanwhile
  await quiet(() => running.commit()); // the reopen finds the damage
  assert.ok(convDamage(c), "marked");
  const fresh = convDb(c);
  assert.equal(fresh.num("SELECT COUNT(*) FROM seen_mail WHERE id IN ('new-1','new-2')"), 0, "nothing of the look was written into the replacement");
  assert.equal(running.pending(), 0);
  clearDamage(c);
});

test("a reset WITH salvage: the mail ids and the session pointer are copied out of the damaged copy, nothing else; the flag is set", async () => {
  const c = friendConvId("salvage-1");
  const db = convDb(c);
  for (let i = 0; i < 30; i++) db.run("INSERT INTO seen_mail (id) VALUES (?)", `kept-${i}`);
  writeSession(c, { sessionId: "sess-kept", costUsd: 4 });
  for (let i = 0; i < 3000; i++) db.run("INSERT INTO held_posts (text, why) VALUES (?, 'quiet')", `post ${i} ${"y".repeat(100)}`); // (a later part of the file: the damaged page is there, the early tables are readable)
  db.checkpoint();
  closeConvDb(c);
  const size = statSync(convPaths(c).db).size;
  smash(convPaths(c).db, size - 4096 * 3);
  await quiet(() => convDb(c));
  const d = convDamage(c)!;
  assert.ok(d, "marked");
  assert.deepEqual(d.salvaged, { seenMail: 30, session: true });
  const fresh = convDb(c);
  assert.equal(fresh.num("SELECT COUNT(*) FROM seen_mail"), 30, "the ids are preserved, in order");
  assert.equal(fresh.get<{ id: string }>("SELECT id FROM seen_mail ORDER BY seq LIMIT 1")?.id, "kept-0");
  assert.equal(readSession(c).sessionId, "sess-kept");
  assert.ok(fresh.get("SELECT at FROM reset"), "the reset flag is set");
  // the owner is told once that it was set aside
  resetHeld(owner());
  noticeDamaged(new Date(2026, 9, 21, 14, 0, 0));
  const told = heldPosts(owner()).map((h) => h.text);
  assert.match(told.join("\n"), /set the file aside/);
  assert.doesNotMatch(told.join("\n"), /Reply to Anna|approval/i);
  clearDamage(c);
});

test("a reset WITHOUT salvage: the first look marks EVERY listed id as seen, dates given or not, and never says 'first look'; the flag is spent when that look ends well", async () => {
  const c = friendConvId("reset-1");
  writeSession(c, { sessionId: "x", costUsd: 0 });
  closeConvDb(c);
  writeFileSync(convPaths(c).db, Buffer.alloc(9000, 3)); // nothing readable
  await quiet(() => convDb(c));
  assert.equal(convDb(c).num("SELECT COUNT(*) FROM seen_mail"), 0);
  assert.ok(convDb(c).get("SELECT at FROM reset"));
  clearDamage(c); // a person looked: background work may run again
  const seen = createSeenMail(c);
  assert.equal(seen.reset(), true);
  assert.deepEqual(seen.unseen(["a", "b", "c"]), [], "no dates were given: all of them are still skipped");
  assert.deepEqual(seen.unseen(["a", "d"], { d: new Date().toISOString() }), [], "a recent date does not make one new either");
  assert.equal(seen.aged(), 4);
  const server = createSeenMailServer(seen) as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown) => Promise<{ content: { text: string }[] }> }> } };
  const out = await server.instance._registeredTools.seen_mail!.handler({ ids: ["a", "e"] });
  const text = out.content[0]!.text;
  assert.match(text, /I lost track of which mail I'd already handled, so I skipped what's in your inbox now; new mail from here on is handled as usual/);
  assert.doesNotMatch(text, /first look/);
  assert.match(text, /Nothing new/);
  seen.commit();
  assert.equal(convDb(c).get("SELECT at FROM reset"), undefined, "spent");
  assert.equal(convDb(c).num("SELECT COUNT(*) FROM seen_mail"), 5);
  const next = createSeenMail(c);
  assert.equal(next.reset(), false);
  assert.deepEqual(next.unseen(["a", "brand-new"]), ["brand-new"], "from here on mail is handled as usual");
  // a look that ended badly keeps the flag
  const c2 = friendConvId("reset-2");
  await quiet(() => (writeSession(c2, { costUsd: 0 }), closeConvDb(c2), writeFileSync(convPaths(c2).db, Buffer.alloc(9000, 3)), convDb(c2)));
  clearDamage(c2);
  const bad = createSeenMail(c2);
  bad.unseen(["z"]);
  bad.discard();
  assert.ok(convDb(c2).get("SELECT at FROM reset"), "the flag stays until a look that ended well");
});

test("only the AGENT applies the damage policy: any other process gets an error and the file stays exactly where it is", async () => {
  const c = friendConvId("observer-1");
  writeSession(c, { costUsd: 1 });
  closeConvDb(c);
  const p = convPaths(c).db;
  writeFileSync(p, "garbage ".repeat(2000));
  useConvDbAgentMode(false);
  try {
    assert.throws(() => convDb(c), ConvDbDamagedError);
    assert.equal(readFileSync(p, "utf8").slice(0, 7), "garbage", "not renamed under a process that may hold it open");
    assert.equal(convDamage(c), undefined, "no marker either");
    assert.deepEqual(readdirSync(convPaths(c).dir).filter((f) => /corrupt|damaged/.test(f)), []);
  } finally {
    useConvDbAgentMode(true);
  }
  await quiet(() => convDb(c)); // the agent does
  assert.ok(convDamage(c));
  clearDamage(c);
});

test("the marker is written BEFORE the file is moved, and a set-aside file with no marker still counts as damage until it is accepted", async () => {
  const c = friendConvId("marker-1");
  writeSession(c, { costUsd: 1 });
  closeConvDb(c);
  writeFileSync(convPaths(c).db, "garbage ".repeat(2000));
  await quiet(() => convDb(c));
  const d = convDamage(c)!;
  assert.equal(JSON.parse(readFileSync(convPaths(c).dbDamaged, "utf8")).keptAs, d.keptAs);
  // the marker is lost (a crash after the move, or a hand): the set-aside file alone says so
  readdirSync(convPaths(c).dir);
  writeFileSync(convPaths(c).dbDamaged, "not json");
  assert.ok(convDamage(c));
  const { rmSync } = await import("node:fs");
  rmSync(convPaths(c).dbDamaged);
  assert.match(convDamage(c)?.keptAs ?? "", /assistant\.db\.corrupt-/);
  assert.deepEqual(damagedConvs().filter((x) => x.conv === c).length, 1);
  clearDamage(c); // accepted: the set-aside file is renamed, no longer damage
  assert.equal(convDamage(c), undefined);
  assert.ok(readdirSync(convPaths(c).dir).some((f) => f.startsWith("assistant.db.reviewed-")), "kept for a human");
});

test("reads make nothing: a tick over a conversation that has no database (or was forgotten) neither makes a folder nor a file", () => {
  const ghost = friendConvId("ghost-1");
  const dir = convPaths(ghost).dir;
  assert.equal(existsSync(dir), false);
  assert.equal(isQuiet({ kind: "tenant", convId: ghost }, new Date()), false);
  assert.deepEqual(readSession(ghost), { costUsd: 0 });
  assert.equal(quietValue({ kind: "tenant", convId: ghost }), undefined);
  assert.equal(voiceNotes(`tenant:ghost-1`).length, 0);
  assert.equal(createSeenMail(ghost).unseen(["a"]).length, 1);
  assert.equal(hasConvDb(ghost), false);
  assert.equal(existsSync(dir), false, "no folder was made by any read");
});
