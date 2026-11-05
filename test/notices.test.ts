import { test } from "node:test";
import assert from "node:assert/strict";
import { owner } from "../src/conversation/conversationmodel.ts";
import { clearQuiet, setQuiet } from "../src/conversation/quiet.ts";
import { settings } from "../src/core/settings.ts";
import { instanceDb } from "../src/core/instancedb.ts";
import { createFailureTracker, observeLook, dropUnreachable, heldPosts, heldWaiting, resetHeld, planFlush, planPost, stillTrue, submitPost, takeHeld } from "../src/heartbeat/notices.ts";
import { heldBlock, HELD_MAX } from "../src/heartbeat/facts.ts";
import { group, type Conversation } from "../src/conversation/conversation.ts";
import { systemZone } from "../src/core/timezone.ts";
import { scratchLog } from "./scratch.ts";
import { friendConvId } from "../src/core/convpaths.ts";
import { AuthError, causeOf, InstanceKeyError, noticeFor, RateLimitError } from "../src/tenants/errors.ts";
import { RunTimeout } from "../src/run/ceiling.ts";
import { parseHeartbeatAnswer } from "../src/run/rules.ts";
import { ledgerEntries } from "../src/core/messages.ts";
import { gateSink, sendNow, withSend } from "../src/modules/send/send.ts";
import { holdFact } from "../src/core/ownerfact.ts";
import { refusal, refusalOnce } from "../src/tenants/errors.ts";
import { errorLinesSince } from "../src/core/logwindow.ts";
import { groupConvId } from "../src/core/convpaths.ts";

const s = settings as unknown as Record<string, unknown>;
s.quietStartHour = 22;
s.quietEndHour = 7;
const DAY = new Date(2026, 9, 14, 14, 0, 0);
const NIGHT = new Date(2026, 9, 14, 23, 30, 0);
const MORNING = new Date(2026, 9, 15, 7, 30, 0);
const EARLY = new Date(2026, 9, 15, 5, 30, 0); // quiet hours on the morning's own day
const reset = () => resetHeld(owner());
const min = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

test("planPost: urgent always goes, the quiet window holds", () => {
  assert.equal(planPost({ urgent: true, night: true }), "post");
  assert.equal(planPost({ urgent: false, night: true }), "hold");
  assert.equal(planPost({ urgent: false, night: false }), "post");
});

test("a scheduled post (a due routine) goes in the quiet window, not under /quiet; an ordinary one is held; there is no daily limit", () => {
  const c = owner();
  reset();
  assert.equal(submitPost(c, "the 22:00 quiz", false, NIGHT, true), "post");
  assert.equal(submitPost(c, "other news", false, NIGHT), "held");
  for (let i = 0; i < 30; i++) assert.equal(submitPost(c, `news ${i}`, false, DAY), "post", "no cap");
  setQuiet(c, new Date(NIGHT.getTime() + 3_600_000).toISOString());
  assert.equal(submitPost(c, "the 22:00 quiz again", false, NIGHT, true), "held", "/quiet holds a scheduled post too");
  clearQuiet(c);
  reset();
});

test("planFlush: only outside the quiet window and with something held", () => {
  assert.equal(planFlush({ night: false, held: 2 }), true);
  assert.equal(planFlush({ night: true, held: 2 }), false);
  assert.equal(planFlush({ night: false, held: 0 }), false);
});

test("the heartbeat answer's urgent flag: only a literal true on a real message", () => {
  assert.equal(parseHeartbeatAnswer({ message: "hi", nextCheckMinutes: 30, urgent: true }, "").urgent, true);
  assert.equal(parseHeartbeatAnswer({ message: "hi", nextCheckMinutes: 30, urgent: "true" }, "").urgent, false);
  assert.equal(parseHeartbeatAnswer({ message: "hi", nextCheckMinutes: 30 }, "").urgent, false);
  assert.equal(parseHeartbeatAnswer({ message: "[[silent]]", nextCheckMinutes: 30, urgent: true }, "").urgent, false);
});

test("held posts: night holds, day posts; at the end of quiet the look is due and gets all of them once, newest first", () => {
  reset();
  const c = owner();
  assert.equal(submitPost(c, "mail from the bank", false, EARLY), "held");
  assert.equal(submitPost(c, "mail from the bank", false, EARLY), "held", "the same text is not held twice");
  assert.equal(submitPost(c, "meeting in 10 minutes", true, EARLY), "post", "urgent goes at night");
  assert.equal(submitPost(c, "a reminder", false, EARLY), "held");
  assert.equal(heldWaiting(c, EARLY), false, "still the quiet window");
  assert.deepEqual(takeHeld(c, EARLY).held, [], "a night look does not get them");
  assert.equal(heldWaiting(c, MORNING), true, "quiet is over: the look is due");
  const first = takeHeld(c, MORNING);
  assert.deepEqual(first.held.map((h) => h.text), ["a reminder", "mail from the bank"]);
  assert.equal(heldPosts(c).length, 2, "pending while the look runs: a failed look leaves them for the next");
  assert.deepEqual(takeHeld(c, MORNING).held.map((h) => h.text), ["a reminder", "mail from the bank"]);
  first.done(); // (the look ended well)
  assert.deepEqual(takeHeld(c, MORNING).held, [], "exactly once");
  assert.equal(heldWaiting(c, MORNING), false);
  assert.deepEqual(heldPosts(c), []);
});
test("held posts as facts: written-when wording, capped, trimmed; a conversation without a look drops them with a journal line", () => {
  reset();
  const c = { ...owner(), logFile: scratchLog(`held-${Math.random().toString(36).slice(2)}.jsonl`) };
  const EVENING = new Date(2026, 9, 14, 22, 35, 0);
  submitPost(c, "older post", false, EVENING);
  submitPost(c, "newer post", false, min(EVENING, 20));
  const taken = takeHeld(c, MORNING).held;
  assert.deepEqual(taken.map((h) => h.text), ["newer post", "older post"]);
  assert.equal(heldBlock(taken, MORNING, systemZone()), `<held_posts>\nHeld back and not sent (written 22:55 yesterday): "newer post"\nHeld back and not sent (written 22:35 yesterday): "older post"\n</held_posts>\nThese were not delivered. Say again only what is still true and still matters now, in today's words; anything outdated or already resolved (check the journal, the brief status line, the chat log) you drop silently.`);
  assert.match(heldBlock([{ text: "x", at: MORNING.getTime() - 3_600_000 }], MORNING, systemZone()), /written 06:30 today/);
  assert.equal(heldBlock([], MORNING, systemZone()), "");
  assert.equal(heldBlock(Array.from({ length: 12 }, (_, i) => ({ text: `p${i} ${"x".repeat(600)}`, at: EVENING.getTime() })), MORNING, systemZone()).split("Held back").length - 1, HELD_MAX, "capped");
  reset();
  submitPost(c, "one", false, EVENING);
  submitPost(c, "two", false, EVENING);
  dropUnreachable(c);
  assert.deepEqual(heldPosts(c), []);
  assert.ok(ledgerEntries().some((e) => e.kind === "journal" && /Dropped 2 held message\(s\): this conversation has no look/.test(e.text)), "journaled");
});
test("held posts are each conversation's own: a group's and a friend's are handed to their own look only", () => {
  reset();
  const g = { ...group("g-overnight"), logFile: scratchLog(`g-${Math.random().toString(36).slice(2)}.jsonl`) };
  const f = { ...owner(), kind: "tenant" as const, key: "tenant:mia-o1", convId: friendConvId("mia-o1"), tenantId: "mia-o1", logFile: scratchLog(`f-${Math.random().toString(36).slice(2)}.jsonl`) } as Conversation;
  const o = { ...owner(), logFile: scratchLog(`o-${Math.random().toString(36).slice(2)}.jsonl`) };
  for (const c of [g, f]) resetHeld(c);
  const EVENING = new Date(2026, 9, 14, 22, 35, 0);
  submitPost(o, "owner's post", false, EVENING);
  submitPost(g, "group's post", false, EVENING);
  submitPost(f, "friend's post", false, EVENING);
  assert.deepEqual(takeHeld(g, MORNING).held.map((h) => h.text), ["group's post"]);
  assert.deepEqual(takeHeld(f, MORNING).held.map((h) => h.text), ["friend's post"]);
  assert.deepEqual(takeHeld(o, MORNING).held.map((h) => h.text), ["owner's post"]);
});

test("failure tracker: the owner's looks become a fact only after 3 failures over 2 hours AWAKE; sleep does not count; a success ends it without a word", () => {
  const H = 3_600_000;
  const T = 1_000_000_000_000;
  const t = createFailureTracker();
  t.observe("owner", "owner", true, "connector", T, 0);
  t.observe("owner", "owner", true, "connector", T + 600_000, 0.2 * H);
  t.observe("owner", "owner", true, "connector", T + 1_200_000, 0.4 * H);
  assert.equal(t.fact("owner"), "", "three failures, but only 24 minutes awake");
  t.observe("owner", "owner", true, "connector", T + 2.5 * H, 2.1 * H);
  const fact = t.fact("owner");
  assert.match(fact, /failed 4 times in a row/);
  assert.match(fact, /Connectors/);
  assert.match(fact, /system status/);
  t.observe("owner", "owner", false, undefined, T + 3 * H, 2.5 * H);
  assert.equal(t.fact("owner"), "", "a look that works ends it: no 'back to normal' anywhere");
  // a night asleep between failures: ten hours on the wall clock, minutes on the monotonic one
  const n = createFailureTracker();
  for (let i = 0; i < 5; i++) n.observe("owner", "owner", true, "connector", T + i * 2.5 * H, i * 60_000);
  assert.equal(n.fact("owner"), "", "the Mac slept through most of it");
  // groups and friends are never tracked for anyone's chat
  const g = createFailureTracker({ fails: 1, awakeMs: 0 });
  g.observe("g1", "group", true, "timeout", T, 0);
  g.observe("tenant:mara", "tenant", true, "timeout", T, 0);
  assert.equal(g.fact("g1") + g.fact("tenant:mara"), "");
});

test("causeOf and the owner's failure messages: login, limit, timeout, connector, the rest", () => {
  assert.equal(causeOf(new AuthError("x")), "login");
  assert.equal(causeOf(new RateLimitError("x")), "limit");
  assert.equal(causeOf(new InstanceKeyError("billing")), "billing");
  assert.equal(causeOf(new RunTimeout(60_000)), "timeout");
  assert.equal(causeOf(new Error("MCP server notion failed to connect")), "connector");
  assert.equal(causeOf(new Error("fetch failed")), "connector");
  assert.equal(causeOf(new Error("agent turn ended with error_during_execution")), "other");
  assert.match(noticeFor("owner")(new RunTimeout(60_000))!, /too long.*RUN_MAX_MINUTES_CHAT/);
  assert.match(noticeFor("owner")(new Error("mcp connector down"))!, /npm run doctor/);
  assert.match(noticeFor("owner")(new Error("x"))!, /Check the logs/);
  // a run that merely failed: one short line for a friend or a group, nothing about the cause (the log and doctor say it)
  assert.equal(noticeFor("friend")(new RunTimeout(60_000)), "⚠️ Something went wrong, try again.");
  assert.equal(noticeFor("group")(new Error("mcp connector down")), "⚠️ Something went wrong, try again.");
  assert.equal(noticeFor("friend")(new Error("x")), "⚠️ Something went wrong, try again.");
});

test("a group and a friend are refused from the one table and throttled the same way", () => {
  instanceDb().run("DELETE FROM told");
  for (const [audience, id] of [["group", groupConvId("g1")], ["friend", "friend-ann"]] as const) {
    const o = { until: "10:00" };
    const said = refusalOnce("cooldown", audience, id, o, DAY.getTime());
    assert.equal(said, refusal("cooldown", audience, o), audience);
    assert.equal(refusalOnce("cooldown", audience, id, o, DAY.getTime()), undefined, `${audience}: not again within the interval`);
    assert.notEqual(refusalOnce("cooldown", audience, `${id}-other`, o, DAY.getTime()), undefined, `${audience}: another has its own`);
    assert.notEqual(refusalOnce("cooldown", audience, id, o, MORNING.getTime()), undefined, `${audience}: the next day`);
  }
  assert.doesNotMatch(refusal("cooldown", "group", { until: "10:00" })!, /\.env|npm/, "nobody in a group is sent to a terminal");
});

test("the doctor's error window: dates are rebuilt from the file's time, so yesterday's errors do not count", () => {
  const mtime = new Date(2026, 9, 15, 0, 20, 0).getTime();
  const log = ["23:10:00.000 ERR yesterday evening", "23:50:00.000 ERR yesterday, within the hour", "23:55:00.000 fine", "00:10:00.000 ERR just now", "    at stack frame", "00:15:00.000 WARN fine"].join("\n");
  assert.equal(errorLinesSince(log, mtime, mtime - 3600_000), 2, "23:50 and 00:10, not 23:10");
  // old text comparison would have said: 00:20 minus an hour = 23:20, and "00:10" < "23:20" lost the newest error
  assert.equal(errorLinesSince("", mtime, mtime - 3600_000), 0);
  assert.equal(errorLinesSince(log, mtime, mtime - 24 * 3600_000), 3);
});


test("held items are checked before they are handed over: anything held for over a day and a half is no longer news", () => {
  const old = [{ text: "x", why: "quiet" as const, at: NIGHT.getTime() }];
  assert.equal(stillTrue(old, NIGHT.getTime() + 37 * 3_600_000).length, 0);
  assert.equal(stillTrue(old, NIGHT.getTime() + 3_600_000).length, 1);
  assert.equal(stillTrue([{ text: "y" as const }], 1e15).length, 1, "a row without a time is kept");
});
test("the send tool of an unattended look is held at 02:00 unless urgent; a chat turn's sink is never gated", async () => {
  reset();
  const c = owner();
  const AT = new Date(2026, 9, 14, 2, 0, 0);
  const delivered: string[] = [];
  const sink = async (x: any) => (delivered.push(x.text), "sent");
  const gate = (text: string, urgent: boolean) => (submitPost(c, text, urgent, AT) === "held" ? "held for later" : undefined);
  const told = await withSend("owner", sink, async () => {
    gateSink("owner", gate);
    return [await sendNow("owner", { text: "morning news" }), await sendNow("owner", { text: "fire!", urgent: true })];
  });
  assert.deepEqual(told, ["held for later", "sent"]);
  assert.deepEqual(delivered, ["fire!"]);
  assert.equal(heldPosts(c)[0]?.text, "morning news");
  const chat: string[] = [];
  await withSend("owner", async (x: any) => (chat.push(x.text), "sent"), () => sendNow("owner", { text: "hello" }));
  assert.deepEqual(chat, ["hello"], "no gate on another run's sink");
});

test("a system matter for the owner (the shared key, a friend's damaged file) is a fact for her next look, never a ping at night", () => {
  reset();
  holdFact("The shared API key was refused.", NIGHT);
  holdFact("The shared API key was refused.", NIGHT);
  assert.equal(heldPosts(owner()).length, 1, "once");
  assert.deepEqual(takeHeld(owner(), NIGHT).held, [], "not during quiet");
  const t = takeHeld(owner(), MORNING);
  assert.match(t.held[0]!.text, /^System status for .*The shared API key was refused\.$/);
  t.done();
  reset();
});

test("observeLook: a login that stops every run is told to the owner once per streak, after 3 failures, not in quiet hours", async () => {
  const o = { ...owner(), logFile: scratchLog(`ol-${Math.random().toString(36).slice(2)}.jsonl`) };
  const sent: string[] = [];
  let sendError: unknown;
  const pipeline = {
    enqueue: <X,>(_c: unknown, job: () => Promise<X>) => job(),
    runTurn: async (_c: unknown, t: { run: () => Promise<{ text: string }> }) => {
      sent.push((await t.run()).text);
      if (sendError) throw sendError;
      return { spoke: true };
    },
  } as never;
  const DAY = new Date(2026, 9, 15, 12, 0, 0);
  const NIGHT = new Date(2026, 9, 14, 22, 35, 0);
  const fail = (e: unknown, at = DAY) => observeLook(pipeline, o, "failed", e, at, 0);
  await observeLook(pipeline, o, "silent", undefined, DAY, 0); // a clean start
  await fail(new AuthError("x"));
  await fail(new AuthError("x"));
  assert.equal(sent.length, 0, "not at 2");
  await fail(new AuthError("x"));
  assert.deepEqual(sent, [refusal("login", "owner")]);
  await fail(new AuthError("x"));
  assert.equal(sent.length, 1, "once per streak");
  // a good look ends it; the next streak tells again
  await observeLook(pipeline, o, "silent", undefined, DAY, 0);
  for (let i = 0; i < 3; i++) await fail(new AuthError("x"));
  assert.equal(sent.length, 2);
  // quiet hours hold it; the first failing look after quiet sends it
  await observeLook(pipeline, o, "silent", undefined, DAY, 0);
  for (let i = 0; i < 4; i++) await fail(new AuthError("x"), NIGHT);
  assert.equal(sent.length, 2, "held at night");
  await fail(new AuthError("x"), MORNING);
  assert.equal(sent.length, 3);
  // other causes are never told
  await observeLook(pipeline, o, "silent", undefined, DAY, 0);
  for (let i = 0; i < 5; i++) await fail(new RunTimeout(60_000));
  for (let i = 0; i < 5; i++) await fail(new Error("fetch failed"));
  assert.equal(sent.length, 3);
  // a send that failed is tried again, but not one that may have gone out
  await observeLook(pipeline, o, "silent", undefined, DAY, 0);
  sendError = new Error("Failed to send message");
  for (let i = 0; i < 3; i++) await fail(new AuthError("x"));
  assert.equal(sent.length, 4);
  await fail(new AuthError("x"));
  assert.equal(sent.length, 5, "refused: tried again");
  sendError = new Error("socket closed");
  await fail(new AuthError("x"));
  assert.equal(sent.length, 6);
  await fail(new AuthError("x"));
  assert.equal(sent.length, 6, "unsure: not repeated");
});
