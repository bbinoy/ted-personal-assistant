import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ROOT } from "../src/core/paths.ts";
import { groupConvId, layout, LAYOUT_VERSION, MOVES_VERSION } from "../src/core/convpaths.ts";
import {
  describePlan, layoutState, markOwnerTold, migrate, ownerNotice, planMigration, readVersion, refusal, REORGANISED_TEXT, rekeyCapNotices, rekeyGroupCost, sameTree, type FsView, type Plan,
} from "../src/core/migrate.ts";
import { buildOld, FRIENDS, GID_A, GID_B, hash16, key12, sha, snapshot, UNKNOWN_HASH } from "./oldlayout.ts";

// The move tests look at layout 2 as the moves leave it: the stamp is 2 and the small files are still files (the import into instance.db is the next step: test/dbimport.test.ts).
const moves = (root: string, o: Parameters<typeof migrate>[1] = {}, wait?: number) => migrate(root, { ...o, movesOnly: true }, wait);
const fresh = (): string => mkdtempSync(join(tmpdir(), "migrate-"));
// the tree without the plan file (it names the folder it ran in and the time)
const tree = (root: string): Record<string, string> => {
  const t = snapshot(root);
  delete t["instance/migration-plan.json"];
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k.replace(/^instance\/migration-backup\/[^/]+\//, "instance/migration-backup/T/"), v])); // (the backup folder is named by the time)
};
const old = (): string => {
  const root = fresh();
  buildOld(root);
  return root;
};
const A = groupConvId(GID_A);
const B = groupConvId(GID_B);
const rel = (root: string, p: string) => relative(root, p);
const planned = (plan: Plan, root: string) => plan.ops.map((o) => `${o.kind} ${rel(root, o.from)} -> ${rel(root, o.to)}`);

test("plan: every kind of old file has its place; what belongs to nobody is set aside; nothing is touched while planning", () => {
  const root = old();
  const before = snapshot(root);
  const plan = planMigration(root);
  assert.deepEqual(snapshot(root), before, "planning reads, never writes");
  const lines = planned(plan, root);
  const has = (from: string, to: string, kind = "move") => assert.ok(lines.includes(`${kind} ${from} -> ${to}`), `${kind} ${from} -> ${to}`);
  // the owner
  has("memory/notes", "conversations/owner/notes");
  for (const [f, t] of [["session.json", "session.json"], ["held-posts.json", "held-posts.json"], ["seen-mail.json", "seen-mail.json"], ["dream.json", "dream.json"], ["quiet.json", "quiet.json"], ["pending-owner.json", "pending.json"], ["search.sqlite", "search.sqlite"], ["search.sqlite-journal", "search.sqlite-journal"], ["notes-backup", "notes-backup"]] as const) has(`state/${f}`, `conversations/owner/${t}`);
  has("logs/messages.jsonl", "conversations/owner/messages.jsonl");
  has("logs/messages.jsonl.corrupt-2026-01-01T00-00-00-000Z", "conversations/owner/messages.jsonl.corrupt-2026-01-01T00-00-00-000Z");
  // a friend's folder is renamed whole, then its backup folder; her pending approvals and voices follow
  for (const id of FRIENDS) {
    has(`tenants/${id}`, `conversations/friend-${id}`);
    has(`conversations/friend-${id}/backup`, `conversations/friend-${id}/notes-backup`);
  }
  has(`state/pending-${hash16("tenant:anna-1a2b")}.json`, "conversations/friend-anna-1a2b/pending.json");
  has(`state/voice/groups/${hash16("tenant:anna-1a2b")}/voices/her`, "conversations/friend-anna-1a2b/voices/her");
  // a group: folder, backup, history, pending, voices; the folder name is the hash of its id and the id is nowhere in the plan
  has(`memory/groups/${key12(GID_A)}`, `conversations/${A}`);
  has(`conversations/${A}/backup`, `conversations/${A}/notes-backup`);
  has(`logs/group-${key12(GID_A)}.jsonl`, `conversations/${A}/messages.jsonl`);
  has(`state/pending-${hash16(GID_A)}.json`, `conversations/${A}/pending.json`);
  has(`state/voice/groups/${hash16(GID_A)}/active.json`, `conversations/${A}/voices/active.json`);
  has(`state/voice/groups/${hash16(GID_A)}/voices/kid`, `conversations/${A}/voices/kid`);
  has(`memory/groups/${key12(GID_B)}`, `conversations/${B}`);
  // the owner's voices
  has("state/voice/active.json", "conversations/owner/voices/active.json");
  has("state/voice/voices/mine", "conversations/owner/voices/mine");
  assert.ok(plan.ops.some((o) => o.kind === "split-sources" && rel(root, o.from) === "state/voice/sources.json"));
  // the process-wide files
  for (const f of ["tenants.json", "registrations.json", "intake-status.json", "intake-problems.json", "cost.json", "key-cost.json", "heartbeat.json", "heartbeat.jsonl", "heartbeat.jsonl.1", "connectors.json", "tools-seen.json", "notion-client.json", "payments.jsonl", "card.disabled", "paused", "tenants.json.corrupt-2026-01-01T00-00-00-000Z"]) has(`state/${f}`, `instance/${f}`);
  for (const d of ["intake", "shore", "browse"]) has(`state/${d}`, `instance/${d}`);
  has("state/group-cost.json", "instance/group-cost.json", "rekey");
  has("state/cap-notices.json", "instance/cap-notices.json", "rekey");
  // set aside, not dropped
  for (const o of [`state/pending-${UNKNOWN_HASH}.json`, "state/mystery.txt", "state/voice/groups/deadbeefdeadbeef", "memory/groups/ffffffffffff", "memory/stray.txt", "logs/group-ffffffffffff.jsonl", "logs/group-aaaaaaaaaaaa.jsonl", "tenants/notafolder.txt"]) has(o, `instance/migration-orphans/${o}`, "orphan");
  // what stays: installed software, the default voice's own clip, the logs
  const from = new Set(plan.ops.map((o) => rel(root, o.from)));
  for (const stays of ["state/openbao", "state/tts-qwen", "state/voice", "state/voice/ref.wav", "state/voice/ref.txt", "logs/audit.jsonl", "logs/agent.log", "logs/signal-daemon.log", "logs/launchd-stderr.log"]) assert.ok(!from.has(stays), stays);
  // no raw group id or phone number anywhere in the plan
  const text = JSON.stringify(plan);
  for (const id of [GID_A, GID_B]) assert.ok(!text.includes(id) && !text.includes(sha(id).slice(0, 12) + "x"), "no raw group id");
  const dests = plan.ops.filter((o) => o.kind !== "split-sources").map((o) => o.to);
  assert.equal(new Set(dests).size, dests.length, "no two steps share a destination");
});

test("plan: pure on a view of the files (no disk), and a new or already migrated folder has nothing to do", () => {
  const files: Record<string, string> = {
    "/d/state/session.json": "{}",
    "/d/logs/messages.jsonl": "x\n",
    "/d/tenants/zed-1/messages.jsonl": "x\n",
    "/d/memory/groups/abcdefabcdef/meta.json": JSON.stringify({ id: "g-fake" }),
  };
  const dirs = new Set(["/d/state", "/d/logs", "/d/tenants", "/d/tenants/zed-1", "/d/memory", "/d/memory/groups", "/d/memory/groups/abcdefabcdef"]);
  const view: FsView = {
    exists: (p) => p in files || dirs.has(p),
    isDir: (p) => dirs.has(p),
    list: (d) => [...Object.keys(files).map((f) => [f, false] as const), ...[...dirs].map((f) => [f, true] as const)].filter(([f]) => f.startsWith(`${d}/`) && !f.slice(d.length + 1).includes("/")).map(([f, dir]) => ({ name: f.slice(d.length + 1), dir })),
    readJson: (p) => (p in files ? JSON.parse(files[p]!) : undefined),
  };
  const plan = planMigration("/d", view, new Date(0));
  assert.deepEqual(planned(plan, "/d"), [
    "move tenants/zed-1 -> conversations/friend-zed-1",
    `move memory/groups/abcdefabcdef -> conversations/${groupConvId("g-fake")}`,
    "move state/session.json -> conversations/owner/session.json",
    "move logs/messages.jsonl -> conversations/owner/messages.jsonl",
  ]);
  assert.equal(planMigration(fresh()).ops.length, 0);
  assert.deepEqual(describePlan(planMigration(fresh())), ["Nothing to move: the data folder is in the current layout already (or is new)."]);
});

test("migrate end to end: every file arrives with its content, the old places are empty, the plan is recorded, the version is written last", () => {
  const root = old();
  const before = snapshot(root);
  const log: string[] = [];
  const r = moves(root, { log: (l) => log.push(l) });
  assert.equal(r.already, false);
  const L = layout(root);
  assert.equal(readVersion(root), MOVES_VERSION);
  const after = snapshot(root);
  const at = (rel2: string) => after[rel2];
  // content moved, byte for byte
  assert.equal(at("conversations/owner/notes/style-x.md"), before["memory/notes/style-x.md"]);
  assert.equal(at("conversations/owner/session.json"), before["state/session.json"]);
  assert.equal(at("conversations/owner/messages.jsonl"), before["logs/messages.jsonl"]);
  assert.equal(at("conversations/owner/pending.json"), before["state/pending-owner.json"]);
  assert.equal(at("conversations/owner/search.sqlite"), "SQLITE-OWNER");
  assert.equal(at("conversations/owner/notes-backup/2026-01-01/a.md"), before["state/notes-backup/2026-01-01/a.md"]);
  assert.equal(at("conversations/owner/voices/mine/ref.wav"), "RIFF-MINE");
  assert.equal(at("conversations/owner/voices/active.json"), before["state/voice/active.json"]);
  for (const id of FRIENDS) {
    const c = `conversations/friend-${id}`;
    assert.equal(at(`${c}/messages.jsonl`), before[`tenants/${id}/messages.jsonl`]);
    assert.equal(at(`${c}/tenant.json`), before[`tenants/${id}/tenant.json`]);
    assert.equal(at(`${c}/notes/context-p.md`), before[`tenants/${id}/notes/context-p.md`]);
    assert.equal(at(`${c}/notes-backup/2026-01-01/context-p.md`), before[`tenants/${id}/backup/2026-01-01/context-p.md`]);
    for (const f of ["dream.json", "seen-mail.json", "held-posts.json", "quiet.json", "session.json", "cost.json", "meta.json"]) assert.equal(at(`${c}/${f}`), before[`tenants/${id}/${f}`], f);
    assert.equal(after[`${c}/backup/`], undefined, "the old name is gone");
  }
  assert.equal(at("conversations/friend-anna-1a2b/pending.json"), before[`state/pending-${hash16("tenant:anna-1a2b")}.json`]);
  assert.equal(at("conversations/friend-anna-1a2b/voices/her/ref.wav"), "RIFF-HER");
  for (const [id, conv] of [[GID_A, A], [GID_B, B]] as const) {
    const c = `conversations/${conv}`;
    const k = key12(id);
    assert.equal(at(`${c}/messages.jsonl`), before[`logs/group-${k}.jsonl`]);
    assert.equal(at(`${c}/meta.json`), before[`memory/groups/${k}/meta.json`]);
    assert.equal(at(`${c}/notes/context-g.md`), before[`memory/groups/${k}/notes/context-g.md`]);
    assert.equal(at(`${c}/notes-backup/2026-01-01/context-g.md`), before[`memory/groups/${k}/backup/2026-01-01/context-g.md`]);
    for (const f of ["session.json", "dream.json", "seen-mail.json", "held-posts.json", "quiet.json"]) assert.equal(at(`${c}/${f}`), before[`memory/groups/${k}/${f}`], f);
  }
  assert.equal(at(`conversations/${A}/pending.json`), before[`state/pending-${hash16(GID_A)}.json`]);
  assert.equal(at(`conversations/${A}/voices/kid/ref.wav`), "RIFF-KID");
  assert.equal(at(`conversations/${A}/voices/active.json`), '{"name":"kid"}');
  // the process-wide files
  for (const f of ["tenants.json", "registrations.json", "intake-status.json", "cost.json", "key-cost.json", "heartbeat.json", "heartbeat.jsonl", "heartbeat.jsonl.1", "connectors.json", "tools-seen.json", "notion-client.json", "payments.jsonl", "card.disabled", "paused", "intake/abc123.json", "shore/1.0000_2.0000.json", "browse/run-1/page.md", "browse/shots/run-1/shot1.jpg", "tenants.json.corrupt-2026-01-01T00-00-00-000Z"]) assert.equal(at(`instance/${f}`), before[`state/${f}`], f);
  // keys that held raw group ids are folder names now
  const cost = JSON.parse(at("instance/group-cost.json")!);
  assert.deepEqual(cost.usd, { [A]: 1.5, [B]: 2 });
  const notices = JSON.parse(at("instance/cap-notices.json")!);
  assert.deepEqual(notices.keys, [`group:${A}`, "friend:anna-1a2b", "owner:instance", `group-budget:${B}`]);
  assert.deepEqual(notices.at, { [`warn:${A}`]: 1, "warn:owner": 2, "warn:friend-anna-1a2b": 3, "key:expired": 4 });
  assert.ok(!JSON.stringify(after).includes(`"${GID_A}"`) || at(`conversations/${A}/meta.json`)!.includes(GID_A), "the raw group id is only in the group's own meta.json (and the set-aside leftovers)");
  // voice-note sources: one file per conversation; a conversation that is not here is set aside whole
  assert.deepEqual(JSON.parse(at("conversations/owner/voices/sources.json")!), { notes: [{ ts: 1, id: "o.aac" }], quotes: { "10": 1 } });
  assert.deepEqual(JSON.parse(at("conversations/friend-anna-1a2b/voices/sources.json")!), { notes: [{ ts: 3, id: "an.aac" }], quotes: {} });
  assert.deepEqual(JSON.parse(at(`conversations/${A}/voices/sources.json`)!), { notes: [{ ts: 2, id: "ga.aac" }], quotes: { "20": 2 } });
  assert.deepEqual(JSON.parse(at("instance/migration-orphans/state/voice/sources.json")!), { notes: { "gone-group": [{ ts: 4, id: "gone.aac" }] }, quotes: { "gone-group": { "30": 4 } } });
  // set aside, listed, and found where the log says
  for (const o of [`state/pending-${UNKNOWN_HASH}.json`, "state/mystery.txt", "memory/stray.txt", "logs/group-ffffffffffff.jsonl", "logs/group-aaaaaaaaaaaa.jsonl", "tenants/notafolder.txt", "memory/groups/ffffffffffff/notes/lost.md", "state/voice/groups/deadbeefdeadbeef/voices/x/ref.wav"]) {
    assert.equal(at(`instance/migration-orphans/${o}`), before[o], o);
    assert.ok(log.some((l) => l.includes(o.split("/").slice(0, o.startsWith("memory/groups") ? 3 : o.startsWith("state/voice/groups") ? 4 : 2).join("/"))), `listed: ${o}`);
  }
  // the old places are empty or gone; what stays is installed software, the default clip and the logs
  assert.equal(existsSync(join(root, "memory")), false);
  assert.equal(existsSync(join(root, "tenants")), false);
  assert.deepEqual(readdirSync(join(root, "state")).sort(), ["openbao", "tts-qwen", "voice"]);
  assert.deepEqual(readdirSync(join(root, "state/voice")).sort(), ["ref.txt", "ref.wav"]);
  assert.deepEqual(readdirSync(join(root, "logs")).sort(), ["agent.log", "audit.jsonl", "launchd-stderr.log", "signal-daemon.log"]);
  assert.equal(at("state/openbao/config.hcl"), "listener");
  // not one byte of an old file is gone: every old file's content is somewhere in the new tree (the three rewritten JSON files and the split one aside)
  const rewritten = new Set(["state/group-cost.json", "state/cap-notices.json", "state/voice/sources.json"]);
  const newContents = new Set(Object.values(after));
  for (const [p, content] of Object.entries(before)) if (!p.endsWith("/") && !rewritten.has(p)) assert.ok(newContents.has(content), `kept: ${p}`);
  // recorded
  const plan = JSON.parse(readFileSync(L.instance.migrationPlan, "utf8")) as Plan;
  assert.ok(plan.completedAt && plan.ops.every((o) => o.done));
  assert.equal(readFileSync(L.instance.layoutVersion, "utf8"), "2\n");
  assert.ok(log.some((l) => /data folder is in layout version 2/.test(l)));
  assert.equal(existsSync(L.instance.migrationLock), false, "the lock is released");
});

test("idempotent: a second run, and a plan made afterwards, find nothing to do; nothing changes", () => {
  const root = old();
  migrate(root);
  const after = snapshot(root);
  const again = migrate(root);
  assert.equal(again.already, true);
  assert.deepEqual(snapshot(root), after);
  assert.equal(planMigration(root).ops.length, 0);
  assert.deepEqual(layoutState(root), { state: "current" });
  // even with the version removed, a re-run only re-stamps (every step looks at what is there)
  rmSync(layout(root).instance.layoutVersion);
  rmSync(layout(root).instance.migrationPlan);
  const r = migrate(root);
  assert.equal(r.moved, 0);
  assert.deepEqual(Object.keys(snapshot(root)).sort(), Object.keys(after).filter((k) => k !== "instance/migration-plan.json").sort());
});

test("a new, empty data folder is stamped at once and needs no plan", () => {
  const root = fresh();
  assert.deepEqual(layoutState(root), { state: "fresh" });
  const r = migrate(root);
  assert.equal(r.moved, 0);
  assert.equal(readVersion(root), LAYOUT_VERSION);
  assert.equal(existsSync(layout(root).instance.migrationPlan), false);
  assert.equal(ownerNotice(root), undefined, "nothing was reorganised, nothing to tell");
});

test("crash anywhere, resume from the stored plan: the result is the same tree as an uninterrupted run", () => {
  const whole = old();
  const full = moves(whole);
  const expected = tree(whole);
  const steps = full.plan!.ops.length;
  assert.ok(steps > 50, `a rich fixture (${steps} steps)`);
  for (const k of [1, 2, 3, 7, 12, 20, 33, Math.floor(steps / 2), steps - 5, steps - 2, steps - 1]) {
    const root = old();
    assert.throws(() => moves(root, { crashAfter: k }), /simulated crash/);
    assert.equal(readVersion(root), undefined, `no version after a crash at ${k}`);
    assert.deepEqual(layoutState(root), { state: "unmigrated" });
    const left = refusal(layoutState(root));
    assert.match(left!, /old layout/);
    const stored = JSON.parse(readFileSync(layout(root).instance.migrationPlan, "utf8")) as Plan;
    assert.equal(stored.ops.filter((o) => o.done).length, k, "progress is recorded after each step");
    const r = moves(root);
    assert.equal(r.moved, steps - k, `resumed at ${k}`);
    assert.deepEqual(tree(root), expected, `same tree after a crash at ${k}`);
  }
});

test("a crash between a move and its record is harmless: the step finds its target there and is done", () => {
  const root = old();
  const plan = planMigration(root);
  mkdirSync(join(root, "instance"), { recursive: true });
  writeFileSync(layout(root).instance.migrationPlan, JSON.stringify(plan)); // a stored plan with nothing marked done...
  const op = plan.ops.find((o) => o.kind === "move" && o.from.endsWith("state/paused"))!;
  mkdirSync(join(root, "instance"), { recursive: true });
  writeFileSync(op.to, readFileSync(op.from, "utf8")); // ...but this step happened (a copy is there; as after a rename whose record was lost, the source would be gone)
  rmSync(op.from);
  const r = moves(root);
  assert.equal(r.already, false);
  assert.equal(existsSync(op.to), true);
  assert.equal(readVersion(root), 2);
});

test("across devices: copy, fsync, verify, then delete, with the same result", () => {
  const a = old();
  moves(a);
  const b = old();
  moves(b, { forceCopy: true });
  assert.deepEqual(tree(b), tree(a));
});

test("a process-wide target that exists with other content is never overwritten: the source is set aside; an identical one is a verified duplicate; an empty skeleton is replaced (a conversation's data stops the migration: migrate-safety.test.ts)", () => {
  const root = old();
  const L = layout(root);
  mkdirSync(L.conv("owner").dir, { recursive: true });
  mkdirSync(L.instance.dir, { recursive: true });
  writeFileSync(L.instance.registrations, '{"new":"code wrote this"}'); // other content
  writeFileSync(L.conv("owner").dream, '{"day":"d"}'); // identical to the old one
  mkdirSync(L.conv("owner").notes, { recursive: true }); // the empty skeleton start-up makes
  const log: string[] = [];
  moves(root, { log: (l) => log.push(l) });
  assert.equal(readFileSync(L.instance.registrations, "utf8"), '{"new":"code wrote this"}', "not overwritten");
  assert.equal(readFileSync(join(L.instance.migrationOrphans, "state/registrations.json"), "utf8"), "{}", "the old one is kept apart");
  assert.ok(log.some((l) => l.includes("state/registrations.json") && l.includes("exists with other content")));
  assert.equal(readFileSync(L.conv("owner").dream, "utf8"), '{"day":"d"}');
  assert.equal(existsSync(join(root, "state/dream.json")), false, "the duplicate is gone after a verified compare");
  assert.equal(existsSync(join(L.conv("owner").notes, "style-x.md")), true, "the skeleton gave way to the notes");
});

test("what the migration REWRITES is copied first, byte for byte, into instance/migration-backup/<time>/ and kept; what it moves by rename needs no copy", () => {
  const root = old();
  const before = snapshot(root);
  const log: string[] = [];
  moves(root, { log: (l) => log.push(l) });
  const L = layout(root);
  const stamps = readdirSync(L.instance.migrationBackup);
  assert.equal(stamps.length, 1);
  const kept = snapshot(join(L.instance.migrationBackup, stamps[0]!));
  for (const f of ["state/group-cost.json", "state/cap-notices.json", "state/voice/sources.json"]) assert.equal(kept[f], before[f], `${f} is kept byte-identical`);
  assert.deepEqual(Object.keys(kept).filter((k) => !k.endsWith("/")).sort(), ["state/cap-notices.json", "state/group-cost.json", "state/voice/sources.json"], "only the rewritten ones");
  assert.ok(log.some((l) => l.includes("layout version 2") && l.includes(`instance/migration-backup/${stamps[0]}/`) && l.includes("migration-plan.json")), "the one-line summary names the folder and the plan");
  const plan = JSON.parse(readFileSync(L.instance.migrationPlan, "utf8")) as Plan;
  assert.equal(plan.backup, join(L.instance.migrationBackup, stamps[0]!));
  // a crash after the rewrite, then a resume: the same single backup folder, still the originals
  const r2 = old();
  assert.throws(() => moves(r2, { crashAfter: 50 }), /simulated crash/);
  moves(r2);
  const s2 = readdirSync(layout(r2).instance.migrationBackup);
  assert.equal(s2.length, 1);
  assert.equal(snapshot(join(layout(r2).instance.migrationBackup, s2[0]!))["state/group-cost.json"], before["state/group-cost.json"]);
  // nothing to rewrite, no backup folder, no mention
  const plain = fresh();
  buildOld(plain);
  rmSync(join(plain, "state/group-cost.json"));
  rmSync(join(plain, "state/cap-notices.json"));
  rmSync(join(plain, "state/voice/sources.json"));
  const log3: string[] = [];
  moves(plain, { log: (l) => log3.push(l) });
  assert.equal(existsSync(layout(plain).instance.migrationBackup), false);
  assert.ok(!log3.some((l) => l.includes("migration-backup")));
});

test("npm run doctor still runs on an old data folder: the layout line fails with what to do, the checks that need the new layout are skipped, nothing is moved", () => {
  const root = old();
  const before = snapshot(root);
  const r = run(["src/cli.ts", "doctor"], root);
  assert.equal(r.status, 1, "a failed check");
  assert.match(r.stdout, /FAIL\s+data layout\s+\(old data layout: start the agent once or run `npm run migrate`; `npm run migrate -- --dry-run` shows the plan/);
  for (const skipped of ["the owner's notes", "nightly dream", "heartbeat is ticking", "daily spend guard", "not paused", "setup notes"]) assert.doesNotMatch(r.stdout, new RegExp(skipped), skipped);
  assert.match(r.stdout, /Node 24\+/);
  const files = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.endsWith("/")));
  assert.deepEqual(files(snapshot(root)), files(before), "doctor moved nothing");
  assert.equal(run(["src/cli.ts", "report"], root).status, 1, "report still refuses");
  migrate(root);
  const ok = run(["src/cli.ts", "doctor"], root);
  assert.match(ok.stdout, /ok\s+data layout\s+\(version 3/);
  assert.match(ok.stdout, /the owner's notes/);
});

test("a source that cannot be copied faithfully is left where it is", () => {
  const dir = fresh();
  writeFileSync(join(dir, "a"), "x");
  writeFileSync(join(dir, "b"), "x");
  assert.equal(sameTree(join(dir, "a"), join(dir, "b")), true);
  writeFileSync(join(dir, "b"), "y");
  assert.equal(sameTree(join(dir, "a"), join(dir, "b")), false);
});

test("the two rewrites of keys: raw group ids become folder names, already-converted keys stay, sums are kept", () => {
  assert.deepEqual(rekeyGroupCost({ day: "d", usd: { [GID_A]: 1, [A]: 2, owner: 0.5 } }), { day: "d", usd: { [A]: 3, owner: 0.5 } });
  assert.deepEqual(rekeyCapNotices({ day: "d", keys: [`group:${GID_A}`, `group:${A}`, "friend:x"], at: { [`warn:tenant:bo-3c4d`]: 1, "warn:owner": 2 } }), { day: "d", keys: [`group:${A}`, "friend:x"], at: { "warn:friend-bo-3c4d": 1, "warn:owner": 2 } });
});

test("a migration holds the lock: a live other process keeps this one out, a dead one's lock is taken over", () => {
  const root = old();
  const L = layout(root);
  mkdirSync(L.instance.migrationLock, { recursive: true });
  writeFileSync(join(L.instance.migrationLock, "pid"), String(process.ppid)); // a live process that is not us
  assert.throws(() => migrate(root, {}, 0), /another process is migrating/);
  writeFileSync(join(L.instance.migrationLock, "pid"), "999999999"); // no such process
  assert.equal(migrate(root, {}, 0).already, false);
  assert.equal(existsSync(L.instance.migrationLock), false);
});

test("the owner is told once, in her chat, that storage was reorganised", () => {
  const root = old();
  assert.equal(ownerNotice(root), undefined, "not before it happened");
  migrate(root);
  assert.match(ownerNotice(root)!, /set aside, not deleted/, "this fixture has orphans, so she is told what went aside");
  assert.equal(ownerNotice(root), ownerNotice(root), "until it is marked as sent");
  markOwnerTold(root);
  assert.equal(ownerNotice(root), undefined);
  assert.doesNotMatch(REORGANISED_TEXT, /instance|conversations|\.json|\//, "no details: she does not need them");
});

// ---- the doors: a tool that does not migrate refuses, the agent migrates ----

const run = (args: string[], root: string, extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--conditions=workspace-source", ...args], { cwd: ROOT, env: { ...process.env, HARNESS_DATA_DIR: root, BROWSE_SKIP_INSTALL: "1", ...extra }, encoding: "utf8", timeout: 60_000 });
const guard = (file: string) => ["--input-type=module", "-e", `import ${JSON.stringify(new URL(`../${file}`, import.meta.url).href)}; console.log("went on");`];

test("refusal: the CLIs and the intake page stop on an old or a newer data folder, with a sentence; a migrated or new one goes on", () => {
  const oldRoot = old();
  for (const door of ["src/core/requirelayout.ts"]) {
    const r = run(guard(door), oldRoot);
    assert.equal(r.status, 1, door);
    assert.match(r.stderr, /old layout.*npm run migrate/s);
    assert.doesNotMatch(r.stdout, /went on/);
  }
  for (const script of ["src/cli.ts", "scripts/intake.ts", "scripts/tenants.ts", "scripts/card.ts", "scripts/profile.ts", "scripts/heartbeat-report.ts"]) {
    const r = run([script, "report"], oldRoot);
    assert.equal(r.status, 1, script);
    assert.match(r.stderr, /old layout.*npm run migrate/s, script);
  }
  const filesOf = (root: string) => Object.fromEntries(Object.entries(snapshot(root)).filter(([k]) => !k.endsWith("/"))); // (start-up makes empty folders; a file is never moved)
  assert.ok(Object.keys(filesOf(oldRoot)).length > 100 && sha(JSON.stringify(filesOf(oldRoot))) === sha(JSON.stringify(filesOf(old()))), "a refusing tool moved nothing");
  const newer = fresh();
  mkdirSync(join(newer, "instance"), { recursive: true });
  writeFileSync(join(newer, "instance/layout-version"), "4\n");
  const rn = run(guard("src/core/requirelayout.ts"), newer);
  assert.equal(rn.status, 1);
  assert.match(rn.stderr, /newer layout \(version 4\)/);
  const rm = run(guard("src/core/migrateatstart.ts"), newer);
  assert.equal(rm.status, 1, "the agent does not start on a newer layout either");
  assert.equal(readFileSync(join(newer, "instance/layout-version"), "utf8"), "4\n", "and leaves it alone");
  const ok = fresh();
  assert.equal(run(guard("src/core/requirelayout.ts"), ok).status, 0, "a new folder is fine");
  migrate(oldRoot);
  assert.equal(run(guard("src/core/requirelayout.ts"), oldRoot).stdout.trim(), "went on");
});

test("the agent migrates before anything reads the data: importing the start-up guard moves an old folder", () => {
  const root = old();
  const r = run(guard("src/core/migrateatstart.ts"), root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /migrate: starting/);
  assert.match(r.stdout, /layout version 2/);
  assert.equal(readVersion(root), 3);
  assert.equal(existsSync(join(root, "conversations/owner/notes/style-x.md")), true);
});

test("npm run migrate -- --dry-run prints the plan and moves nothing", () => {
  const root = old();
  const before = snapshot(root);
  const r = run(["scripts/migrate.ts", "--dry-run"], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /move\s+memory\/notes\s+->\s+conversations\/owner\/notes/);
  assert.match(r.stdout, /ORPHAN\s+state\/mystery.txt\s+->\s+instance\/migration-orphans\/state\/mystery.txt/);
  assert.match(r.stdout, /rekey\s+state\/group-cost.json/);
  assert.match(r.stdout, /step\(s\):/);
  assert.match(r.stdout, /import\s+instance\/cost.json\s+->\s+instance.db \(spend, notices\)/, "layout 3: the small files that go into instance.db are listed too");
  assert.match(r.stdout, /import\s+instance\/payments.jsonl\s+->\s+instance.db \(payments\)/);
  assert.match(r.stdout, /Dry run: nothing was moved\./);
  assert.deepEqual(snapshot(root), before);
  const real = run(["scripts/migrate.ts"], root);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /Done: \d+ step\(s\)/);
  assert.equal(readVersion(root), 3);
  assert.match(run(["scripts/migrate.ts"], root).stdout, /Already in the current layout/);
});
