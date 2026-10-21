import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ROOT } from "../src/core/paths.ts";
import { groupConvId, layout, layout2, layout3 } from "../src/core/convpaths.ts";
import { openInstanceDbAt } from "../src/core/instancedb.ts";
import { lateNotice, markLateTold, markOwnerTold, migrate, ownerNotice, planMigration, REORGANISED_TEXT, reconcile, stragglers, type Plan } from "../src/core/migrate.ts";
import { migrateSafely, type Services } from "../src/core/migrateservices.ts";
import { forgetGroup } from "../src/conversation/forget.ts";
import { buildOld, GID_A, hash16, key12 } from "./oldlayout.ts";

const fresh = (): string => mkdtempSync(join(tmpdir(), "migsafe-"));
const old = (): string => {
  const root = fresh();
  buildOld(root);
  return root;
};
const read = (p: string) => readFileSync(p, "utf8");
const put = (root: string, rel: string, text: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};

// ---- 1. nobody else on the data ----

function fakeServices(o: { running?: string[]; others?: number[] } = {}) {
  const calls: string[] = [];
  const up = new Set(o.running ?? []);
  const s: Services = {
    running: (l) => up.has(l),
    stop: (l) => (calls.push(`stop ${l}`), up.delete(l)),
    start: (l) => void calls.push(`start ${l}`),
    agentPids: () => o.others ?? [],
  };
  return { s, calls };
}
const LABEL = "com.test.ted";

test("the agent's start stops the intake job while the data moves, and starts it after the stamp", () => {
  const root = old();
  const { s, calls } = fakeServices({ running: [`${LABEL}-intake`] });
  const r = migrateSafely(root, { services: s, agentLabel: LABEL, mode: "agent" });
  assert.equal(r.already, false);
  assert.deepEqual(calls, [`stop ${LABEL}-intake`, `start ${LABEL}-intake`]);
  assert.ok(existsSync(layout(root).instance.layoutVersion));
});

test("the agent's start refuses to migrate under another agent process and touches nothing", () => {
  const root = old();
  const { s, calls } = fakeServices({ others: [4242] });
  assert.throws(() => migrateSafely(root, { services: s, agentLabel: LABEL, mode: "agent" }), /another agent process is running \(pid 4242\).*launchctl bootout/);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(layout(root).instance.layoutVersion), false);
  assert.equal(existsSync(join(root, "state/session.json")), true);
});

test("npm run migrate refuses while the agent or the intake job runs, with the exact commands; --stop-services stops both, migrates and starts both", () => {
  const root = old();
  const up = fakeServices({ running: [LABEL, `${LABEL}-intake`] });
  assert.throws(() => migrateSafely(root, { services: up.s, agentLabel: LABEL, mode: "cli" }), (e: Error) => e.message.includes(`launchctl bootout gui/`) && e.message.includes(`${LABEL}-intake`) && e.message.includes("--stop-services"));
  assert.deepEqual(up.calls, [], "nothing was stopped");
  assert.equal(existsSync(join(root, "state/session.json")), true);
  const only = fakeServices({ running: [`${LABEL}-intake`] });
  assert.throws(() => migrateSafely(root, { services: only.s, agentLabel: LABEL, mode: "cli" }), /intake page is running/);
  const r = migrateSafely(root, { services: up.s, agentLabel: LABEL, mode: "cli", stopServices: true });
  assert.equal(r.already, false);
  assert.deepEqual(up.calls, [`stop ${LABEL}-intake`, `stop ${LABEL}`, `start ${LABEL}-intake`, `start ${LABEL}`]);
  const quiet = fakeServices();
  assert.equal(migrateSafely(root, { services: quiet.s, agentLabel: LABEL, mode: "cli" }).already, true);
  assert.deepEqual(quiet.calls, [], "a migrated folder with nothing late touches no service");
});

// ---- 1b. stragglers after the stamp ----

test("an old process that keeps writing after the stamp: logs are merged in time order, files the new layout has are set aside, a file it lacks moves into place; the owner is told once; doctor sees it until then", () => {
  const root = old();
  const L = layout(root);
  migrate(root);
  assert.deepEqual(stragglers(root), []);
  // (layout 3: the small files of instance/ were imported into instance.db and removed; an old version's late files come back through the old places, are moved or merged into instance/ as before, and are imported again)
  const pay = (id: string, ts: string) => JSON.stringify({ id, ts, merchant: "m", totalMinor: 100, currency: "EUR", last4: "1111", cartHash: id, status: "confirmed" });
  const V2 = layout2(root);
  put(root, "state/payments.jsonl", `${pay("p0", "2020-01-01T00:00:00.000Z")}\n${pay("p2", "2030-01-01T00:00:00.000Z")}\n`);
  writeFileSync(V2.payments, `${pay("p1", "2025-01-01T00:00:00.000Z")}\n${pay("p0", "2020-01-01T00:00:00.000Z")}\n`);
  put(root, "state/heartbeat.jsonl", '{"at":"2027-01-01T00:00:00.000Z","n":1}\n');
  put(root, "state/registrations.json", '{"late":"from the old intake page"}');
  put(root, "state/intake-problems.json", '{"zed":{"calendar":"2031-01-01T00:00:00.000Z"}}');
  put(root, "state/mystery2.txt", "new unknown");
  put(root, "logs/messages.jsonl", '{"ts":2000000000000,"text":"late chat"}\n');
  assert.ok(stragglers(root).length >= 6, "doctor's check has something to show");
  const log: string[] = [];
  const { s } = fakeServices();
  migrateSafely(root, { services: s, agentLabel: LABEL, mode: "agent", log: (l) => log.push(l) });
  assert.deepEqual(stragglers(root), [], "nothing is left in the old places");
  // merged: the union, identical lines once, in time order
  const db = openInstanceDbAt(L.instance.db);
  assert.deepEqual(db.all<{ id: string }>("SELECT id FROM payments ORDER BY seq").map((r) => r.id), ["p0", "p1", "p2"]);
  assert.equal(existsSync(V2.payments), false, "imported, and the file is gone");
  assert.deepEqual(db.all<{ at: string }>("SELECT at FROM looks ORDER BY id").map((r) => r.at), ["2026-10-19T10:00:00.000Z", "2026-10-20T10:00:00.000Z", "2027-01-01T00:00:00.000Z"], "the two rows the migration imported (the rotated one first) and the late one");
  assert.match(read(L.conv("owner").messages), /hello/);
  assert.match(read(L.conv("owner").messages), /late chat/);
  // a conflicting file is set aside (the new layout's stays), a missing target is filled
  assert.equal(read(L.instance.registrations), "{}");
  assert.equal(read(join(L.instance.migrationOrphans, "state/registrations.json")), '{"late":"from the old intake page"}');
  assert.equal(db.get<{ problem_at: string }>("SELECT problem_at FROM intake WHERE tenant = 'zed' AND purpose = 'calendar'")?.problem_at, "2031-01-01T00:00:00.000Z", "a file the new layout lacked is moved into place and imported");
  assert.equal(read(join(L.instance.migrationOrphans, "state/mystery2.txt")), "new unknown");
  assert.ok(log.some((l) => l.includes("LATE FILES")) && log.some((l) => l.includes("late file state/registrations.json")));
  // the owner hears of it once, with the names
  const text = lateNotice(root)!;
  assert.match(text, /state\/registrations\.json/);
  assert.match(text, /state\/payments\.jsonl/);
  markLateTold(root);
  assert.equal(lateNotice(root), undefined);
  // and the stamped folder keeps working
  assert.equal(migrateSafely(root, { services: fakeServices().s, agentLabel: LABEL, mode: "agent" }).already, true);
});

test("a plan finished before an old process wrote again (a rollback to old code, then forward): the migration plans again and loops until the old places are empty", () => {
  const root = old();
  const L = layout(root);
  migrate(root);
  rmSync(L.instance.layoutVersion); // rolled back: the stamp is gone, the plan says everything is done
  put(root, "state/payments.jsonl", `${JSON.stringify({ id: "after", ts: "2031-01-01T00:00:00.000Z", merchant: "m", totalMinor: 5, currency: "EUR", last4: "1", cartHash: "c", status: "confirmed" })}\n`);
  put(root, "state/session.json", '{"sessionId":"written by old code"}');
  rmSync(layout3(root).conv("owner").session);
  const log: string[] = [];
  migrate(root, { log: (l) => log.push(l) });
  assert.deepEqual(stragglers(root), []);
  assert.equal(read(layout3(root).conv("owner").session), '{"sessionId":"written by old code"}');
  assert.deepEqual(openInstanceDbAt(L.instance.db).all<{ id: string }>("SELECT id FROM payments").map((r) => r.id), ["after"], "moved into instance/ and imported into instance.db");
  assert.ok(log.some((l) => /more step/.test(l)));
  const plan = JSON.parse(read(L.instance.migrationPlan)) as Plan;
  assert.ok(plan.ops.every((o) => o.done));
});

// ---- 2. payments archives ----

test("payments archives are moved to instance/, never set aside", () => {
  const root = old();
  put(root, "state/payments-2025.jsonl", "a\n");
  put(root, "state/payments-2025-2.jsonl", "b\n");
  migrate(root, { movesOnly: true }); // (the moves; the import into instance.db is the next step, test/dbimport.test.ts)
  const L = layout(root);
  assert.equal(read(join(L.instance.dir, "payments-2025.jsonl")), "a\n");
  assert.equal(read(join(L.instance.dir, "payments-2025-2.jsonl")), "b\n");
  assert.equal(existsSync(join(L.instance.migrationOrphans, "state/payments-2025.jsonl")), false);
});

// ---- 3. copies and conflicts ----

test("a cross-device copy that was begun and not finished: the partial target is deleted and the source copied again", () => {
  const root = old();
  const L = layout(root);
  const plan = planMigration(root);
  const op = plan.ops.find((o) => o.to === L.conv("friend-anna-1a2b").dir)!;
  op.copying = true;
  mkdirSync(L.instance.dir, { recursive: true });
  writeFileSync(L.instance.migrationPlan, JSON.stringify(plan));
  put(root, "conversations/friend-anna-1a2b/messages.jsonl", "PARTIAL"); // what a crash left
  migrate(root);
  assert.match(read(L.conv("friend-anna-1a2b").messages), /anna-1a2b says hi/);
  assert.equal(existsSync(join(L.conv("friend-anna-1a2b").dir, "notes", "context-p.md")), true);
  assert.equal(existsSync(join(L.instance.migrationOrphans, "tenants/anna-1a2b")), false, "the source was not made an orphan");
});

test("the plan records that a copy began, and a finished step carries no such mark", () => {
  const root = old();
  migrate(root, { forceCopy: true });
  const plan = JSON.parse(read(layout(root).instance.migrationPlan)) as Plan;
  assert.ok(plan.ops.every((o) => o.done && !o.copying));
});

test("a conflict on a conversation's data stops the migration with a sentence and promotes nothing; an instance file's conflict is set aside; fixing it lets the same plan finish", () => {
  const root = old();
  const L = layout(root);
  put(root, "conversations/owner/session.json", '{"sessionId":"somebody else wrote this"}');
  put(root, "instance/tenants.json", '{"tenants":[]}');
  assert.throws(() => migrate(root), /state\/session\.json and conversations\/owner\/session\.json both exist with different content.*stops here/s);
  assert.equal(existsSync(L.instance.layoutVersion), false, "not stamped");
  assert.equal(read(join(root, "state/session.json")), '{"sessionId":"owner-s"}', "the source is where it was");
  assert.equal(read(layout3(root).conv("owner").session), '{"sessionId":"somebody else wrote this"}', "the target was not promoted over it, and the source not orphaned");
  assert.equal(existsSync(join(L.instance.migrationOrphans, "state/session.json")), false);
  rmSync(layout3(root).conv("owner").session); // the person chose
  migrate(root);
  assert.equal(read(layout3(root).conv("owner").session), '{"sessionId":"owner-s"}');
  assert.equal(read(L.instance.tenants), '{"tenants":[]}', "an instance file with other content is set aside, not overwritten");
  assert.ok(existsSync(join(L.instance.migrationOrphans, "state/tenants.json")));
});

test("the owner's notice says what was set aside, and 'nothing was lost' only when nothing was", () => {
  const withOrphans = old();
  migrate(withOrphans);
  const text = ownerNotice(withOrphans)!;
  assert.doesNotMatch(text, /Nothing was lost/);
  assert.match(text, /set aside, not deleted.*migration-orphans/);
  assert.match(text, /state\/mystery\.txt/);
  markOwnerTold(withOrphans);
  assert.equal(ownerNotice(withOrphans), undefined);
  const clean = fresh();
  put(clean, "state/session.json", "{}");
  put(clean, "logs/messages.jsonl", "x\n");
  migrate(clean);
  assert.equal(ownerNotice(clean), REORGANISED_TEXT);
});

// ---- 4. the lock ----

test("lock: a lock made but not yet holding its pid is alive for 10 s, then stale; a reused pid (another start time) is stale; the error names the lock", () => {
  const root = fresh();
  const lock = layout(root).instance.migrationLock;
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "x"), ""); // (an empty folder would be renamed over: the real lock is never empty)
  assert.throws(() => migrate(buildAt(root), {}, 0), (e: Error) => e.message.includes(lock) && /another process is migrating/.test(e.message));
  const long = new Date(Date.now() - 60_000);
  utimesSync(lock, long, long);
  assert.equal(migrate(root, {}, 0).already, false, "an old lock with no pid is taken over");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "pid"), `${process.ppid}\nMon Jan  1 00:00:00 1990`); // a live pid, but it started at another time than the one that took the lock
  rmSync(layout(root).instance.layoutVersion);
  assert.doesNotThrow(() => migrate(root, {}, 0), "the pid was reused: stale");
  assert.equal(existsSync(lock), false);
});
const buildAt = (root: string): string => (buildOld(root), root);

// ---- 5. 6. 7. 8. ----

test("two old folders for one group: the one named by the hash of its id is kept, whatever the alphabet says; the other is set aside", () => {
  const root = fresh();
  const id = GID_A;
  const mine = createHash("sha256").update(id).digest("hex").slice(0, 12);
  put(root, "memory/groups/000000000000/meta.json", JSON.stringify({ id, name: "Impostor" }));
  put(root, "memory/groups/000000000000/notes/x.md", "impostor");
  put(root, `memory/groups/${mine}/meta.json`, JSON.stringify({ id, name: "Real" }));
  put(root, `memory/groups/${mine}/notes/x.md`, "real");
  migrate(root);
  const L = layout(root);
  assert.equal(read(join(L.conv(groupConvId(id)).notes, "x.md")), "real");
  assert.equal(read(join(L.instance.migrationOrphans, "memory/groups/000000000000/notes/x.md")), "impostor");
});

test("voice-note sources that clash with ones already in the conversation: notes AND quotes are set aside", () => {
  const root = old();
  put(root, "conversations/owner/voices/sources.json", '{"notes":[{"ts":99}],"quotes":{}}');
  migrate(root);
  const aside = JSON.parse(read(join(layout(root).instance.migrationOrphans, "state/voice/sources.json")));
  assert.deepEqual(aside.notes.owner, [{ ts: 1, id: "o.aac" }]);
  assert.deepEqual(aside.quotes.owner, { "10": 1 });
  assert.equal(read(layout3(root).conv("owner").voiceSources), '{"notes":[{"ts":99}],"quotes":{}}');
});

test("the browse folder is a cache: browsers set up by the new code before the first start are kept, duplicates discarded, the rest merged in, no conflict", () => {
  const root = old();
  const L = layout(root);
  put(root, "instance/browse/browsers/chromium-1/chrome", "NEW-DOWNLOAD");
  put(root, "state/browse/browsers/chromium-1/chrome", "OLD-DOWNLOAD");
  put(root, "state/browse/browsers/chromium-0/chrome", "OLDER");
  migrate(root);
  assert.equal(read(join(L.instance.browsers, "chromium-1/chrome")), "NEW-DOWNLOAD");
  assert.equal(read(join(L.instance.browsers, "chromium-0/chrome")), "OLDER");
  assert.equal(read(join(L.instance.browse, "run-1/page.md")), "a page");
  assert.equal(existsSync(join(root, "state/browse")), false);
  assert.equal(existsSync(join(L.instance.migrationOrphans, "state/browse")), false);
});

test("forget group with an empty or blank reference is an error, never the unnamed group", () => {
  for (const ref of ["", "  ", "\t"]) {
    const r = forgetGroup(ref);
    assert.ok("error" in r, JSON.stringify(ref));
  }
});

test("doctor fails a check while something is in the old places of a migrated folder, and passes it once the agent has dealt with it", () => {
  const root = old();
  migrate(root);
  put(root, "state/payments.jsonl", '{"id":"late"}\n');
  const doctor = () => spawnSync(process.execPath, ["--conditions=workspace-source", "src/cli.ts", "doctor"], { cwd: ROOT, env: { ...process.env, HARNESS_DATA_DIR: root, BROWSE_SKIP_INSTALL: "1" }, encoding: "utf8", timeout: 90_000 }).stdout;
  assert.match(doctor(), /FAIL\s+files in the old places\s+\(1 path\(s\) an older version wrote after the move \(state\/payments\.jsonl\)/);
  reconcile(root);
  assert.doesNotMatch(doctor(), /files in the old places/);
});

test("the real run does exactly the dry run's steps and orphans: the empty folders left by moved libraries are neither steps nor orphans, and the owner's notice lists the real orphans only", () => {
  const root = old();
  const dry = planMigration(root);
  const dryOrphans = dry.ops.filter((o) => o.kind === "orphan").map((o) => o.from.slice(root.length + 1)).sort();
  const log: string[] = [];
  const r = migrate(root, { log: (l) => log.push(l) });
  assert.equal(r.plan!.ops.length, dry.ops.length, "no second round of steps");
  assert.equal(r.moved, dry.ops.length);
  assert.equal(dryOrphans.length, 8);
  const realOrphans = r.plan!.ops.filter((o) => o.kind === "orphan").map((o) => o.from.slice(root.length + 1)).sort();
  assert.deepEqual(realOrphans, dryOrphans);
  assert.deepEqual([...r.orphans].sort(), [...dryOrphans, "state/voice/sources.json"].sort(), "the eight, plus the sources of conversations that are not here");
  // no orphan is an empty folder
  assert.equal(existsSync(join(layout(root).instance.migrationOrphans, "state/voice/groups/81628494d931c841")), false, "no empty library shell set aside");
  assert.equal(existsSync(join(root, "state/voice/groups")), false, "the empty legacy folders are gone");
  assert.equal(log.filter((l) => l.includes("set aside") && l.includes("voices of a conversation")).length, 1, "only the library of nobody");
  const text = ownerNotice(root)!;
  assert.match(text, /9 item\(s\)/);
  assert.doesNotMatch(text, /81628494d931c841|dc09cefd04c569a9/);
  assert.match(text, /state\/voice\/groups\/deadbeefdeadbeef/);
});

test("planning stays pure and the hash helpers agree with the fixture", () => {
  const root = old();
  assert.equal(hash16(GID_A).length, 16);
  assert.equal(key12(GID_A).length, 12);
  const before = JSON.stringify(planMigration(root).ops.map((o) => o.from));
  assert.equal(JSON.stringify(planMigration(root).ops.map((o) => o.from)), before);
  void reconcile;
});
