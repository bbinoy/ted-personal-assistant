import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { owner } from "../src/conversation/conversationmodel.ts";
import { settings } from "../src/core/settings.ts";
import { dataPath, readJson, writeJson } from "../src/core/state.ts";
import { localDay } from "../src/core/pause.ts";
import { GROUP_BUDGET_TEXT, groupBudgetDue } from "../src/core/budget.ts";
import { combine, createFailureTracker, heldFileOf, noticeBudget, noticeOwner, ownerNotices, planFlush, planPost, releaseHeld, stillTrue, submitPost, countPosts } from "../src/heartbeat/notices.ts";
import { AuthError, causeOf, InstanceKeyError, noticeFor, RateLimitError } from "../src/tenants/errors.ts";
import { RunTimeout } from "../src/run/ceiling.ts";
import { parseHeartbeatAnswer } from "../src/run/rules.ts";
import { recordMessage } from "../src/core/messages.ts";
import { gateSink, sendNow, withSend } from "../src/modules/send/send.ts";
import { capNoticesTo, reportInstanceCap } from "../src/core/capnotice.ts";
import { errorLinesSince } from "../src/core/logwindow.ts";
import { groupConvId, instancePaths } from "../src/core/convpaths.ts";

const s = settings as unknown as Record<string, unknown>;
s.quietStartHour = 22;
s.quietEndHour = 7;
s.maxUnpromptedPerDay = 3;
const DAY = new Date(2026, 9, 14, 14, 0, 0);
const NIGHT = new Date(2026, 9, 14, 23, 30, 0);
const MORNING = new Date(2026, 9, 15, 7, 30, 0);
const reset = () => rmSync(dataPath(heldFileOf(owner())), { force: true });

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

test("held posts: night holds, day posts, the cap holds the rest, and one combined message goes out when it may", async () => {
  reset();
  const c = owner();
  assert.equal(submitPost(c, "mail from the bank", false, NIGHT), "held");
  assert.equal(submitPost(c, "mail from the bank", false, NIGHT), "held", "the same text is not held twice");
  assert.equal(submitPost(c, "meeting in 10 minutes", true, NIGHT), "post", "urgent goes at night");
  assert.equal(submitPost(c, "a reminder", false, NIGHT), "held");
  const sent: string[] = [];
  const pipeline = { enqueue: <T>(_c: unknown, job: () => Promise<T>) => job(), runTurn: async (_c: unknown, t: any) => (sent.push((await t.run()).text), { spoke: true }) } as any;
  assert.equal(await releaseHeld(pipeline, c, NIGHT), false, "still the quiet window");
  assert.equal(await releaseHeld(pipeline, c, MORNING), true);
  assert.deepEqual(sent, ["A few things I held back:\n- a reminder\n- mail from the bank"]);
  assert.equal(await releaseHeld(pipeline, c, MORNING), false, "nothing left");
  assert.deepEqual(readJson<{ held: unknown[] }>(heldFileOf(c), { held: [1] }).held, []);
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
  assert.equal(await releaseHeld(pipeline, c, new Date(2026, 9, 15, 9, 0)), true, "the next morning");
  assert.deepEqual(sent, ["three"]);
});

test("a post that fails to go out keeps what was held", async () => {
  reset();
  const c = owner();
  submitPost(c, "keep me", false, NIGHT);
  const failing = { enqueue: <T>(_c: unknown, job: () => Promise<T>) => job(), runTurn: async () => ({ spoke: false, error: new Error("offline") }) } as any;
  assert.equal(await releaseHeld(failing, c, MORNING), false);
  assert.equal(readJson<{ held: unknown[] }>(heldFileOf(c), { held: [] }).held.length, 1);
});

test("failure tracker: 3 in a row (or an hour of failures) is said ONCE with the cause and the fix, recovery once", () => {
  const t = createFailureTracker();
  const T = 1_000_000_000_000;
  assert.deepEqual(t.observe("owner", "owner", true, "login", T), []);
  assert.deepEqual(t.observe("owner", "owner", true, "login", T + 600_000), []);
  const third = t.observe("owner", "owner", true, "login", T + 1_200_000);
  assert.equal(third.length, 1);
  assert.match(third[0]!, /failed 3 times in a row/);
  assert.match(third[0]!, /claude auth login/);
  assert.deepEqual(t.observe("owner", "owner", true, "login", T + 1_800_000), [], "once per incident");
  assert.deepEqual(t.observe("owner", "owner", false, undefined, T + 2_400_000), ["My background checks work again."]);
  assert.deepEqual(t.observe("owner", "owner", false, undefined, T + 3_000_000), [], "no second 'back to normal'");
  // two failures an hour apart: the hour rule
  const u = createFailureTracker();
  assert.deepEqual(u.observe("g", "group", true, "timeout", T), []);
  const hour = u.observe("g", "group", true, "timeout", T + 3_600_000);
  assert.equal(hour.length, 1);
  assert.match(hour[0]!, /in one of your groups/);
  assert.match(hour[0]!, /RUN_MAX_MINUTES_BACKGROUND/);
  // a success in between resets the count
  const v = createFailureTracker();
  v.observe("o", "owner", true, "other", T);
  v.observe("o", "owner", true, "other", T + 1);
  v.observe("o", "owner", false, undefined, T + 2);
  assert.deepEqual(v.observe("o", "owner", true, "other", T + 3), []);
});

test("failure tracker: friends are one anonymised count, never a name", () => {
  const t = createFailureTracker({ count: 2 });
  const T = 1_000_000_000_000;
  t.observe("tenant:anna", "tenant", true, "connector", T);
  t.observe("tenant:bob", "tenant", true, "connector", T);
  const first = t.observe("tenant:anna", "tenant", true, "connector", T + 1);
  assert.equal(first.length, 1);
  assert.match(first[0]!, /2 friend\(s\)/);
  assert.doesNotMatch(first[0]!, /anna|bob/i);
  assert.deepEqual(t.observe("tenant:bob", "tenant", true, "connector", T + 2), [], "the second friend adds no second notice");
  assert.deepEqual(t.observe("tenant:anna", "tenant", false, undefined, T + 3), [], "not back to normal while another is still failing");
  assert.deepEqual(t.observe("tenant:bob", "tenant", false, undefined, T + 4), ["Background work for friends is back to normal."]);
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
  rmSync(dataPath(instancePaths().cost), { force: true });
  rmSync(dataPath(heldFileOf(owner())), { force: true });
  const told: string[] = [];
  ownerNotices.sendTo((t) => told.push(t));
  assert.equal(noticeBudget(DAY), false, "under budget: nothing");
  writeJson(instancePaths().cost, { day: localDay(new Date()), usd: settings.dailyBudgetUsd + 1 });
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

const pipe = (sent: string[]) => ({ enqueue: <T>(_c: unknown, job: () => Promise<T>) => job(), runTurn: async (_c: unknown, t: any) => (sent.push((await t.run()).text), { spoke: true }) }) as any;

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
  assert.deepEqual(readJson<{ held: unknown[] }>(heldFileOf(c), { held: [1] }).held, [], "dropped, not kept");
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
  assert.equal(readJson<{ held: { text: string }[] }>(heldFileOf(c), { held: [] }).held[0]?.text, "morning news");
  const chat: string[] = [];
  await withSend("owner", async (x: any) => (chat.push(x.text), "sent"), () => sendNow("owner", { text: "hello" }));
  assert.deepEqual(chat, ["hello"], "no gate on another run's sink");
});

test("the instance-cap notice to the owner respects quiet hours; a group's budget line survives a restart", async () => {
  reset();
  rmSync(dataPath(instancePaths().capNotices), { force: true });
  const told: string[] = [];
  ownerNotices.sendTo((t) => told.push(t));
  capNoticesTo((t) => noticeOwner(t, NIGHT, { sameDay: true }));
  assert.equal(reportInstanceCap(5, NIGHT.getTime()), true);
  assert.deepEqual(told, [], "night: held, not sent");
  assert.equal(readJson<{ held: unknown[] }>(heldFileOf(owner()), { held: [] }).held.length, 1);
  capNoticesTo(undefined);
  ownerNotices.sendTo(undefined);
  assert.equal(groupBudgetDue("gx", DAY), true);
  assert.ok(readJson<{ keys: string[] }>(instancePaths().capNotices, { keys: [] }).keys.includes(`group-budget:${groupConvId("gx")}`), "written to the state file under the group's folder name, not its id: a restart does not forget it");
  assert.equal(groupBudgetDue("gx", DAY), false);
});
