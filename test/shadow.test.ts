import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The gentle first week (src/approvals/shadow*.ts, src/core/welcome.ts, src/conversation/shadowreplies.ts): the one-time welcome, the floor that turns a look's archives into proposals, the batch
// message, a 👍 or "3,5 keep" answering it by code, when shadow mode ends, and the chat's own archives staying untouched.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "shadow-test-"));

const { settings } = await import("../src/core/settings.ts");
const require_paths = await import("../src/core/convpaths.ts");
const { convIdOfKey } = require_paths;
const { convDb, peekConvDb } = await import("../src/core/convdb.ts");
const { instanceDb, kvGet } = await import("../src/core/instancedb.ts");
const { readAudit } = await import("../src/core/audit.ts");
const { makeCanUseTool } = await import("../src/approvals/permissions.ts");
const { rememberMail, forgetSeenMail } = await import("../src/approvals/journalrender.ts");
const S = await import("../src/approvals/shadow.ts");
const { createShadowRun } = await import("../src/approvals/shadowgate.ts");
const { parseShadowReply } = await import("../src/approvals/shadowparse.ts");
const { batchGuard, shadowPrompt } = await import("../src/approvals/shadowexec.ts");
const { runShadow } = await import("../src/run/shadowrun.ts");
const { shadowReaction, shadowReply } = await import("../src/conversation/shadowreplies.ts");
const W = await import("../src/core/welcome.ts");
const { splitArchive } = await import("../src/modules/archivecap.ts");
const { recordMessage } = await import("../src/core/messages.ts");
const { createSeenMail } = await import("../src/modules/seenmail/seenmail.ts");
const { scratchLog } = await import("./scratch.ts");

const s = settings as unknown as Record<string, unknown>;
const MB = "mcp__mailbird__";
const GG = "mcp__google__";
const DAY_MS = 86_400_000;
const NOW = new Date("2026-10-22T10:00:00Z");
const opts = { signal: new AbortController().signal } as never;
type Out = { behavior: string; message?: string };

let n = 0;
function conv(kind: "owner" | "tenant" = "owner", withTriage = false) {
  const key = kind === "tenant" ? `tenant:shadow-${++n}` : `shadow-conv-${++n}`;
  const dir = mkdtempSync(join(tmpdir(), "shadow-notes-"));
  if (withTriage) writeFileSync(join(dir, "triage-newsletters.md"), "Archive newsletters.\n");
  return { kind, key, convId: convIdOfKey(key), notesDir: dir, logFile: scratchLog(`shadow-${n}.jsonl`), direct: true, target: undefined } as never as Parameters<typeof S.shadowActive>[0] & { direct: boolean };
}
const withMode = async <T>(mode: string, f: () => Promise<T> | T): Promise<T> => {
  const was = s.shadowMode;
  s.shadowMode = mode;
  try {
    return await f();
  } finally {
    s.shadowMode = was;
  }
};
const at = (c: { logFile: string }, daysAgo: number): void => void recordMessage("owner", Date.now() - daysAgo * DAY_MS, "hello", new Date(NOW.getTime() - daysAgo * DAY_MS), c.logFile); // the conversation's first message, this many days before NOW

// A runtime that records what would be sent and what would be run.
function runtime(o: { holding?: boolean; refuse?: string; fail?: boolean } = {}) {
  const sent: string[] = [];
  const ran: { tool: string; input: Record<string, unknown> }[][] = [];
  let ts = 5_000;
  S.setShadowRuntime({
    send: async (_c, t) => (sent.push(t), (ts += 10)),
    holding: () => !!o.holding,
    execute: async (_c, calls) => (ran.push([...calls]), o.refuse ? { ran: calls.map(() => false), refused: o.refuse } : { ran: calls.map(() => !o.fail) }),
  });
  return { sent, ran };
}
const from = (id: string, addr: boolean) => (addr ? `s${id}@news.example` : `Sender ${id}`);
const mails = (c: { key: string }, ids: string[], addr = false) => rememberMail(c.key, JSON.stringify(ids.map((id) => ({ id, subject: `Subject ${id}`, from: from(id, addr) }))), NOW.getTime());
const mbArchive = (id: string, addr = false) => ({ tool: `${MB}archive_conversation`, input: { conversationId: id }, id, line: `“Subject ${id}” from ${from(id, addr)}` });

// ---- the welcome ----

test("welcome: a fresh data folder is welcomed ONCE, with the persona's name and the three commands; never again", async () => {
  const sent: string[] = [];
  const send = async (t: string) => void sent.push(t);
  const fresh = { messages: 0, spend: 0, looks: 0, migrated: false };
  assert.equal(await W.welcomeOnce(send, () => fresh), "sent");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, new RegExp(`I'm ${settings.assistant}`));
  for (const c of ["/status", "/pause 2h", "/today"]) assert.ok(sent[0]!.includes(c), c);
  assert.match(sent[0]!, /set up/);
  assert.match(sent[0]!, /starting gently/);
  assert.equal(await W.welcomeOnce(send, () => fresh), "already", "the second start says nothing");
  assert.equal(sent.length, 1);
  assert.equal(kvGet<{ state: string }>(W.WELCOME_KEY, { state: "" }).state, "sent");
});

test("welcome: an install with history, spend, looks or a migrated data folder is never welcomed, not even later", async () => {
  for (const [name, facts] of [["history", { messages: 3, spend: 0, looks: 0, migrated: false }], ["spend", { messages: 0, spend: 2, looks: 0, migrated: false }], ["looks", { messages: 0, spend: 0, looks: 1, migrated: false }], ["migrated", { messages: 0, spend: 0, looks: 0, migrated: true }]] as const) {
    instanceDb().run("DELETE FROM kv WHERE key = ?", W.WELCOME_KEY);
    const sent: string[] = [];
    assert.equal(await W.welcomeOnce(async (t) => void sent.push(t), () => facts), "skipped", name);
    assert.equal(await W.welcomeOnce(async (t) => void sent.push(t), () => ({ messages: 0, spend: 0, looks: 0, migrated: false })), "already", `${name}: even if the history is deleted afterwards`);
    assert.deepEqual(sent, [], name);
  }
  instanceDb().run("DELETE FROM kv WHERE key = ?", W.WELCOME_KEY);
});

test("welcome: a send that fails writes nothing down, so the next start tries again", async () => {
  instanceDb().run("DELETE FROM kv WHERE key = ?", W.WELCOME_KEY);
  const fresh = { messages: 0, spend: 0, looks: 0, migrated: false };
  assert.equal(await W.welcomeOnce(async () => { throw new Error("signal is down"); }, () => fresh), "failed");
  assert.equal(kvGet(W.WELCOME_KEY, null), null);
  assert.equal(await W.welcomeOnce(async () => {}, () => fresh), "sent");
  instanceDb().run("DELETE FROM kv WHERE key = ?", W.WELCOME_KEY);
});

test("welcome: the real facts of an empty data folder are fresh (nothing said, spent or looked at)", () => {
  assert.equal(W.isFresh(W.welcomeFacts()), true);
  assert.equal(W.isFresh({ messages: 1, spend: 0, looks: 0, migrated: false }), false);
});

// ---- when shadow mode is on, and when it ends ----

test("end conditions: 3 days AND a triage note, at the latest 14 days; a note alone, or time alone before 14 days, does not end it", () => {
  const since = 0;
  const e = (days: number, triageNotes: number) => S.shadowEnded({ since, now: days * DAY_MS, triageNotes });
  assert.equal(e(0, 0), false);
  assert.equal(e(2.9, 5), false, "a note on day 2 does not end it: the first days are the gentle part");
  assert.equal(e(3, 0), false, "3 days without a note: still gentle");
  assert.equal(e(3, 1), true);
  assert.equal(e(13.9, 0), false);
  assert.equal(e(14, 0), true, "the longest it lasts");
});

test("shadowActive: on at the first look, written down, ends with the 3-day-and-a-note rule and then stays ended whatever happens to the notes", async () => {
  await withMode("auto", () => {
    const c = conv();
    at(c, 0);
    assert.equal(S.shadowActive(c, NOW), true, "a new conversation");
    assert.equal(S.shadowActive(c, new Date(NOW.getTime() + 2 * DAY_MS)), true);
    const later = new Date(NOW.getTime() + 4 * DAY_MS);
    assert.equal(S.shadowActive(c, later), true, "day 4 without a triage note: still on");
    writeFileSync(join(c.notesDir, "triage-newsletters.md"), "Archive newsletters.\n");
    assert.equal(S.shadowActive(c, later), false, "day 4 with a triage note: over");
    writeFileSync(join(c.notesDir, "triage-newsletters.md"), "---\norigin: inferred\n---\nx\n");
    assert.equal(S.shadowActive(c, later), false, "once ended it stays ended");
  });
});

test("shadowActive: an INFERRED triage note is not the person's own, so it does not end the first week early; day 14 does", async () => {
  await withMode("auto", () => {
    const c = conv();
    writeFileSync(join(c.notesDir, "triage-x.md"), "---\norigin: inferred\n---\nArchive things like X.\n");
    at(c, 0);
    assert.equal(S.shadowActive(c, NOW), true);
    assert.equal(S.shadowActive(c, new Date(NOW.getTime() + 5 * DAY_MS)), true);
    assert.equal(S.shadowActive(c, new Date(NOW.getTime() + 14 * DAY_MS)), false);
  });
});

test("shadowActive: counted from the conversation's FIRST message; an install already past 14 days, or already triaging mail, is adopted as ended and silently", async () => {
  await withMode("auto", async () => {
    runtime();
    const old = conv();
    at(old, 30);
    assert.equal(S.shadowActive(old, NOW), false, "a 30-day-old conversation");
    assert.equal(await S.tellShadowEnded(old, NOW), "none", "nothing changes for it, so nothing is said");
    const triaging = conv();
    at(triaging, 1);
    const seen = createSeenMail(triaging.convId);
    seen.unseen(["old-1"]);
    seen.commit();
    assert.equal(S.shadowActive(triaging, NOW), false, "it has a seen-mail log: it already triaged");
    const young = conv();
    at(young, 1);
    assert.equal(S.shadowActive(young, NOW), true);
  });
});

test("SHADOW_MODE: off never proposes, on never ends, auto is the default", async () => {
  const c = conv(undefined, true);
  at(c, 40);
  await withMode("off", () => assert.equal(S.shadowActive(c, NOW), false));
  await withMode("on", () => assert.equal(S.shadowActive(c, NOW), true, "40 days old with a triage note, and still proposing"));
  const { loadSettings } = await import("../src/core/settings.ts");
  assert.equal(loadSettings({}).shadowMode, "auto");
  assert.equal(loadSettings({ SHADOW_MODE: "off" }).shadowMode, "off");
  assert.throws(() => loadSettings({ SHADOW_MODE: "maybe" }), /SHADOW_MODE/);
});

test("the end is told ONCE: after it has ended, not in quiet hours, then never again", async () => {
  await withMode("auto", async () => {
    const q = runtime({ holding: true });
    const c = conv(undefined, true);
    at(c, 4);
    assert.equal(S.shadowActive(c, NOW), false, "4 days and a triage note");
    assert.equal(await S.tellShadowEnded(c, NOW), "held", "quiet hours: the next look says it");
    assert.deepEqual(q.sent, []);
    const loud = runtime();
    assert.equal(await S.tellShadowEnded(c, NOW), "sent");
    assert.deepEqual(loud.sent, ["From now on I'll archive these kinds of mail myself; you'll see them in /today."]);
    assert.equal(await S.tellShadowEnded(c, NOW), "none");
    assert.equal(loud.sent.length, 1);
  });
});

// ---- the floor ----

test("splitArchive: a batch call becomes one call per mail with every other argument kept; a single call stays whole", () => {
  const out = splitArchive(`${MB}archive_conversation`, { conversationIds: ["a", "b", "b", "c"], note: "x" });
  assert.deepEqual(out.map((o) => o.id), ["a", "b", "c"]);
  assert.deepEqual(out[1]!.input, { conversationIds: ["b"], note: "x" });
  assert.deepEqual(splitArchive(`${MB}archive_conversation`, { conversationId: "z" }), [{ input: { conversationId: "z" }, id: "z" }]);
  assert.deepEqual(splitArchive(`${MB}get_message`, { messageId: 1 }), []);
  assert.deepEqual(splitArchive("mcp__claude_ai_Gmail__unlabel_thread", { threadId: "t1", labelIds: ["INBOX"] }).map((o) => o.id), ["t1"]);
});

const autoJudge = async () => ({ decision: "auto" as const, reason: "test" });
const canUse = (shadow?: (t: string, i: Record<string, unknown>) => string | undefined, conversation?: string, source: "background" | "chat" | "group" = "background", tools?: ReadonlySet<string>) =>
  makeCanUseTool(async () => ({ approved: true }), source, undefined, autoJudge as never, undefined, tools, false, { provenance: () => ({ kind: "standing", task: "look" }) as never, shadow, conversation });

test("the floor: in a look in shadow mode an archive is NOT executed, is collected with the subject and sender the look read, and is audited; other calls are untouched", async () => {
  const prev = s.autoApprove;
  s.autoApprove = "auto";
  try {
    forgetSeenMail();
    const c = conv();
    mails(c, ["m1", "m2", "m3"]);
    const run = createShadowRun(c.key);
    const can = canUse(run.gate, c.key);
    const start = new Date().toISOString();
    const a = (await can(`${MB}archive_conversation`, { conversationId: "m1" }, opts)) as Out;
    assert.equal(a.behavior, "deny");
    assert.match(a.message ?? "", /Not archived, and nobody was asked/);
    assert.match(a.message ?? "", /proposals|proposed/);
    const batch = (await can(`${MB}archive_conversation`, { conversationIds: ["m2", "m3"] }, opts)) as Out;
    assert.equal(batch.behavior, "deny");
    await can(`${MB}archive_conversation`, { conversationId: "m1" }, opts); // (the same mail again: still one proposal)
    assert.deepEqual(run.proposed().map((p) => [p.id, p.line]), [["m1", "“Subject m1” from Sender m1"], ["m2", "“Subject m2” from Sender m2"], ["m3", "“Subject m3” from Sender m3"]]);
    assert.deepEqual(run.proposed().map((p) => p.input), [{ conversationId: "m1" }, { conversationIds: ["m2"] }, { conversationIds: ["m3"] }], "one call per mail, as the look made it");
    assert.ok(readAudit((e) => e.decision === "shadow-proposed" && e.ts >= start).length >= 3, "audited");
    assert.notEqual(((await can(`${MB}get_message`, { messageId: 1 }, opts)) as Out).behavior, "deny", "a read is not held");
    assert.equal(((await can(`${MB}select_conversation`, { conversationId: "m1" }, opts)) as Out).behavior, "allow", "other actions are not archives");
  } finally {
    s.autoApprove = prev;
  }
});

test("the floor: Gmail's INBOX removal and a friend's Google modify_gmail_message_labels are archives too", async () => {
  const prev = s.autoApprove;
  s.autoApprove = "auto";
  try {
    const c = conv("tenant");
    const run = createShadowRun(c.key);
    const tool = `${GG}modify_gmail_message_labels`;
    const can = canUse(run.gate, c.key, "group", new Set([tool]));
    const r = (await can(tool, { message_id: "g1", remove_label_ids: ["INBOX"] }, opts)) as Out;
    assert.equal(r.behavior, "deny");
    assert.match(r.message ?? "", /Not archived/);
    const keep = (await can(tool, { message_id: "g2", add_label_ids: ["STARRED"] }, opts)) as Out;
    assert.doesNotMatch(keep.message ?? "", /Not archived/, "a label that is no archive is not held");
    assert.deepEqual(run.proposed().map((p) => p.id), ["g1"]);
  } finally {
    s.autoApprove = prev;
  }
});

test("chat-initiated archives are unaffected: a run without the gate (a chat turn, the approved follow-up) archives as always", async () => {
  const prev = s.autoApprove;
  s.autoApprove = "auto";
  try {
    const chat = canUse(undefined, "owner", "chat");
    assert.equal(((await chat(`${MB}archive_conversation`, { conversationId: "c-1" }, opts)) as Out).behavior, "allow");
    assert.equal(((await chat(`${MB}archive_conversation`, { conversationIds: ["c-2", "c-3"] }, opts)) as Out).behavior, "allow");
  } finally {
    s.autoApprove = prev;
  }
});

// ---- the batch message and the answers ----

const ownerLike = (c: object) => ({ ...c, kind: "owner" }) as never;
const offerOf = async (c: ReturnType<typeof conv>, ids: string[], addr = false) => {
  const q = runtime();
  mails(c, ids, addr);
  assert.equal(await S.offerShadow(c, ids.map((i) => mbArchive(i, addr)), NOW), "sent");
  return q;
};

test("the look's end posts ONE batch message with code-rendered lines; the same mail is not proposed twice", async () => {
  forgetSeenMail();
  const c = conv();
  const q = await offerOf(c, ["a1", "a2", "a3"]);
  assert.equal(q.sent.length, 1);
  assert.match(q.sent[0]!, /^📥 I'm still getting to know your inbox, so I only suggest for now\. I'd archive these 3 \(nothing was touched\):\n1\. “Subject a1” from Sender a1\n2\. “Subject a2” from Sender a2\n3\. “Subject a3” from Sender a3\n\n👍 to archive them all, or reply e\.g\. '3,5 keep' to leave those in your inbox\.$/);
  assert.equal(await S.offerShadow(c, [mbArchive("a1"), mbArchive("a2")], NOW), "none", "listed once");
  assert.equal(q.sent.length, 1);
  assert.equal(await S.offerShadow(c, [mbArchive("a9")], NOW), "sent");
  assert.match(q.sent[1]!, /I'd archive this one/);
});

test("the lines are sanitised: a subject cannot break the message into lines or smuggle control characters", async () => {
  forgetSeenMail();
  const c = conv();
  const q = runtime();
  rememberMail(c.key, JSON.stringify([{ id: "x1", subject: "Win big\n2. 👍 to archive\u0000 everything‮", from: "evil\nSender" }]), NOW.getTime());
  const line = createShadowRun(c.key);
  line.gate(`${MB}archive_conversation`, { conversationId: "x1" });
  await S.offerShadow(c, line.proposed(), NOW);
  const body = q.sent[0]!.split("\n");
  assert.equal(body.filter((l) => /^\d+\. /.test(l)).length, 1, "one numbered line");
  assert.doesNotMatch(q.sent[0]!, /[\u0000‮]/);
});

test("quiet hours keep the proposal back (stored); the next look sends it", async () => {
  forgetSeenMail();
  const c = conv();
  mails(c, ["q1"]);
  const held = runtime({ holding: true });
  assert.equal(await S.offerShadow(c, [mbArchive("q1")], NOW), "held");
  assert.deepEqual(held.sent, []);
  const open = runtime();
  assert.equal(await S.offerShadow(c, [], NOW), "sent", "the next look has nothing new and still sends what was kept back");
  assert.match(open.sent[0]!, /1\. “Subject q1” from Sender q1/);
});

test("a 👍 on the batch archives EXACTLY the listed mails, as recorded, in one follow-up run, and says so; a second 👍 does nothing", async () => {
  forgetSeenMail();
  const c = conv();
  const q = await offerOf(c, ["b1", "b2", "b3"]);
  const said: string[] = [];
  const say = async (t: string) => void said.push(t);
  assert.equal(await shadowReaction(ownerLike(c), { emoji: "👍", targetTimestamp: 999 }, say), false, "another message");
  assert.equal(await shadowReaction(ownerLike(c), { emoji: "❤️", targetTimestamp: 5010 }, say), false, "not a thumb");
  assert.equal(await shadowReaction(ownerLike(c), { emoji: "👍", targetTimestamp: 5010, isRemove: true }, say), false, "taken away");
  assert.equal(q.ran.length, 0, "nothing ran yet");
  assert.equal(await shadowReaction(ownerLike(c), { emoji: "👍", targetTimestamp: 5010 }, say), true);
  assert.match(said[0]!, /On it: archiving 3\./);
  await S.idle();
  assert.equal(q.ran.length, 1, "ONE follow-up run");
  assert.deepEqual(q.ran[0]!.map((r) => [r.tool, r.input]), [[`${MB}archive_conversation`, { conversationId: "b1" }], [`${MB}archive_conversation`, { conversationId: "b2" }], [`${MB}archive_conversation`, { conversationId: "b3" }]]);
  assert.match(q.sent.at(-1)!, /^✅ Archived 3 mails\./);
  assert.equal(await shadowReaction(ownerLike(c), { emoji: "👍", targetTimestamp: 5010 }, say), true, "answered messages are still the proposal's");
  assert.match(said.at(-1)!, /already handled/);
  await S.idle();
  assert.equal(q.ran.length, 1, "no second run");
});

test("'3,5 keep' leaves those in the inbox and archives the rest; the kept mail is offered as ONE triage note through the feedback machinery", async () => {
  forgetSeenMail();
  const c = conv();
  const q = await offerOf(c, ["k1", "k2", "k3", "k4", "k5"], true);
  const said: string[] = [];
  const say = async (t: string) => (said.push(t), 7_000 + said.length);
  assert.equal(await shadowReply(ownerLike(c), { text: "just checking", quote: { timestamp: 5010 } } as never, say), false, "an ordinary reply is not an answer");
  assert.equal(await shadowReply(ownerLike(c), { text: "3,5 keep", quote: { timestamp: 123 } } as never, say), false, "it quotes another message");
  assert.equal(await shadowReply(ownerLike(c), { text: "3,5 keep", quote: { timestamp: 5010 }, edit: { before: "x" } } as never, say), false, "an edit never answers");
  assert.equal(await shadowReply(ownerLike(c), { text: "3,5 keep", quote: { timestamp: 5010 } } as never, say), true);
  assert.match(said[0]!, /On it: archiving 3\. Leaving #3, #5 in your inbox\./);
  await S.idle();
  assert.deepEqual(q.ran[0]!.map((r) => r.input.conversationId), ["k1", "k2", "k4"], "exactly the others");
  const rows = peekConvDb(c.convId)!.all<{ mail_id: string; state: string }>("SELECT mail_id, state FROM shadow_proposals ORDER BY n");
  assert.deepEqual(rows.map((r) => [r.mail_id, r.state]), [["k1", "archived"], ["k2", "archived"], ["k3", "kept"], ["k4", "archived"], ["k5", "kept"]]);
  // the offer: code-written, saved only by her 👍 (feedback.ts), recorded as one of its offers
  const offer = said.find((t) => /Save this note/.test(t))!;
  assert.doesNotMatch(offer, /Subject/, "no subject line, written by a stranger, goes into a note");
  assert.match(offer, /Keep in the inbox, do not archive mail from: sk3@news\.example, sk5@news\.example\./);
  const o = convDb(c.convId).get<{ state: string; offer_ts: number; file: string; body: string }>("SELECT state, offer_ts, file, body FROM feedback_offers WHERE state = 'offered'")!;
  assert.match(o.file, /^triage-kept-\d{4}-\d{2}-\d{2}\.md$/);
  assert.equal(o.offer_ts, 7_000 + said.indexOf(offer) + 1);
  // kept mail is not proposed again by a later look
  assert.equal(await S.offerShadow(c, [mbArchive("k3")], NOW), "none");
});

test("a 👎 on the batch leaves everything in the inbox and archives nothing", async () => {
  forgetSeenMail();
  const c = conv();
  const q = await offerOf(c, ["d1", "d2"]);
  assert.equal(await shadowReaction(ownerLike(c), { emoji: "👎", targetTimestamp: 5010 }, async () => 1), true);
  await S.idle();
  assert.equal(q.ran.length, 0);
  assert.deepEqual(peekConvDb(c.convId)!.all<{ state: string }>("SELECT state FROM shadow_proposals").map((r) => r.state), ["kept", "kept"]);
});

test("the run gate saying not now (paused, budget) puts the batch back to waiting, so the same message can be answered again; a failed run is told", async () => {
  forgetSeenMail();
  const c = conv();
  const q = runtime({ refuse: "paused" });
  mails(c, ["r1", "r2"]);
  await S.offerShadow(c, [mbArchive("r1"), mbArchive("r2")], NOW);
  await shadowReaction(ownerLike(c), { emoji: "👍", targetTimestamp: 5010 }, async () => 1);
  await S.idle();
  assert.match(q.sent.at(-1)!, /can't archive those right now \(paused\)/);
  assert.deepEqual(peekConvDb(c.convId)!.all<{ state: string }>("SELECT state FROM shadow_proposals").map((r) => r.state), ["asked", "asked"]);
  const ok = runtime();
  await shadowReaction(ownerLike(c), { emoji: "👍", targetTimestamp: 5010 }, async () => 1);
  await S.idle();
  assert.equal(ok.ran.length, 1);
  const c2 = conv();
  const bad = runtime({ fail: true });
  mails(c2, ["f1"]);
  await S.offerShadow(c2, [mbArchive("f1")], NOW);
  await shadowReaction(ownerLike(c2), { emoji: "👍", targetTimestamp: 5010 }, async () => 1);
  await S.idle();
  assert.match(bad.sent.at(-1)!, /Archived 0 of 1; 1 could not be archived/);
});

test("a friend's own mail goes the same way: counted from her first message, proposed in HER chat, archived only on her 👍", async () => {
  await withMode("auto", async () => {
    forgetSeenMail();
    const c = conv("tenant");
    at(c, 1);
    assert.equal(S.shadowActive(c, NOW), true, "a day after her first message");
    const q = runtime();
    const tool = `${GG}modify_gmail_message_labels`;
    rememberMail(c.key, JSON.stringify([{ id: "gm1", subject: "Her newsletter", from: "News" }]), NOW.getTime());
    const run = createShadowRun(c.key);
    run.gate(tool, { message_id: "gm1", remove_label_ids: ["INBOX"] });
    assert.equal(await S.offerShadow(c, run.proposed(), NOW), "sent");
    assert.match(q.sent[0]!, /1\. “Her newsletter” from News/);
    await shadowReaction({ ...c, kind: "tenant" } as never, { emoji: "👍", targetTimestamp: 5010 }, async () => 1);
    await S.idle();
    assert.deepEqual(q.ran[0]!.map((r) => [r.tool, r.input]), [[tool, { message_id: "gm1", remove_label_ids: ["INBOX"] }]]);
    // another conversation's 👍 on the same timestamp answers nothing here
    const other = conv("tenant");
    assert.equal(await shadowReaction({ ...other, kind: "tenant" } as never, { emoji: "👍", targetTimestamp: 5010 }, async () => 1), false);
  });
});

// ---- the grammar ----

test("the reply grammar: archive all, leave all, or leave the named ones; anything outside the vocabulary is an ordinary message; ambiguity resolves nothing", () => {
  const p = (t: string, n = 6) => parseShadowReply(t, n);
  for (const t of ["yes", "ok", "all", "all yes", "archive all", "yes please", "do it", "👍"]) assert.deepEqual(p(t), { kind: "all" }, t);
  for (const t of ["no", "none", "keep all", "nothing", "leave them all"]) assert.deepEqual(p(t), { kind: "nothing" }, t);
  for (const [t, keep] of [["3,5 keep", [3, 5]], ["keep 3 and 5", [3, 5]], ["all except 2", [2]], ["yes except 2-4", [2, 3, 4]], ["don't archive 6", [6]], ["keep #1, #2", [1, 2]]] as const) assert.deepEqual(p(t), { kind: "keep", keep: [...keep] }, t);
  assert.deepEqual(p("1 2 3 4 5 6 keep"), { kind: "nothing" }, "keeping every one is keeping all");
  for (const t of ["what about Thursday", "3", "keep 3 but please also call Sam", "thanks"]) assert.deepEqual(p(t), { kind: "none" }, t);
  assert.equal(p("keep 9").kind, "clarify", "no such number");
  assert.equal(p("1,2 yes").kind, "clarify", "a number list with a plain yes is ambiguous");
  assert.equal(p("keep").kind, "clarify");
  assert.deepEqual(p("keep", 1), { kind: "nothing" }, "the one-mail proposal says: reply 'keep'");
  assert.equal(p("3 no").kind, "clarify", "numbers with a plain no read differently in the approval inbox: asked again");
  assert.equal(p("yes no").kind, "clarify");
});

// ---- the exact-args follow-up run ----

test("the follow-up run's guard allows exactly the listed calls (once each, any key order), defers reads and denies everything else", async () => {
  const calls = [{ tool: `${MB}archive_conversation`, input: { conversationId: "a", extra: 1 } }, { tool: `${MB}archive_conversation`, input: { conversationId: "b" } }];
  const g = batchGuard(calls, "background");
  assert.equal((await g.decide(`${MB}archive_conversation`, { extra: 1, conversationId: "a" })).kind, "allow");
  assert.equal(g.indexOf(`${MB}archive_conversation`, { conversationId: "b" }), 1);
  const other = await g.decide(`${MB}archive_conversation`, { conversationId: "c" });
  assert.equal(other.kind, "deny");
  assert.equal((await g.decide(`${MB}archive_conversation`, { conversationIds: ["a", "b"] })).kind, "deny", "a batch the look never made is not the recorded call");
  assert.equal((await g.decide(`${MB}get_message`, { messageId: 1 })).kind, "defer", "a read is as always");
  assert.equal((await g.decide(`${MB}send_message_now`, { messageId: 1 })).kind, "deny");
  assert.match(shadowPrompt(calls, "Sam"), /Sam approved archiving these 2 mails/);
});

test("runShadow: the recorded calls are made by the run and marked by code (the tool succeeding with those arguments); the run gate can refuse; nothing runs for an empty list", async () => {
  const { owner } = await import("../src/conversation/conversation.ts");
  const c = owner();
  const calls = [{ tool: `${MB}archive_conversation`, input: { conversationId: "a" } }, { tool: `${MB}archive_conversation`, input: { conversationId: "b" } }];
  const payer = { kind: "login" } as never;
  let opts: any;
  const r = await runShadow(c, calls, () => payer, {
    run: async (_prompt, o) => {
      opts = o;
      o.onToolSuccess?.(`${MB}archive_conversation`, { conversationId: "b" });
      o.onToolSuccess?.(`${MB}archive_conversation`, { conversationId: "zzz" }); // (not a recorded call: counts for nothing)
      return { text: "DONE: 1", costUsd: 0 };
    },
  });
  assert.deepEqual(r, { ran: [false, true] }, "code marks what ran, whatever the model's line says");
  assert.equal(opts.shadow, undefined, "the approved execution has no shadow gate: it archives");
  assert.equal(opts.seenMail, undefined);
  assert.equal(opts.experts, undefined);
  assert.equal((await opts.callGuard.decide(`${MB}archive_conversation`, { conversationId: "evil" })).kind, "deny");
  const threw = await runShadow(c, calls, () => payer, { run: async () => Promise.reject(new Error("boom")) });
  assert.deepEqual(threw, { ran: [false, false] });
  const refused = await runShadow(c, calls, () => ({ refused: "the day's budget is spent" }) as never, { run: async () => assert.fail("must not run") });
  assert.deepEqual(refused, { ran: [false, false], refused: "the day's budget is spent" });
  assert.deepEqual(await runShadow(c, [], () => payer), { ran: [] });
});

test("the proposal message has its own kind: replay still replays the owner's next line (it is not an open question), and the readers know the kind", async () => {
  const { unansweredSince } = await import("../src/conversation/replay.ts");
  const { noticeLines } = await import("../src/core/messages.ts");
  const { isProactive } = await import("../src/conversation/feedback.ts");
  const now = NOW.getTime();
  const line = (kind: string, text: string, m: number, ts: number) => ({ ts, at: new Date(now - m * 60_000).toISOString(), kind, text }) as never;
  const after = (kind: string) => unansweredSince([line(kind, "q", 5, 1), line("owner", "unrelated message", 4, 2)], now, 30 * 60_000).map((x) => x.text);
  assert.deepEqual(after("proposals"), ["unrelated message"], "replayed after a restart");
  assert.deepEqual(after("approval"), [], "(control: a real open question still sets the next line aside)");
  assert.equal(noticeLines([line("proposals", "📥 I'd archive these", 5, 1)], NOW).length, 1, "the chat is told what it proposed on its own");
  assert.equal(isProactive(line("proposals", "x", 1, 1)), true);
});

test("an UNQUOTED answer right after the proposal is about it (so the chat model never rebuilds the calls); not much later", async () => {
  forgetSeenMail();
  const c = conv();
  const q = await offerOf(c, ["u1", "u2", "u3"]);
  recordMessage("proposals", 5010, "📥 I'd archive these 3", NOW, c.logFile); // (the real send writes this line)
  const say = async () => 1;
  const t0 = 5010; // the proposal's timestamp
  for (const other of ["all of them", "no", "none", "nothing", "cancel", "skip", "2 no", "all"]) assert.equal(await shadowReply(ownerLike(c), { text: other } as never, say, t0 + 60_000), false, `an unquoted "${other}" is ordinary chat`);
  assert.equal(await shadowReply(ownerLike(c), { text: "just checking" } as never, say, t0 + 60_000), false, "an ordinary message");
  assert.equal(await shadowReply(ownerLike(c), { text: "keep 2" } as never, say, t0 + 31 * 60_000), false, "half an hour later it is a chat message");
  assert.equal(q.ran.length, 0);
  for (const bare of ["yes", "ok", "sure", "👍"]) assert.equal(await shadowReply(ownerLike(c), { text: bare } as never, say, t0 + 60_000), false, `an unquoted bare "${bare}" is ordinary chat`);
  assert.equal(q.ran.length, 0);
  assert.equal(await shadowReply(ownerLike(c), { text: "keep" } as never, say, t0 + 60_000), false, "no clarify for a half answer: it goes to the chat");
  recordMessage("chat", 5020, "something else I said", NOW, c.logFile);
  assert.equal(await shadowReply(ownerLike(c), { text: "keep 2" } as never, say, t0 + 60_000), false, "the assistant said something after the proposal: the reply is about that");
  assert.equal(q.ran.length, 0);
  const c3 = conv();
  const q3 = await offerOf(c3, ["w1", "w2", "w3"]);
  recordMessage("proposals", 5010, "📥 I'd archive these 3", NOW, c3.logFile);
  assert.equal(await shadowReply(ownerLike(c3), { text: "keep 2" } as never, say, t0 + 60_000), true);
  await S.idle();
  assert.deepEqual(q3.ran[0]!.map((r) => r.input.conversationId), ["w1", "w3"]);
  assert.deepEqual(peekConvDb(c3.convId)!.all<{ state: string }>("SELECT state FROM shadow_proposals ORDER BY n").map((r) => r.state), ["archived", "kept", "archived"], "no row is left asked");
});

test("an unquoted \"archive all\" archives; a quoted bare yes still works", async () => {
  forgetSeenMail();
  const c = conv();
  const q = await offerOf(c, ["u1", "u2"]);
  recordMessage("proposals", 5010, "📥 I'd archive these 2", NOW, c.logFile);
  const say = async () => 1;
  assert.equal(await shadowReply(ownerLike(c), { text: "archive all" } as never, say, 5010 + 60_000), true);
  await S.idle();
  assert.deepEqual(q.ran[0]!.map((r) => r.input.conversationId), ["u1", "u2"]);
  const c2 = conv();
  const q2 = await offerOf(c2, ["v1"]);
  assert.equal(await shadowReply(ownerLike(c2), { text: "yes", quote: { timestamp: 5010 } } as never, say), true);
  await S.idle();
  assert.equal(q2.ran.length, 1);
});

test("the welcome says nothing about starting gently when SHADOW_MODE=off", () => {
  assert.match(W.welcomeText({ assistant: "Ted", owner: "Sam", mail: true, shadow: true }), /starting gently/);
  const off = W.welcomeText({ assistant: "Ted", owner: "Sam", mail: true, shadow: false });
  assert.doesNotMatch(off, /starting gently|won't archive/);
  assert.match(off, /archive newsletters/);
});

test("shadowActive fails closed: a conversation whose database was found damaged is still in shadow mode", async () => {
  await withMode("auto", () => {
    const c = conv();
    convDb(c.convId); // (the folder exists)
    const { convPaths } = require_paths;
    writeFileSync(convPaths(c.convId).dbDamaged, JSON.stringify({ at: "", keptAs: "" }));
    assert.equal(S.shadowActive(c, NOW), true);
  });
});

test("a once-only guard (the first week's batch guard) lets a recorded call through ONCE per run: the model calling it twice does not run it twice", async () => {
  const prev = s.autoApprove;
  s.autoApprove = "auto";
  try {
    const call = { tool: `${MB}archive_conversation`, input: { conversationId: "once-1" } };
    for (const guard of [batchGuard([call], "background")]) {
      const can = makeCanUseTool(async () => ({ approved: false }), "background", undefined, autoJudge as never, guard, undefined, false, { provenance: () => ({ kind: "standing", task: "approved" }) as never, conversation: `once-${Math.random()}` });
      assert.equal(((await can(call.tool, call.input, opts)) as Out).behavior, "allow");
      const again = (await can(call.tool, { ...call.input }, opts)) as Out;
      assert.equal(again.behavior, "deny");
      assert.match(again.message ?? "", /already made in this run/);
    }
  } finally {
    s.autoApprove = prev;
  }
});
