import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// seen_mail (src/modules/seenmail/seenmail.ts): the mail a conversation's heartbeat run has worked through, as a bounded log of ids kept per conversation. The ids a call returns are pending
// until the look ends well; the run and its expert share the pending set; nothing about the mailbox or the provider is known to code.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "seenmail-test-"));

const { createSeenMail, createSeenMailServer, isBacklog, seenFileOf, SEEN_MAX } = await import("../src/modules/seenmail/seenmail.ts");
const { createHeartbeatLook } = await import("../src/heartbeat/look.ts");
const { heartbeatOptions } = await import("../src/run/agent.ts");
const { buildOptions } = await import("../src/run/agentrun.ts");
const { group, owner, tenant } = await import("../src/conversation/conversation.ts");
const { LOGIN } = await import("../src/tenants/payer.ts");
const T = await import("../src/tenants/tenants.ts");
const { settings } = await import("../src/core/settings.ts");
const { readJson } = await import("../src/core/state.ts");
const { recordMessage } = await import("../src/core/messages.ts");

const dir = join(settings.dataDir, "seenmail-files");
mkdirSync(dir, { recursive: true });
const file = (n: string) => join(dir, `${n}.json`);
const ids = (f: string): string[] => readJson<{ ids?: string[] }>(f, {}).ids ?? [];

test("the unseen subset: ids as the mail tool returned them, any provider; repeats and blanks are dropped; the committed log is remembered", () => {
  const f = file("a");
  const seen = createSeenMail(f);
  assert.deepEqual(seen.unseen(["c-1", "c-2", "c-2", " ", "18f3a"]), ["c-1", "c-2", "18f3a"]);
  assert.deepEqual(seen.unseen(["c-1", "c-3"]), ["c-1", "c-3"], "pending is not seen: the same look asking again gets the same answer");
  seen.commit();
  assert.deepEqual(ids(f), ["c-1", "c-2", "18f3a", "c-3"]);
  assert.deepEqual(seen.unseen(["c-1", "c-3", "c-4"]), ["c-4"], "the next look is told only about what is new");
  assert.deepEqual(createSeenMail(f).unseen(["c-2"]), [], "a restart keeps it: the log is a file");
});

test("pending versus committed: a failed or aborted look leaves its ids unseen, so an offline gap is worked off over successive looks", () => {
  const f = file("b");
  const first = createSeenMail(f);
  assert.equal(first.unseen(["m1", "m2", "m3"]).length, 3);
  assert.equal(first.pending(), 3);
  first.discard(); // the look failed
  assert.equal(existsSync(f), false, "nothing was written");
  const second = createSeenMail(f);
  assert.deepEqual(second.unseen(["m1", "m2", "m3", "m4"]), ["m1", "m2", "m3", "m4"], "all of it comes back");
  second.commit();
  assert.deepEqual(createSeenMail(f).unseen(["m1", "m4", "m5"]), ["m5"]);
});

test("the log is bounded: the newest SEEN_MAX ids stay, the oldest are forgotten", () => {
  const f = file("c");
  const seen = createSeenMail(f, 5);
  seen.unseen(["a", "b", "c", "d"]);
  seen.commit();
  seen.unseen(["e", "f", "g"]);
  seen.commit();
  assert.deepEqual(ids(f), ["c", "d", "e", "f", "g"]);
  assert.deepEqual(createSeenMail(f, 5).unseen(["a", "g"]), ["a"], "an id that fell off the log is new again");
  assert.equal(SEEN_MAX, 2000);
  const big = createSeenMail(file("d"));
  big.unseen(Array.from({ length: 500 }, (_, i) => `x${i}`));
  big.commit();
  assert.equal(ids(file("d")).length, 500);
});

test("per conversation: the owner's log, each friend's in her own folder; one never shows the other", () => {
  const rec = T.addTenant({ aci: "00000000-0000-4000-8000-0000000000c1", name: "Ana" })!;
  const rec2 = T.addTenant({ aci: "00000000-0000-4000-8000-0000000000c2", name: "Bo" })!;
  assert.equal(seenFileOf(owner()), "state/seen-mail.json");
  assert.equal(seenFileOf(tenant(rec.id)), join(T.tenantContext(rec).dir, "seen-mail.json"));
  assert.notEqual(seenFileOf(tenant(rec.id)), seenFileOf(tenant(rec2.id)));
  assert.ok(seenFileOf(group("seen-group-0123456789abcd")).endsWith("seen-mail.json"));
  const a = createSeenMail(seenFileOf(tenant(rec.id)));
  a.unseen(["same-id"]);
  a.commit();
  assert.deepEqual(createSeenMail(seenFileOf(tenant(rec2.id))).unseen(["same-id"]), ["same-id"], "Bo has not seen what Ana has");
  assert.deepEqual(createSeenMail(seenFileOf(tenant(rec.id))).unseen(["same-id"]), []);
});

test("the tool: reports the unseen ids, and the run and its expert share one pending set", async () => {
  const seen = createSeenMail(file("e"));
  const server = createSeenMailServer(seen) as unknown as { instance: { _registeredTools: Record<string, { handler: (a: { ids: string[] }) => Promise<{ content: { text: string }[] }> }> } };
  const call = (ids: string[]) => server.instance._registeredTools.seen_mail!.handler({ ids });
  assert.match((await call(["i1", "i2"])).content[0]!.text, /Not looked at yet \(2 of 2\):\ni1\ni2/);
  assert.match((await call(["i2", "i3"])).content[0]!.text, /Not looked at yet \(2 of 2\):\ni2\ni3/, "the expert asks through the same server: pending ids are still new within the look");
  assert.equal(seen.pending(), 3);
  seen.commit();
  assert.match((await call(["i1", "i2", "i3"])).content[0]!.text, /Nothing new/);
});

test("the heartbeat run is given the tracker only where there is mail, and the expert shares the run's server", () => {
  const ana = T.addTenant({ aci: "00000000-0000-4000-8000-0000000000c3", name: "Cy" })!;
  T.provision(ana);
  const tracker = createSeenMail(file("f"));
  const g = group("seen-group-1123456789abcd");
  const og = heartbeatOptions(g, LOGIN, { seenMail: tracker });
  assert.equal(og.seenMail, undefined, "a group has no mail");
  const owned = heartbeatOptions(owner(), LOGIN, { seenMail: tracker });
  assert.equal(owned.seenMail, tracker);
  const servers = Object.keys(buildOptions(async () => ({ approved: false }), owned, undefined).mcpServers as object);
  assert.ok(servers.includes("seenmail") && servers.includes("send"));
  assert.ok(!Object.keys(buildOptions(async () => ({ approved: false }), { ...owned, seenMail: undefined }, undefined).mcpServers as object).includes("seenmail"), "no tracker, no tool: a chat turn never has it");
});

// ---- the look commits or discards ----

function look(run: () => Promise<{ text: string; structured?: unknown }>) {
  const conv = { ...owner(), logFile: `logs/seen-look-${Math.random().toString(36).slice(2)}.jsonl` };
  const f = seenFileOf(conv);
  const pipeline = {
    enqueue: <X>(_c: unknown, job: () => Promise<X>) => job(),
    record: () => {},
    busy: () => false, sendWhile: async (_c: unknown, r: () => Promise<unknown>) => r(),
    runTurn: async (_c: unknown, turn: { run: () => Promise<unknown> }) => (await turn.run(), { spoke: true }),
  };
  const hb = createHeartbeatLook({ pipeline: pipeline as never, run: (async (_c: unknown, _p: unknown, _prompt: string, extra: { seenMail: { unseen: (i: string[]) => string[] } }) => (extra.seenMail.unseen(["look-1", "look-2"]), run())) as never, may: () => LOGIN, why: () => "x", notesChangedAt: () => 0, rowsFile: join(dir, "rows.jsonl") });
  recordMessage("owner", Date.now(), "hi", new Date(), conv.logFile);
  return { hb, conv, f };
}

test("a look that ends well commits what it was told was new; a look that fails leaves it unseen", async () => {
  const quiet = { text: "", structured: { message: "[[silent]]", nextCheckMinutes: 30 } };
  const err = console.error;
  console.error = () => {};
  try {
    const bad = look(async () => {
      throw new Error("boom");
    });
    assert.equal(await bad.hb.look(bad.conv, {} as never, new Date()), "failed");
    const before = ids(bad.f);
    assert.ok(!before.includes("look-1"), "failed: still unseen");
    const good = look(async () => quiet);
    assert.equal(await good.hb.look(good.conv, {} as never, new Date()), "silent");
    assert.deepEqual(ids(good.f).slice(-2), ["look-1", "look-2"], "silent but fine: seen from now on");
  } finally {
    console.error = err;
  }
  assert.equal(readFileSync(join(dir, "rows.jsonl"), "utf8").trim().split("\n").length, 2);
});

test("the first run does not triage the backlog: mail older than MAIL_BACKLOG_DAYS is marked seen unread, later runs are not affected", () => {
  const NOW = Date.parse("2026-10-20T12:00:00Z");
  assert.equal(isBacklog("2026-10-01T09:00:00Z", NOW, 7), true);
  assert.equal(isBacklog("2026-10-18T09:00:00Z", NOW, 7), false);
  assert.equal(isBacklog("not a date", NOW, 7), false, "an unreadable date is triaged, not skipped");
  assert.equal(isBacklog(undefined, NOW, 7), false);
  assert.equal(isBacklog("2020-01-01T00:00:00Z", NOW, 0), false, "0 days: the cutoff is off");
  const f = file("backlog");
  const first = createSeenMail(f, SEEN_MAX, 7, () => NOW);
  const received = { old1: "2026-09-01T00:00:00Z", old2: "2026-10-10T00:00:00Z", fresh: "2026-10-19T08:00:00Z" };
  assert.deepEqual(first.unseen(["old1", "old2", "fresh", "nodate"], received), ["fresh", "nodate"]);
  assert.equal(first.aged(), 2);
  assert.deepEqual(first.unseen(["old1", "fresh"], received), ["fresh"], "asking again within the look gives the same answer");
  first.commit();
  assert.deepEqual(ids(f).sort(), ["fresh", "nodate", "old1", "old2"].sort());
  // from now on a log exists: an old mail that turns up unseen is an ordinary new mail
  const second = createSeenMail(f, SEEN_MAX, 7, () => NOW);
  assert.deepEqual(second.unseen(["older", "fresh"], { older: "2026-01-01T00:00:00Z" }), ["older"]);
  assert.equal(second.aged(), 0);
});

test("seen_mail tells the run, once, how many old mails it skipped on the first look", async () => {
  const f = file("backlog-tool");
  const seen = createSeenMail(f, SEEN_MAX, 7, () => Date.parse("2026-10-20T12:00:00Z"));
  const server = createSeenMailServer(seen) as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown) => Promise<{ content: { text: string }[] }> }> } };
  const out = await server.instance._registeredTools.seen_mail!.handler({ ids: ["a", "b"], received: { a: "2026-01-01T00:00:00Z", b: "2026-10-19T00:00:00Z" } });
  assert.match(out.content[0]!.text, /Not looked at yet \(1 of 2\):\nb/);
  assert.match(out.content[0]!.text, /first look: 1 mail\(s\) older than 7 days were marked as looked at/);
});
