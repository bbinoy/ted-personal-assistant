import { test } from "node:test";
import assert from "node:assert/strict";
import { owner } from "../src/conversation/conversationmodel.ts";
import { settings } from "../src/core/settings.ts";
import { localDay } from "../src/core/pause.ts";
import { GROUP_BUDGET_TEXT, groupBudgetDue, recordCost } from "../src/core/budget.ts";
import { instanceDb } from "../src/core/instancedb.ts";
import { combine, createFailureTracker, heldPosts, resetHeld, noticeBudget, noticeOwner, ownerNotices, overnightWaiting, planFlush, planPost, releaseHeld, stillTrue, submitPost, countPosts, takeOvernight } from "../src/heartbeat/notices.ts";
import { overnightBlock, OVERNIGHT_MAX } from "../src/heartbeat/look.ts";
import { group, type Conversation } from "../src/conversation/conversation.ts";
import { systemZone } from "../src/core/timezone.ts";
import { scratchLog } from "./scratch.ts";
import { friendConvId } from "../src/core/convpaths.ts";
import { AuthError, causeOf, InstanceKeyError, noticeFor, RateLimitError } from "../src/tenants/errors.ts";
import { RunTimeout } from "../src/run/ceiling.ts";
import { parseHeartbeatAnswer } from "../src/run/rules.ts";
import { ledgerEntries, recordMessage } from "../src/core/messages.ts";
import { gateSink, sendNow, withSend } from "../src/modules/send/send.ts";
import { capNoticesTo, reportInstanceCap } from "../src/core/capnotice.ts";
import { errorLinesSince } from "../src/core/logwindow.ts";
import { groupConvId } from "../src/core/convpaths.ts";

const s = settings as unknown as Record<string, unknown>;
s.quietStartHour = 22;
s.quietEndHour = 7;
s.maxUnpromptedPerDay = 3;
const DAY = new Date(2026, 9, 14, 14, 0, 0);
const NIGHT = new Date(2026, 9, 14, 23, 30, 0);
const MORNING = new Date(2026, 9, 15, 7, 30, 0);
const EARLY = new Date(2026, 9, 15, 5, 30, 0); // quiet hours on the morning's own day
const reset = () => resetHeld(owner());
const pipe = (sent: string[]) => ({ enqueue: <T>(_c: unknown, job: () => Promise<T>) => job(), runTurn: async (_c: unknown, t: any) => (sent.push((await t.run()).text), { spoke: true }) }) as any;
const min = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

test("planPost: urgent always goes, the quiet window holds, then the day's cap", () => {
  assert.equal(planPost({ urgent: true, night: true, posted: 99, cap: 6 }), "post");
  assert.equal(planPost({ urgent: false, night: true, posted: 0, cap: 6 }), "hold-quiet");
  assert.equal(planPost({ urgent: false, night: false, posted: 5, cap: 6 }), "post");
  assert.equal(planPost({ urgent: false, night: false, posted: 6, cap: 6 }), "hold-cap");
  assert.equal(planPost({ urgent: false, night: true, posted: 6, cap: 6 }), "hold-quiet");
});

test("planFlush: only outside the quiet window, with something held and the cap not spent", () => {
  assert.equal(planFlush({ night: false, posted: 0, cap: 6, held: 2 }), true);
  assert.equal(planFlush({ night: true, posted: 0, cap: 6, held: 2 }), false);
  assert.equal(planFlush({ night: false, posted: 6, cap: 6, held: 2 }), false);
  assert.equal(planFlush({ night: false, posted: 0, cap: 6, held: 0 }), false);
});

test("combine: one held post as it is, several as a short list", () => {
  assert.equal(combine([{ text: "a", why: "quiet" }]), "a");
  assert.equal(combine([{ text: "a", why: "quiet" }, { text: "b\nc", why: "cap" }]), "A few things I held back:\n- b c\n- a", "newest first (the digest, digest.ts)");
});

test("the heartbeat answer's urgent flag: only a literal true on a real message", () => {
  assert.equal(parseHeartbeatAnswer({ message: "hi", nextCheckMinutes: 30, urgent: true }, "").urgent, true);
  assert.equal(parseHeartbeatAnswer({ message: "hi", nextCheckMinutes: 30, urgent: "true" }, "").urgent, false);
  assert.equal(parseHeartbeatAnswer({ message: "hi", nextCheckMinutes: 30 }, "").urgent, false);
  assert.equal(parseHeartbeatAnswer({ message: "[[silent]]", nextCheckMinutes: 30, urgent: true }, "").urgent, false);
});

test("held posts: night holds, day posts, the cap holds the rest, and one combined message goes out when it may (held on the morning's own day)", async () => {
  reset();
  const c = owner();
  assert.equal(submitPost(c, "mail from the bank", false, EARLY), "held");
  assert.equal(submitPost(c, "mail from the bank", false, EARLY), "held", "the same text is not held twice");
  assert.equal(submitPost(c, "meeting in 10 minutes", true, EARLY), "post", "urgent goes at night");
  assert.equal(submitPost(c, "a reminder", false, EARLY), "held");
  const sent: string[] = [];
  const pipeline = { enqueue: <T>(_c: unknown, job: () => Promise<T>) => job(), runTurn: async (_c: unknown, t: any) => (sent.push((await t.run()).text), { spoke: true }) } as any;
  assert.equal(await releaseHeld(pipeline, c, EARLY), false, "still the quiet window");
  assert.equal(await releaseHeld(pipeline, c, MORNING), true);
  assert.deepEqual(sent, ["A few things I held back:\n- a reminder\n- mail from the bank"]);
  assert.equal(await releaseHeld(pipeline, c, MORNING), false, "nothing left");
  assert.deepEqual(heldPosts(c), []);
});

test("the day's cap: the posts past it are held for the next day, urgent ones are exempt, pieces sent while working count", async () => {
  reset();
  const c = owner();
  countPosts(c, 1, DAY);
  assert.equal(submitPost(c, "one", false, DAY), "post");
  assert.equal(submitPost(c, "two", false, DAY), "post");
  assert.equal(submitPost(c, "three", false, DAY), "held", "3 a day in this test");
  assert.equal(submitPost(c, "urgent", true, DAY), "post");
  const sent: string[] = [];
  const pipeline = { enqueue: <T>(_c: unknown, job: () => Promise<T>) => job(), runTurn: async (_c: unknown, t: any) => (sent.push((await t.run()).text), { spoke: true }) } as any;
  assert.equal(await releaseHeld(pipeline, c, new Date(2026, 9, 14, 15, 0)), false, "the same day: the cap is still spent");
  assert.equal(await releaseHeld(pipeline, c, new Date(2026, 9, 15, 9, 0)), false, "the next morning: yesterday's post is not sent as it was written");
  assert.deepEqual(sent, []);
  assert.deepEqual(takeOvernight(c, new Date(2026, 9, 15, 9, 0)).map((h) => h.text), ["three"], "it waits for the next look");
});

test("a post of an earlier day: kept for the look (not during quiet), taken once newest first, dropped with a journal line where there is no look", async () => {
  reset();
  const c = { ...owner(), logFile: scratchLog(`held-${Math.random().toString(36).slice(2)}.jsonl`) };
  const EVENING = new Date(2026, 9, 14, 22, 35, 0);
  submitPost(c, "older post", false, EVENING);
  submitPost(c, "newer post", false, min(EVENING, 20));
  noticeOwner("something failed", EVENING);
  const sent: string[] = [];
  assert.equal(overnightWaiting(c, min(EVENING, 120)), false, "still quiet hours after midnight");
  assert.deepEqual(takeOvernight(c, min(EVENING, 120)), [], "a night look does not get them");
  assert.equal(await releaseHeld(pipe(sent), c, MORNING), true);
  assert.deepEqual(sent, ["something failed"], "a system notice keeps its own rule; the posts are not in it");
  assert.equal(overnightWaiting(c, MORNING), true, "the look is due");
  const taken = takeOvernight(c, MORNING);
  assert.deepEqual(taken.map((h) => h.text), ["newer post", "older post"]);
  assert.deepEqual(takeOvernight(c, MORNING), [], "exactly once");
  assert.equal(overnightWaiting(c, MORNING), false);
  assert.equal(overnightBlock(taken, MORNING, systemZone()), `<held_overnight>\nHeld overnight and not sent (written 22:55 yesterday): "newer post"\nHeld overnight and not sent (written 22:35 yesterday): "older post"\n</held_overnight>\nThese were not delivered. Say again only what is still true and still matters today, in today's words; anything outdated or already resolved (check the journal, the brief status line, the chat log) you drop silently.`);
  assert.equal(overnightBlock([], MORNING, systemZone()), "");
  assert.equal(overnightBlock(Array.from({ length: 9 }, (_, i) => ({ text: `p${i} ${"x".repeat(600)}`, at: EVENING.getTime() })), MORNING, systemZone()).split("Held overnight").length - 1, OVERNIGHT_MAX, "capped");
  // a conversation without a look: dropped, never sent verbatim, and the journal says how many
  reset();
  submitPost(c, "one", false, EVENING);
  submitPost(c, "two", false, EVENING);
  assert.equal(await releaseHeld(pipe(sent), c, MORNING, { looks: false }), false);
  assert.deepEqual(heldPosts(c), []);
  assert.ok(ledgerEntries().some((e) => e.kind === "journal" && /Dropped 2 held message\(s\) from yesterday/.test(e.text)), "journaled");
});

test("overnight posts are each conversation's own: a group's and a friend's are handed to their own look only", () => {
  reset();
  const g = { ...group("g-overnight"), logFile: scratchLog(`g-${Math.random().toString(36).slice(2)}.jsonl`) };
  const f = { ...owner(), kind: "tenant" as const, key: "tenant:mia-o1", convId: friendConvId("mia-o1"), tenantId: "mia-o1", logFile: scratchLog(`f-${Math.random().toString(36).slice(2)}.jsonl`) } as Conversation;
  const o = { ...owner(), logFile: scratchLog(`o-${Math.random().toString(36).slice(2)}.jsonl`) };
  for (const c of [g, f]) resetHeld(c);
  const EVENING = new Date(2026, 9, 14, 22, 35, 0);
  submitPost(o, "owner's post", false, EVENING);
  submitPost(g, "group's post", false, EVENING);
  submitPost(f, "friend's post", false, EVENING);
  assert.deepEqual(takeOvernight(g, MORNING).map((h) => h.text), ["group's post"]);
  assert.deepEqual(takeOvernight(f, MORNING).map((h) => h.text), ["friend's post"]);
  assert.deepEqual(takeOvernight(o, MORNING).map((h) => h.text), ["owner's post"]);
});

test("a post that fails to go out keeps what was held", async () => {
  reset();
  const c = owner();
  submitPost(c, "keep me", false, EARLY);
  const failing = { enqueue: <T>(_c: unknown, job: () => Promise<T>) => job(), runTurn: async () => ({ spoke: false, error: new Error("offline") }) } as any;
  assert.equal(await releaseHeld(failing, c, MORNING), false);
  assert.equal(heldPosts(c).length, 1);
});

test("failure tracker: the owner's looks become a fact only after 3 failures over 2 hours AWAKE; sleep does not count; a success ends it without a word", () => {
  const H = 3_600_000;
  const T = 1_000_000_000_000;
  const t = createFailureTracker();
  t.observe("owner", "owner", true, "login", T, 0);
  t.observe("owner", "owner", true, "login", T + 600_000, 0.2 * H);
  t.observe("owner", "owner", true, "login", T + 1_200_000, 0.4 * H);
  assert.equal(t.fact("owner"), "", "three failures, but only 24 minutes awake");
  t.observe("owner", "owner", true, "login", T + 2.5 * H, 2.1 * H);
  const fact = t.fact("owner");
  assert.match(fact, /failed 4 times in a row/);
  assert.match(fact, /claude auth login/);
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
  g.observe("tenant:anna", "tenant", true, "timeout", T, 0);
  assert.equal(g.fact("g1") + g.fact("tenant:anna"), "");
});

test("causeOf and the owner's failure messages: login, limit, timeout, connector, the rest", () => {
  assert.equal(causeOf(new AuthError("x")), "login");
  assert.equal(causeOf(new RateLimitError("x")), "limit");
  assert.equal(causeOf(new InstanceKeyError("billing")), "billing");
  assert.equal(causeOf(new RunTimeout(60_000)), "timeout");
  assert.equal(causeOf(new Error("MCP server notion failed to connect")), "connector");
  assert.equal(causeOf(new Error("fetch failed")), "connector");
  assert.equal(causeOf(new Error("agent turn ended with error_during_execution")), "other");
  assert.match(noticeFor("owner")(new RunTimeout(60_000)), /too long.*RUN_MAX_MINUTES_CHAT/);
  assert.match(noticeFor("owner")(new Error("mcp connector down")), /npm run doctor/);
  assert.match(noticeFor("owner")(new Error("x")), /Check the logs/);
  assert.doesNotMatch(noticeFor("friend")(new RunTimeout(60_000)), /\.env|doctor/, "a friend is sent to no terminal");
  assert.doesNotMatch(noticeFor("group")(new Error("mcp connector down")), /doctor|\.env/);
});

test("the budget notice: once a day, in the owner's chat, naming the limit and the setting", () => {
  instanceDb().run("DELETE FROM spend");
  instanceDb().run("DELETE FROM notices");
  resetHeld(owner());
  const told: string[] = [];
  ownerNotices.sendTo((t) => told.push(t));
  assert.equal(noticeBudget(DAY), false, "under budget: nothing");
  recordCost(settings.dailyBudgetUsd + 1);
  assert.equal(noticeBudget(DAY), true);
  assert.equal(noticeBudget(DAY), false, "not again today");
  assert.deepEqual(told, [`Daily budget of $${settings.dailyBudgetUsd} reached, background work paused until midnight. To lift it today, raise DAILY_BUDGET_USD in .env and restart.`]);
  ownerNotices.sendTo(undefined);
});

test("a system notice at night is held and goes out with the rest in the morning", async () => {
  reset();
  const told: string[] = [];
  ownerNotices.sendTo((t) => told.push(t));
  noticeOwner("something failed", NIGHT);
  assert.deepEqual(told, []);
  noticeOwner("something failed", DAY);
  assert.deepEqual(told, ["something failed"]);
  const sent: string[] = [];
  const pipeline = { enqueue: <T>(_c: unknown, job: () => Promise<T>) => job(), runTurn: async (_c: unknown, t: any) => (sent.push((await t.run()).text), { spoke: true }) } as any;
  assert.equal(await releaseHeld(pipeline, owner(), MORNING), true);
  assert.deepEqual(sent, ["something failed"]);
  ownerNotices.sendTo(undefined);
});

test("a group hears of the spent budget once a day", () => {
  assert.equal(groupBudgetDue("g1", DAY), true);
  assert.equal(groupBudgetDue("g1", DAY), false);
  assert.equal(groupBudgetDue("g2", DAY), true, "another group has its own");
  assert.equal(groupBudgetDue("g1", MORNING), true, "the next day");
  assert.doesNotMatch(GROUP_BUDGET_TEXT, /DAILY_BUDGET|\.env|npm/, "nobody in a group is sent to a terminal");
});

test("the doctor's error window: dates are rebuilt from the file's time, so yesterday's errors do not count", () => {
  const mtime = new Date(2026, 9, 15, 0, 20, 0).getTime();
  const log = ["23:10:00.000 ERR yesterday evening", "23:50:00.000 ERR yesterday, within the hour", "23:55:00.000 fine", "00:10:00.000 ERR just now", "    at stack frame", "00:15:00.000 WARN fine"].join("\n");
  assert.equal(errorLinesSince(log, mtime, mtime - 3600_000), 2, "23:50 and 00:10, not 23:10");
  // old text comparison would have said: 00:20 minus an hour = 23:20, and "00:10" < "23:20" lost the newest error
  assert.equal(errorLinesSince("", mtime, mtime - 3600_000), 0);
  assert.equal(errorLinesSince(log, mtime, mtime - 24 * 3600_000), 3);
});


test("held items are checked before delivery: yesterday's budget notice is dropped, a post is dropped once the owner has written since", async () => {
  reset();
  ownerNotices.sendTo(() => {});
  const c = owner();
  noticeOwner("Daily budget of $20 reached, background work paused until midnight.", NIGHT, { sameDay: true });
  noticeOwner("something failed", NIGHT);
  const sent: string[] = [];
  assert.equal(await releaseHeld(pipe(sent), c, MORNING), true);
  assert.deepEqual(sent, ["something failed"], "the budget line said 'until midnight': false the next morning");
  // a held post, then the owner writes: the post may contradict what they said
  reset();
  submitPost(c, "your parcel is late", false, NIGHT);
  recordMessage("owner", NIGHT.getTime() + 60_000, "never mind the parcel", new Date(NIGHT.getTime() + 60_000), c.logFile);
  assert.equal(await releaseHeld(pipe(sent), c, MORNING), false);
  assert.deepEqual(heldPosts(c), [], "dropped, not kept");
  // and what is held for over a day and a half is no longer news
  const old = [{ text: "x", why: "quiet" as const, at: NIGHT.getTime(), day: "d" }];
  assert.equal(stillTrue(old, NIGHT.getTime() + 37 * 3_600_000, "d", []).length, 0);
  assert.equal(stillTrue(old, NIGHT.getTime() + 3_600_000, "d", []).length, 1);
  assert.equal(stillTrue([{ text: "n", why: "quiet", notice: true, at: 1, day: "d" }], 2, "d", [5]).length, 1, "a system notice does not depend on what the owner wrote");
  ownerNotices.sendTo(undefined);
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

test("the instance-cap notice to the owner respects quiet hours; a group's budget line survives a restart", async () => {
  reset();
  instanceDb().run("DELETE FROM notices");
  const told: string[] = [];
  ownerNotices.sendTo((t) => told.push(t));
  capNoticesTo((t) => noticeOwner(t, NIGHT, { sameDay: true }));
  assert.equal(reportInstanceCap(5, NIGHT.getTime()), true);
  assert.deepEqual(told, [], "night: held, not sent");
  assert.equal(heldPosts(owner()).length, 1);
  capNoticesTo(undefined);
  ownerNotices.sendTo(undefined);
  assert.equal(groupBudgetDue("gx", DAY), true);
  assert.equal(instanceDb().get<{ day: string }>("SELECT day FROM notices WHERE key = ?", `group-budget:${groupConvId("gx")}`)?.day, localDay(DAY), "written to the notices table under the group's folder name, not its id: a restart does not forget it");
  assert.equal(groupBudgetDue("gx", DAY), false);
});
