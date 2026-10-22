import { test } from "node:test";
import assert from "node:assert/strict";
import { owner } from "../src/conversation/conversationmodel.ts";
import { settings } from "../src/core/settings.ts";
import { digestTimes } from "../src/core/settings.ts";
import { clockIn } from "../src/core/timezone.ts";
import { dedupe, digestDue, digestText, kindOfItem, lastSlotBefore, oneLine, planDigest, subjectOf, zonedInstant } from "../src/heartbeat/digest.ts";
import { usableLines } from "../src/heartbeat/digestlines.ts";
import { parseHeartbeatAnswer } from "../src/run/rules.ts";
import { heldPosts, resetHeld, noticeOwner, ownerNotices, releaseHeld, submitPost } from "../src/heartbeat/notices.ts";

const s = settings as unknown as Record<string, unknown>;
s.quietStartHour = 22;
s.quietEndHour = 7;
s.maxUnpromptedPerDay = 3;
s.digestMinutes = [12 * 60 + 30, 18 * 60 + 30];
s.digestMaxItems = 8;
s.digestSummarize = false;

const item = (text: string, at: number, extra: Record<string, unknown> = {}) => ({ text, at, why: "quiet" as const, ...extra });

test("kindOfItem: notices are system, asks are needs you, the rest FYI", () => {
  assert.equal(kindOfItem({ text: "Budget reached", notice: true }), "system");
  assert.equal(kindOfItem({ text: "Can you do Friday lunch?" }), "needs");
  assert.equal(kindOfItem({ text: "Please approve the invoice reply" }), "needs");
  assert.equal(kindOfItem({ text: "Your parcel arrived" }), "fyi");
});

test("kindOfItem: the look's needsYou flag decides when present; the words only when it is absent", () => {
  assert.equal(kindOfItem({ text: "Did you know octopuses have three hearts?", needsYou: false }), "fyi");
  assert.equal(kindOfItem({ text: "Anna is waiting at the door", needsYou: true }), "needs");
  assert.equal(kindOfItem({ text: "Did you know octopuses have three hearts?" }), "needs", "fallback for an item held without the flag");
  assert.equal(kindOfItem({ text: "Your parcel arrived" }), "fyi");
  assert.equal(kindOfItem({ text: "Is this a question?", needsYou: true, notice: true }), "system");
});

test("subjectOf and dedupe: same text or same subject, the newest stays, newest first", () => {
  assert.equal(subjectOf("3 new mails from the bank today"), subjectOf("5 new mails from the bank today"));
  assert.equal(subjectOf("ok"), undefined, "too short to have a subject");
  const out = dedupe([item("3 new mails from the bank", 1), item("Parcel is late", 2), item("5 new mails from the bank", 3), item("parcel  is LATE", 4)]);
  assert.deepEqual(out.map((h) => h.text), ["parcel  is LATE", "5 new mails from the bank"]);
});

test("planDigest: groups in order, newest first, capped with the needs-you items kept first, N more counted", () => {
  const held = [item("fyi one", 1), item("Can you confirm Friday?", 2), item("fyi two", 3), item("the sync failed", 4, { notice: true }), item("fyi three", 5), item("Reply to Anna?", 6)];
  const p = planDigest(held, 4);
  assert.deepEqual(p.groups.map((g) => g.kind), ["needs", "fyi"]);
  assert.deepEqual(p.groups[0]!.items.map((h) => h.text), ["Reply to Anna?", "Can you confirm Friday?"]);
  assert.deepEqual(p.groups[1]!.items.map((h) => h.text), ["fyi three", "fyi two"]);
  assert.equal(p.more, 2, "one more FYI and the system notice");
  const all = planDigest(held, 50);
  assert.deepEqual(all.groups.map((g) => g.kind), ["needs", "fyi", "system"]);
  assert.equal(all.more, 0);
  assert.equal(planDigest(held, 0).groups.flatMap((g) => g.items).length, 1, "at least one line");
});

test("digestText: one item as it is, one group a list, several groups with titles, and the 'and N more' line", () => {
  assert.equal(digestText(planDigest([item("only this", 1)], 8)), "only this");
  assert.equal(digestText(planDigest([item("a thing", 1), item("another thing", 2)], 8)), "A few things I held back:\n- another thing\n- a thing");
  const t = digestText(planDigest([item("Can you come?", 1), item("news", 2), item("the sync failed", 3, { notice: true })], 8));
  assert.equal(t, "A few things I held back:\nNeeds you\n- Can you come?\nFYI\n- news\nSystem\n- the sync failed");
  const capped = digestText(planDigest(["apple", "banana", "cherry", "damson", "elder", "fig", "grape", "hazel", "iris", "jade", "kiwi", "lemon"].map((w, i) => item(`story about ${w} today`, i)), 8));
  assert.match(capped, /\nand 4 more, ask me\.$/);
  assert.equal(capped.split("\n").filter((l) => l.startsWith("- ")).length, 8);
  assert.equal(digestText(planDigest([item("a thing", 1), item("another thing", 2)], 8), (h) => `L:${h.text}`), "A few things I held back:\n- L:another thing\n- L:a thing");
});

test("oneLine: collapses whitespace and cuts at a word, never empty", () => {
  assert.equal(oneLine("a\n  b   c"), "a b c");
  const long = oneLine("word ".repeat(100), 40);
  assert.ok(long.length <= 40 && long.endsWith("…"), long);
  assert.doesNotMatch(long, /wor…$/);
  assert.ok(oneLine("x".repeat(500), 30).length === 30);
});

test("usableLines: exactly one short non-empty line per item, else the model's answer is ignored", () => {
  assert.deepEqual(usableLines([" a ", "b"], 2), ["a", "b"]);
  assert.equal(usableLines(["a"], 2), undefined);
  assert.equal(usableLines(["a", ""], 2), undefined);
  assert.equal(usableLines(["a", 5], 2), undefined);
  assert.equal(usableLines(["a", "x".repeat(500)], 2), undefined);
  assert.equal(usableLines("nope", 1), undefined);
});

test("DIGEST_TIMES: defaults, off, a list, and a typo that fails loudly", () => {
  assert.deepEqual(digestTimes(undefined), [750, 1110]);
  assert.deepEqual(digestTimes("18:30, 9,12:30,9"), [540, 750, 1110]);
  assert.deepEqual(digestTimes("off"), []);
  assert.throws(() => digestTimes("25:00"), /DIGEST_TIMES/);
  assert.throws(() => digestTimes("noon"), /DIGEST_TIMES/);
});

const wall = (t: number, zone: string) => {
  const c = clockIn(new Date(t), zone);
  return `${c.year}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")} ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
};

test("slots are the zone's wall time, also across a clock change", () => {
  // Berlin springs forward on 2026-03-29 (02:00 -> 03:00) and falls back on 2026-10-25 (03:00 -> 02:00): 12:30 is 12:30 on both sides
  for (const day of [[2026, 3, 28], [2026, 3, 29], [2026, 3, 30], [2026, 10, 24], [2026, 10, 25], [2026, 10, 26]] as const) {
    assert.match(wall(zonedInstant(day[0], day[1], day[2], 12, 30, "Europe/Berlin"), "Europe/Berlin"), / 12:30$/, day.join("-"));
  }
  assert.equal(zonedInstant(2026, 3, 29, 12, 30, "Europe/Berlin"), Date.UTC(2026, 2, 29, 10, 30), "CEST: UTC+2");
  assert.equal(zonedInstant(2026, 3, 28, 12, 30, "Europe/Berlin"), Date.UTC(2026, 2, 28, 11, 30), "CET: UTC+1");
  assert.equal(zonedInstant(2026, 3, 8, 12, 30, "America/New_York"), Date.UTC(2026, 2, 8, 16, 30), "EDT after the jump");
  // a wall time that does not exist (02:30 on the spring-forward day) still gives one instant next to the gap
  const gap = zonedInstant(2026, 3, 29, 2, 30, "Europe/Berlin");
  assert.ok([1, 3].includes(clockIn(new Date(gap), "Europe/Berlin").hour));
  // a time that exists twice (02:30 on the fall-back day) is one instant
  assert.equal(clockIn(new Date(zonedInstant(2026, 10, 25, 2, 30, "Europe/Berlin")), "Europe/Berlin").minute, 30);
});

test("lastSlotBefore: the latest slot at or before now, yesterday's evening slot early in the morning, none without slots", () => {
  const Z = "Europe/Berlin";
  const slots = [750, 1110];
  const at = (h: number, m: number, day = 29) => Date.UTC(2026, 2, day, h, m); // UTC; Berlin is +1 until the 29th 02:00, then +2
  assert.equal(wall(lastSlotBefore(at(9, 0), Z, slots)!, Z), "2026-03-28 18:30", "11:00 on the spring-forward day, before the first slot: yesterday's evening one");
  assert.equal(wall(lastSlotBefore(at(10, 30), Z, slots)!, Z), "2026-03-29 12:30", "exactly on the slot");
  assert.equal(wall(lastSlotBefore(at(16, 29), Z, slots)!, Z), "2026-03-29 12:30");
  assert.equal(wall(lastSlotBefore(at(16, 30), Z, slots)!, Z), "2026-03-29 18:30");
  assert.equal(lastSlotBefore(at(12, 0), Z, []), undefined);
});

test("digestDue: quiet-held items at once, cap-held items once a slot has passed since they were held, no slots: as soon as allowed", () => {
  const Z = "Europe/Berlin";
  const noon = Date.UTC(2026, 9, 14, 9, 0); // 11:00 CEST
  const slots = [750, 1110];
  assert.equal(digestDue({ held: [], now: noon, zone: Z, slots }), false);
  assert.equal(digestDue({ held: [item("a", noon - 3_600_000)], now: noon, zone: Z, slots }), true, "held for quiet: quiet is over now");
  const cap = (at: number) => [{ text: "c", at, why: "cap" as const }];
  assert.equal(digestDue({ held: cap(Date.UTC(2026, 9, 14, 8, 0)), now: noon, zone: Z, slots }), false, "held at 10:00 for the cap: the 12:30 slot is next");
  assert.equal(digestDue({ held: cap(Date.UTC(2026, 9, 14, 8, 0)), now: Date.UTC(2026, 9, 14, 10, 31), zone: Z, slots }), true, "12:31");
  assert.equal(digestDue({ held: cap(Date.UTC(2026, 9, 14, 11, 0)), now: Date.UTC(2026, 9, 14, 11, 5), zone: Z, slots }), false, "held at 13:00, now 13:05: the 12:30 slot was before it");
  assert.equal(digestDue({ held: cap(Date.UTC(2026, 9, 14, 11, 0)), now: Date.UTC(2026, 9, 14, 16, 31), zone: Z, slots }), true, "18:31 passed the evening slot");
  assert.equal(digestDue({ held: cap(Date.UTC(2026, 9, 14, 11, 0)), now: Date.UTC(2026, 9, 14, 12, 0), zone: Z, slots: [] }), true, "DIGEST_TIMES=off");
  assert.equal(digestDue({ held: [{ text: "old row" }], now: noon, zone: Z, slots }), true, "a row without a time is not kept waiting");
});

const reset = () => resetHeld(owner());
const pipe = (sent: string[]) => ({ enqueue: <T>(_c: unknown, job: () => Promise<T>) => job(), runTurn: async (_c: unknown, t: any) => (sent.push((await t.run()).text), { spoke: true }) }) as any;
const NIGHT = new Date(2026, 9, 14, 23, 30, 0);
const MORNING = new Date(2026, 9, 15, 7, 30, 0);

test("releaseHeld sends ONE grouped digest at the end of quiet hours, with the code's own lines", async () => {
  reset();
  ownerNotices.sendTo(() => {});
  const c = owner();
  submitPost(c, "Can you confirm the dentist on Friday?", false, NIGHT);
  submitPost(c, "Your parcel arrived at the door", false, NIGHT);
  submitPost(c, "Your parcel arrived at the door!", false, NIGHT);
  noticeOwner("My background checks have failed 3 times in a row. Run `npm run doctor`.", NIGHT);
  const sent: string[] = [];
  assert.equal(await releaseHeld(pipe(sent), c, MORNING), true);
  assert.deepEqual(sent, ["A few things I held back:\nNeeds you\n- Can you confirm the dentist on Friday?\nFYI\n- Your parcel arrived at the door!\nSystem\n- My background checks have failed 3 times in a row. Run `npm run doctor`."]);
  assert.deepEqual(heldPosts(c), []);
  ownerNotices.sendTo(undefined);
});

test("the model's one-liners are used when they fit; a failing, slow or wrong model falls back to the code's lines", async () => {
  const run = async (lines: (t: readonly string[]) => Promise<string[] | undefined>) => {
    reset();
    const c = owner();
    submitPost(c, "first long story about nothing much", false, NIGHT);
    submitPost(c, "second long story about something", false, NIGHT);
    const sent: string[] = [];
    await releaseHeld(pipe(sent), c, MORNING, { lines });
    return sent[0];
  };
  assert.equal(await run(async (t) => t.map((x) => x.split(" ")[0]!)), "A few things I held back:\n- second\n- first");
  const code = "A few things I held back:\n- second long story about something\n- first long story about nothing much";
  assert.equal(await run(async () => undefined), code);
  assert.equal(await run(async () => Promise.reject(new Error("offline"))), code);
});

test("the cap's items wait for a digest slot: held at 19:00, the next morning is too early, the 12:30 slot is not", async () => {
  reset();
  const c = owner();
  const day1 = new Date(2026, 9, 14, 19, 0);
  for (const t of ["one post", "two post", "three post"]) submitPost(c, t, false, day1);
  assert.equal(submitPost(c, "held for the cap", false, day1), "held");
  const sent: string[] = [];
  assert.equal(await releaseHeld(pipe(sent), c, new Date(2026, 9, 15, 9, 0)), false, "the day turned (the cap is free) but no slot has come since 19:00");
  assert.equal(await releaseHeld(pipe(sent), c, new Date(2026, 9, 15, 12, 31)), true);
  assert.deepEqual(sent, ["held for the cap"]);
});

test("the look's needsYou flag: parsed (only a literal true), carried on the held item, and it decides the digest group", async () => {
  assert.equal(parseHeartbeatAnswer({ message: "hi", nextCheckMinutes: 30, needsYou: true }, "").needsYou, true);
  assert.equal(parseHeartbeatAnswer({ message: "hi", nextCheckMinutes: 30, needsYou: "true" }, "").needsYou, false);
  assert.equal(parseHeartbeatAnswer({ message: "hi", nextCheckMinutes: 30 }, "").needsYou, false);
  assert.equal(parseHeartbeatAnswer({ message: "[[silent]]", nextCheckMinutes: 30, needsYou: true }, "").needsYou, false);
  reset();
  const c = owner();
  submitPost(c, "Did you know octopuses have three hearts?", false, NIGHT, false);
  submitPost(c, "Anna is waiting at the door", false, NIGHT, true);
  submitPost(c, "Lunch on Friday?", false, NIGHT); // (held without the flag: the words decide)
  const rows = heldPosts(c);
  assert.deepEqual(rows.map((h) => h.needsYou), [false, true, undefined]);
  const sent: string[] = [];
  await releaseHeld(pipe(sent), c, MORNING);
  assert.equal(sent[0], "A few things I held back:\nNeeds you\n- Lunch on Friday?\n- Anna is waiting at the door\nFYI\n- Did you know octopuses have three hearts?");
});
