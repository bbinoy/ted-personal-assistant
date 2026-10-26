import { convDbAt } from "../src/core/convdb.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layout, type Layout } from "../src/core/convpaths.ts";
import { clearRetention, isDue, readRetentionState, registerRetention, retentionRules, retentionSummary, retentionTrigger, runRetention } from "../src/core/retention.ts";
import { auditRule, expiredNotesRule, expiryOf, notesBackupRule, openbaoRule, pruneAuditText, shoreRule, signalAttachmentRule, tmpRule } from "../src/heartbeat/retentionrules.ts";
import { snapshotsOf, undoLatest } from "../src/memory/dreamapply.ts";
import { loadSettings } from "../src/core/settings.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-06-15T03:30:00");
const ago = (days: number, from: Date = NOW) => new Date(from.getTime() - days * DAY);
const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const put = (path: string, text = "x", age?: number) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  if (age !== undefined) utimesSync(path, ago(age), ago(age));
  return path;
};
const root = (): { L: Layout; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), "ret-"));
  return { L: layout(dir), dir };
};
const quiet = { log: () => {} };

// ---- the registry, the clock, the state ----

test("registry: a rule registers once by name; due after 90 % of its interval; a throwing rule is recorded and the others still run; a dry run records nothing", async () => {
  clearRetention();
  const { dir } = root();
  const stateFile = join(dir, "retention.json");
  const calls: string[] = [];
  registerRetention({ name: "a", everyHours: 24, run: (_n, o) => (calls.push(`a${o.dryRun ? "-dry" : ""}`), { removed: 2, freedBytes: 2_000_000 }) });
  registerRetention({ name: "boom", everyHours: 24, run: () => { throw new Error("disk on fire"); } });
  registerRetention({ name: "a", everyHours: 24, run: (_n, o) => (calls.push(`a2${o.dryRun ? "-dry" : ""}`), { removed: 3, freedBytes: 3_000_000 }) }); // replaces the first
  assert.equal(retentionRules().length, 2);

  await runRetention(NOW, { stateFile, dryRun: true, force: true, ...quiet });
  assert.deepEqual(calls, ["a2-dry"]);
  assert.equal(existsSync(stateFile), false, "a dry run leaves no record");

  const lines: string[] = [];
  const r = await runRetention(NOW, { stateFile, log: (l) => lines.push(l) });
  assert.equal(r.ran.length, 2);
  assert.equal(lines.length, 1, "one summary line");
  assert.match(lines[0]!, /removed 3 item\(s\), freed 2\.86 MB \[a 3, boom FAILED \(disk on fire\)\]/);
  const st = readRetentionState(stateFile);
  assert.equal(st.rules.a!.removed, 3);
  assert.equal(st.rules.boom!.error, "disk on fire");
  assert.equal(st.lastFreedBytes, 3_000_000);

  const later = await runRetention(new Date(NOW.getTime() + 20 * 3_600_000), { stateFile, ...quiet }); // 20 h: not yet due (21.6 h)
  assert.deepEqual(later.skipped.sort(), ["a", "boom"]);
  const next = await runRetention(new Date(NOW.getTime() + 23.9 * 3_600_000), { stateFile, ...quiet });
  assert.equal(next.ran.length, 2, "due the next night although the last run was a few seconds after the hour");
  assert.equal(isDue({ name: "x", everyHours: 168, run: () => ({ removed: 0, freedBytes: 0 }) }, { at: ago(3).toISOString(), removed: 0, freedBytes: 0 }, NOW), false);
  clearRetention();
});

test("trigger: first tick at or after 03:30, once a day, not while busy, not again after a restart, not when disabled", () => {
  const { dir } = root();
  const stateFile = join(dir, "retention.json");
  let runs = 0;
  let busy = true;
  let on = true;
  const mk = () => retentionTrigger(() => ++runs, { stateFile, enabled: () => on, busy: () => busy });
  const t = mk();
  assert.equal(t(new Date("2026-06-15T03:29:00")), undefined);
  assert.equal(t(new Date("2026-06-15T03:31:00")), undefined, "a chat turn is running: wait for the next tick");
  assert.equal(runs, 0);
  busy = false;
  t(new Date("2026-06-15T03:36:00"));
  t(new Date("2026-06-15T05:00:00"));
  assert.equal(runs, 1, "once that day");
  t(new Date("2026-06-16T03:40:00"));
  assert.equal(runs, 2, "again the next day");
  writeFileSync(stateFile, JSON.stringify({ rules: {}, lastRunAt: new Date("2026-06-17T03:35:00").toISOString() }));
  mk()(new Date("2026-06-17T08:00:00"));
  assert.equal(runs, 2, "a restart the same day does not repeat it");
  on = false;
  mk()(new Date("2026-06-18T04:00:00"));
  assert.equal(runs, 2, "RETENTION=off");
});

test("doctor line: last run, freed space, disabled, failed rule", () => {
  const lt = (iso: string) => iso.slice(0, 10);
  assert.match(retentionSummary({ rules: {} }, true, lt).detail, /not run yet/);
  const s = { rules: { audit: { at: "x", removed: 0, freedBytes: 0, error: "no" } }, lastRunAt: "2026-06-15T01:30:00Z", lastRemoved: 4, lastFreedBytes: 5_242_880 };
  assert.deepEqual([retentionSummary(s, true, lt).ok, retentionSummary(s, true, lt).detail], ["warn", "last run 2026-06-15, removed 4 item(s), freed 5.00 MB; failed: audit"]);
  const off = retentionSummary(s, false, lt);
  assert.equal(off.ok, "warn");
  assert.match(off.detail, /RETENTION=off/);
  assert.equal(retentionSummary({ rules: {}, lastRunAt: "2026-06-15T01:30:00Z" }, true, lt).ok, true);
});

// ---- audit ----

const row = (d: Date, n = 1) => JSON.stringify({ ts: d.toISOString(), source: "chat", tool: `t${n}`, decision: "allow" });

test("audit: old lines leave the rotated generations (atomically); a generation with nothing left is deleted; the current file is never touched", () => {
  const { L } = root();
  const cur = put(L.logs.audit, [row(ago(200)), row(ago(1))].join("\n") + "\n"); // (the current file holds an old line: it is not pruned, however old)
  const g1 = put(`${L.logs.audit}.1`, [row(ago(120), 1), row(ago(100), 2), "not json", row(ago(10), 3), row(ago(2), 4)].join("\n") + "\n");
  const g2 = put(`${L.logs.audit}.2`, [row(ago(300)), row(ago(200))].join("\n") + "\n");
  const curBefore = readFileSync(cur, "utf8");
  const rule = auditRule(() => L, () => 90);
  const dry = rule.run(NOW, { dryRun: true });
  assert.equal(dry.removed, 5, "two old lines and the undated one after them in .1, both lines of .2");
  assert.ok(existsSync(g2) && readFileSync(g1, "utf8").includes('"t1"'), "dry run changed nothing");
  const r = rule.run(NOW, { dryRun: false });
  assert.equal(r.removed, 5);
  assert.equal(existsSync(g2), false);
  const left = readFileSync(g1, "utf8").trim().split("\n");
  assert.deepEqual(left.map((l) => JSON.parse(l).tool), ["t3", "t4"]);
  assert.equal(readFileSync(cur, "utf8"), curBefore);
  assert.deepEqual(readdirSync(L.logs.dir).filter((f) => f.endsWith(".tmp")), []);
  assert.ok(r.freedBytes > 0);
});

test("audit: pruneAuditText keeps the boundary line and dates a damaged line by the one before it", () => {
  const cutoff = ago(90).toISOString();
  const edge = row(ago(90));
  const t = pruneAuditText([row(ago(91)), "junk after old", edge, "junk after kept"].join("\n"), cutoff);
  assert.equal(t.dropped, 2);
  assert.equal(t.kept, `${edge}\njunk after kept\n`);
});

test("audit: nothing but rotated generations are looked at (agent.log, a lookalike, the current file)", () => {
  const { L } = root();
  const other = put(join(L.logs.dir, "agent.log.1"), row(ago(400)) + "\n");
  const look = put(`${L.logs.audit}.bak`, row(ago(400)) + "\n");
  const cur = put(L.logs.audit, row(ago(400)) + "\n");
  assert.equal(auditRule(() => L, () => 90).run(NOW, { dryRun: false }).removed, 0);
  assert.ok(existsSync(other) && existsSync(look) && existsSync(cur));
});

// ---- signal-cli attachments ----

test("signal attachments: old files go; a voice note inside its 7-day window, a young file, a link and the keys beside the folder stay", () => {
  const { L, dir } = root();
  const att = join(dir, "signal-cli", "attachments");
  const keys = put(join(dir, "signal-cli", "data", "account.d", "keys"), "secret", 400);
  const old = put(join(att, "oldfile"), "aaaa", 60);
  const young = put(join(att, "young"), "b", 5);
  const voiceFresh = put(join(att, "voice-fresh"), "c", 45); // a 45 day old file, but its note arrived 3 days ago
  const voiceStale = put(join(att, "voice-stale"), "d", 45); // its note is 20 days old: outside the window
  const otherConv = put(join(att, "note-from-other-conv"), "f", 45);
  const od = convDbAt(L.root, "owner");
  for (const [ts, id] of [[ago(3).getTime(), "voice-fresh"], [ago(20).getTime(), "voice-stale"]] as const) od.run("INSERT INTO voice_notes (ts, id, size, by, snippet) VALUES (?, ?, 0, '', '')", ts, id);
  const ad = convDbAt(L.root, "friend-anna");
  ad.run("INSERT INTO voice_notes (ts, id, size, by, snippet) VALUES (?, 'note-from-other-conv', 0, '', '')", ago(1).getTime());
  symlinkSync(old, join(att, "alink"));
  put(join(att, ".hidden"), "h", 90);
  mkdirSync(join(att, "adir"));
  const rule = signalAttachmentRule(() => L, () => att, () => 30);
  const dry = rule.run(NOW, { dryRun: true });
  assert.equal(existsSync(old), true);
  assert.equal(dry.removed, 2);
  const r = rule.run(NOW, { dryRun: false });
  assert.equal(r.removed, 2);
  assert.equal(r.freedBytes, 5);
  assert.deepEqual([old, voiceStale].map(existsSync), [false, false]);
  assert.deepEqual([young, voiceFresh, otherConv, keys, join(att, ".hidden"), join(att, "adir")].map(existsSync), Array(6).fill(true));
  assert.ok(lstatSync(join(att, "alink")).isSymbolicLink(), "a link is left alone (it dangles now, but it was not ours to remove)");
});

test("signal attachments: off at 0 days, skipped when the folder is missing or is not called attachments", () => {
  const { L, dir } = root();
  const att = join(dir, "attachments");
  put(join(att, "f"), "x", 400);
  assert.match(signalAttachmentRule(() => L, () => att, () => 0).run(NOW, { dryRun: false }).notes!, /off/);
  assert.equal(existsSync(join(att, "f")), true);
  assert.match(signalAttachmentRule(() => L, () => join(dir, "nope", "attachments"), () => 30).run(NOW, { dryRun: false }).notes!, /not found/);
  const wrong = join(dir, "keys");
  put(join(wrong, "k"), "x", 400);
  assert.equal(signalAttachmentRule(() => L, () => wrong, () => 30).run(NOW, { dryRun: false }).removed, 0);
  assert.equal(existsSync(join(wrong, "k")), true);
});

// ---- expired notes and snapshots ----

const note = (expires: string | undefined, body = "a fact") => `---\n${expires ? `expires: ${expires}\n` : ""}---\n${body}\n`;

test("expired notes: moved to notes-backup/expired and out of MEMORY.md; live, undated and index files stay; long-expired ones are deleted; backups age out", () => {
  const { L } = root();
  const n = L.conv("owner").notes;
  put(join(n, "people-gone.md"), note(dayOf(ago(3))));
  put(join(n, "status-brief.md"), note(dayOf(ago(1)), "sent"));
  put(join(n, "people-live.md"), note(dayOf(ago(-3))));
  put(join(n, "people-today.md"), note(dayOf(NOW)));
  put(join(n, "people-undated.md"), note(undefined));
  put(join(n, "trip-ancient.md"), note(dayOf(ago(45))));
  put(join(n, "odd-category.md"), note(dayOf(ago(2)))); // a name the preset does not know is still expired by its date
  put(join(n, "MEMORY.md"), "- [Gone](people-gone.md) - x\n- [Live](people-live.md) - y\n- [Ancient](trip-ancient.md) - z\n");
  const holding = join(L.conv("owner").notesBackup, "expired");
  put(join(holding, `${dayOf(ago(40))}-people-old.md`), "kept 40 days");
  put(join(holding, `${dayOf(ago(10))}-people-recent.md`), "kept 10 days");
  put(join(L.conv("friend-bo").notes, "people-x.md"), note(dayOf(ago(2))));
  put(join(L.conversations, "not-a-conversation", "notes", "people-y.md"), note(dayOf(ago(2))));

  const rule = expiredNotesRule(() => L, () => 30);
  const dry = rule.run(NOW, { dryRun: true });
  assert.equal(readdirSync(n).length, 8, "dry run moved nothing");
  const r = rule.run(NOW, { dryRun: false });
  assert.equal(r.removed, dry.removed);
  assert.deepEqual(readdirSync(n).sort(), ["MEMORY.md", "people-live.md", "people-today.md", "people-undated.md"]);
  assert.equal(readFileSync(join(n, "MEMORY.md"), "utf8"), "- [Live](people-live.md) - y\n");
  assert.deepEqual(readdirSync(holding).sort(), [`${dayOf(ago(10))}-people-recent.md`, `${dayOf(ago(1))}-status-brief.md`, `${dayOf(ago(2))}-odd-category.md`, `${dayOf(ago(3))}-people-gone.md`].sort());
  assert.equal(readdirSync(join(L.conv("friend-bo").notesBackup, "expired")).length, 1);
  assert.ok(existsSync(join(L.conversations, "not-a-conversation", "notes", "people-y.md")), "only conversation folders are visited");
  assert.equal(expiryOf("no front matter\nexpires: 2020-01-01"), undefined);
  assert.equal(expiryOf('---\nname: x\nexpires: "2026-01-02"\n---\nb'), "2026-01-02");
});

test("notes-backup: the newest 7 snapshots stay per conversation; the expired/ holding folder is not a snapshot", () => {
  const { L } = root();
  const b = L.conv("owner").notesBackup;
  const stamps = Array.from({ length: 10 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}T00-00-00-000Z`);
  for (const s of stamps) put(join(b, s, "people-a.md"), "n");
  put(join(b, "expired", "2026-01-01-people-b.md"), "x");
  put(join(L.conv("friend-bo").notesBackup, "2026-06-01T00-00-00-000Z", "a.md"), "n");
  const rule = notesBackupRule(() => L, () => 7);
  assert.equal(rule.run(NOW, { dryRun: true }).removed, 3);
  assert.equal(snapshotsOf(b).length, 10);
  rule.run(NOW, { dryRun: false });
  assert.deepEqual(snapshotsOf(b), stamps.slice(-7));
  assert.ok(existsSync(join(b, "expired", "2026-01-01-people-b.md")));
  assert.equal(snapshotsOf(L.conv("friend-bo").notesBackup).length, 1);
});

// ---- OpenBao ----

test("openbao: logs over the limit rotate (2 generations, copy-and-cut), raft snapshots keep the newest 7, nothing else in state/openbao moves", () => {
  const { L } = root();
  const o = L.instance.openbao;
  const audit = put(join(o, "audit", "audit.log"), "a".repeat(3000));
  const server = put(join(o, "logs", "server.log"), "s".repeat(3000));
  const keeper = put(join(o, "logs", "keeper.log"), "k".repeat(10));
  put(`${server}.1`, "old1");
  put(`${server}.2`, "old2-dropped");
  const key = put(join(o, "tls", "key.pem"), "KEY");
  const data = put(join(o, "data", "vault.db"), "DATA");
  const snaps = Array.from({ length: 10 }, (_, i) => put(join(o, "backup", `raft-2026-06-${String(i + 1).padStart(2, "0")}T00-00-00-000Z.snap`), "snap"));
  const rule = openbaoRule(() => L, () => 2900 / 1_048_576, () => 7);
  const dry = rule.run(NOW, { dryRun: true });
  assert.equal(readFileSync(audit, "utf8").length, 3000, "dry run cut nothing");
  assert.equal(dry.removed, 3 + 1);
  const r = rule.run(NOW, { dryRun: false });
  assert.equal(r.removed, 4);
  assert.equal(readFileSync(audit, "utf8"), "");
  assert.equal(readFileSync(`${audit}.1`, "utf8").length, 3000);
  assert.equal(readFileSync(`${server}.1`, "utf8").length, 3000);
  assert.equal(readFileSync(`${server}.2`, "utf8"), "old1", "two generations: the oldest is gone");
  assert.equal(readFileSync(keeper, "utf8"), "k".repeat(10));
  assert.deepEqual(snaps.map(existsSync), [false, false, false, true, true, true, true, true, true, true]);
  assert.deepEqual([key, data].map(existsSync), [true, true]);
});

test("openbao: not installed means skipped", () => {
  const { L } = root();
  assert.match(openbaoRule(() => L, () => 20, () => 7).run(NOW, { dryRun: false }).notes!, /not installed/);
});

// ---- shore cache and tmp ----

test("shore cache: the 50 newest by mtime stay", () => {
  const { L } = root();
  const files = Array.from({ length: 60 }, (_, i) => put(join(L.instance.shore, `${i}.json`), "[]", 60 - i)); // 0 is the oldest
  put(join(L.instance.shore, "README"), "not a cache file", 900);
  const rule = shoreRule(() => L, () => 50);
  assert.equal(rule.run(NOW, { dryRun: true }).removed, 10);
  rule.run(NOW, { dryRun: false });
  assert.deepEqual(files.map(existsSync), files.map((_, i) => i >= 10));
  assert.ok(existsSync(join(L.instance.shore, "README")));
});

test("tmp leftovers: our prefixes older than a day go; young ones, other names and links stay", () => {
  const { dir } = root();
  const t = join(dir, "tmp");
  const mk = (name: string, age: number) => {
    put(join(t, name, "f"), "data");
    utimesSync(join(t, name), ago(age), ago(age));
    return join(t, name);
  };
  const gone = ["picture-AbC123", "voiceclip-xYz789", "speech-QqQqQq", "voice-123456", "ted-google-Zz9Zz9"].map((n) => mk(n, 3));
  const stay = [mk("picture-YOUNG1", 0.2), mk("other-AbC123", 9), mk("picture-toolongname", 9), mk("ted-google-Zz9Zz8x", 9)];
  mkdirSync(join(dir, "elsewhere"));
  symlinkSync(join(dir, "elsewhere"), join(t, "speech-LinkLk"));
  const rule = tmpRule(() => t, () => 24);
  assert.equal(rule.run(NOW, { dryRun: true }).removed, 5);
  assert.deepEqual(gone.map(existsSync), Array(5).fill(true));
  assert.equal(rule.run(NOW, { dryRun: false }).removed, 5);
  assert.deepEqual(gone.map(existsSync), Array(5).fill(false));
  assert.deepEqual(stay.map(existsSync), Array(4).fill(true));
  assert.ok(existsSync(join(dir, "elsewhere")) && existsSync(join(t, "speech-LinkLk")));
});

// ---- the things nothing may delete ----

test("never: every rule, a century on, leaves the current audit file, the kill switches, the payments ledger, the tenant list and live notes alone", () => {
  const { L, dir } = root();
  const att = join(dir, "signal-cli", "attachments");
  const keep = [
    put(L.logs.audit, row(ago(900)) + "\n", 900),
    put(L.logs.agent, "log", 900),
    put(L.instance.paused, "", 900),
    put(L.instance.cardDisabled, "off", 900),
    put(L.instance.db, "the database file: payments are in it", 900),
    put(L.instance.tenants, "{}", 900),
    put(join(L.conv("owner").notes, "people-live.md"), note(undefined), 900),
    put(join(L.conv("owner").notes, "MEMORY.md"), "- [Live](people-live.md) - y\n", 900),
    put(L.conv("owner").messages, "{}\n", 900),
    L.conv("owner").db,
  ];
  convDbAt(L.root, "owner").run("INSERT INTO quiet (id, until) VALUES (1, '')"); // (a real database: the attachment rule opens it to read what it names)
  put(join(att, "x"), "x", 900);
  const rules = [auditRule(() => L, () => 90), signalAttachmentRule(() => L, () => att, () => 30), expiredNotesRule(() => L, () => 30), notesBackupRule(() => L, () => 7), openbaoRule(() => L, () => 20, () => 7), shoreRule(() => L, () => 50), tmpRule(() => join(dir, "tmp"), () => 24)];
  const later = new Date(NOW.getTime() + 36_500 * DAY);
  for (const rule of rules) rule.run(later, { dryRun: false });
  assert.deepEqual(keep.map(existsSync), keep.map(() => true));
  assert.equal(existsSync(join(att, "x")), false, "(the attachment rule did run)");
  rmSync(dir, { recursive: true, force: true });
});

// ---- the pieces around it ----

test("dream undo ignores the expired/ holding folder (it sorts after every snapshot name)", () => {
  const { dir } = root();
  const notes = join(dir, "notes");
  const backups = join(dir, "backups");
  put(join(notes, "people-a.md"), "changed");
  put(join(backups, "2026-06-01T00-00-00-000Z", "people-a.md"), "original");
  put(join(backups, "expired", "2026-01-01-people-b.md"), "set aside");
  const r = undoLatest({ notesDir: notes, backupsDir: backups, categories: ["people"], index: false, maxNotes: 100 });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(notes, "people-a.md"), "utf8"), "original");
  assert.ok(existsSync(join(backups, "expired", "2026-01-01-people-b.md")));
});

test("settings: the windows have the documented defaults and RETENTION=off", () => {
  const s = loadSettings({});
  assert.deepEqual([s.retention, s.auditRetentionDays, s.expiredNoteDeleteDays, s.notesBackupKeep, s.openbaoLogMb, s.openbaoBackupKeep, s.shoreCacheKeep, s.tmpSweepHours], [true, 90, 30, 7, 20, 7, 50, 24]);
  assert.equal(s.signalAttachmentDays, process.platform === "darwin" ? 30 : 0);
  const t = loadSettings({ RETENTION: "off", AUDIT_RETENTION_DAYS: "30", SIGNAL_ATTACHMENT_DAYS: "14" });
  assert.deepEqual([t.retention, t.auditRetentionDays, t.signalAttachmentDays], [false, 30, 14]);
  assert.throws(() => loadSettings({ AUDIT_RETENTION_DAYS: "0" }), /AUDIT_RETENTION_DAYS/);
});
