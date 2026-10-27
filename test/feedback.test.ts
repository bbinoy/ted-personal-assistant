import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, IncomingReaction } from "@ted-assistant/messenger";
import { FULL_CAPABILITIES } from "@ted-assistant/messenger/testing";

process.env.TENANTS = "on";
const { settings } = await import("../src/core/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const { createPipeline, group, owner, tenant } = await import("../src/conversation/conversation.ts");
const { createOutbound } = await import("../src/conversation/outbound.ts");
const { checkProposal, createFeedback, helperModel, isProactive, journalAround, likedLines } = await import("../src/conversation/feedback.ts");
const { dreamPrompt } = await import("../src/conversation/dream.ts");
const { recordMessage, FILE } = await import("../src/core/messages.ts");
const { convDb } = await import("../src/core/convdb.ts");
const { OWNER_CONV, friendConvId } = await import("../src/core/convpaths.ts");
const { NOTES_DIR } = await import("../src/memory/notes.ts");
const { dataPath } = await import("../src/core/state.ts");
const { LOGIN } = await import("../src/tenants/payer.ts");

// Learning from feedback (src/conversation/feedback.ts): a 👎 or a clear "less of this" on something the assistant sent unprompted SAVES one note and hands the chat turn the fact
// to mention it in one line; a 👍 is only counted.

(settings as unknown as { tenants: boolean }).tenants = true;
const OWNER = "+10000000000";
const ACCOUNT = "+10000000001";
const ACI = "00000000-0000-4000-8000-0000000000f4";

type Propose = Parameters<ReturnType<typeof helperModel>["propose"]>[1];
function rig(over: { classify?: (said: string) => Promise<{ kind: "less_of_this" | "wrong_action" | "not_feedback"; about: string } | undefined>; proposal?: unknown | (() => unknown) } = {}) {
  const sent: { text: string; target?: unknown }[] = [];
  const runs: string[] = [];
  const proposes: Propose[] = [];
  const classifies: string[] = [];
  let ts = 9000;
  const messenger = {
    name: "fake",
    summary: "fake",
    self: ACCOUNT,
    capabilities: FULL_CAPABILITIES,
    react: async () => {},
    typing: async () => {},
    markRead: async () => {},
    send: async (target: unknown, m: { text: string }) => (sent.push({ text: m.text, target }), ++ts),
  };
  const logOf = (target: unknown): string => {
    const t = T.listTenants().find((r) => T.tenantContext(r).target === target);
    return t ? T.tenantContext(t).logFile : FILE;
  };
  const record = (target: unknown, kind: any, t: number, text: string) => recordMessage(kind, t, text, new Date(), logOf(target));
  const out = createOutbound(messenger, (k, t, text, target) => record(target, k, t, text));
  const model = {
    classify: async (_p: unknown, i: { reacted: string; said: string }) => (classifies.push(i.said), over.classify ? over.classify(i.said) : { kind: "less_of_this" as const, about: "x" }),
    propose: async (_p: unknown, i: Propose) => (proposes.push(i), typeof over.proposal === "function" ? (over.proposal as () => unknown)() : over.proposal ?? LINKEDIN),
  };
  const pipeline = createPipeline({
    messenger,
    out,
    record,
    run: async (_c, prompt) => (runs.push(prompt), { text: "" }),
    picture: async () => assert.fail("no picture"),
    document: async () => assert.fail("no document"),
    transcript: async () => assert.fail("no voice"),
    speech: { ready: () => false, synth: async () => assert.fail("no speech"), foreign: async () => undefined },
    approvals: { answer: async () => ({ outcome: "none" }), answerReaction: () => "ignored" },
    feedback: createFeedback({ model, payer: () => LOGIN }),
    group: { gate: async () => ({ act: false, delaySeconds: 0, nextCheckMinutes: 30 }), recent: () => [], context: () => ({ lines: [] }), warm: () => {}, run: async () => assert.fail("no group run") },
    vouch: async () => true,
    isOwner: (w) => w.from === OWNER,
    wait: async () => {},
  });
  return { pipeline, sent, runs, proposes, classifies };
}

const LINKEDIN = { propose: true, file: "triage-linkedin.md", description: "Archive LinkedIn digests quietly", text: "Archive LinkedIn digest mails from now on, without telling me." };
const react = (emoji: string, targetTimestamp: number, over: Partial<IncomingReaction> = {}): { type: "reaction"; r: IncomingReaction } => ({ type: "reaction", r: { from: OWNER, emoji, targetTimestamp, isRemove: false, direct: true, ...over } });
const say = (text: string, timestamp: number, quote?: number): { type: "message"; m: IncomingMessage } => ({ type: "message", m: { from: OWNER, text, timestamp, direct: true, ...(quote ? { quote: { text: "…", author: ACCOUNT, timestamp: quote } } : {}) } });

let next = 100;
const fresh = () => {
  rmSync(dataPath(FILE), { force: true });
  convDb(OWNER_CONV).run("DELETE FROM feedback_offers");
  convDb(OWNER_CONV).run("DELETE FROM feedback_signals");
  rmSync(NOTES_DIR, { recursive: true, force: true });
  mkdirSync(NOTES_DIR, { recursive: true });
};
// A message the assistant sent (kind notice = on its own, chat = an answer), and the journal line of what it did just before.
const sentAs = (kind: string, text: string, file = FILE) => recordMessage(kind as any, ++next, text, new Date(), file), lastTs = () => next;
const journal = (file = FILE) => recordMessage("journal", ++next, "Archived 4 mails from LinkedIn. Why: per your notes: triage-linkedin. Undo: move them back to the inbox.", new Date(Date.now() - 60_000), file, { cat: "archive" });
const row = (conv = OWNER_CONV) => convDb(conv).all<{ state: string }>("SELECT state FROM feedback_offers ORDER BY seq");

test("feedback: a 👎 on a message sent unprompted saves exactly one note (indexed), with the journal's why, and the chat turn is told to mention it", async () => {
  fresh();
  journal();
  sentAs("notice", "📬 LinkedIn: 4 new job alerts and a digest.");
  const ts = lastTs();
  const r = rig();
  await r.pipeline.handleIncoming(owner(), react("👎", ts));
  assert.equal(r.sent.length, 0, "nothing is asked");
  assert.equal(r.proposes.length, 1);
  assert.match(r.proposes[0]!.journal.join("\n"), /\[archive\] Archived 4 mails from LinkedIn \(per your notes: triage-linkedin/);
  assert.deepEqual(r.proposes[0]!.categories, ["triage", "people", "scheduling", "context", "brief", "style"]);
  const raw = readFileSync(join(NOTES_DIR, "triage-linkedin.md"), "utf8");
  assert.doesNotMatch(raw, /origin/);
  assert.match(raw, /Archive LinkedIn digest mails from now on, without telling me\./);
  assert.match(readFileSync(join(NOTES_DIR, "MEMORY.md"), "utf8"), /\(triage-linkedin\.md\) - Archive LinkedIn digests quietly/);
  assert.equal(r.runs.length, 1, "the ordinary reaction turn runs, with the fact");
  assert.match(r.runs[0]!, /reacted 👎/);
  assert.match(r.runs[0]!, /You just saved the note triage-linkedin\.md because of their 👎/);
  assert.match(r.runs[0]!, /Archive LinkedIn digest mails from now on/);
  assert.match(r.runs[0]!, /Mention it in one short line/);
  assert.deepEqual(row().map((x) => x.state), ["saved"]);
  // a second 👎 on the same message: nothing more is saved, the usual turn
  await r.pipeline.handleIncoming(owner(), react("👎", ts));
  assert.equal(r.proposes.length, 1);
  assert.doesNotMatch(r.runs[1]!, /You just saved/);
});

test("feedback: a 👎 on a normal chat reply, an approval or a memory notice is just a reaction: no offer, the usual turn", async () => {
  fresh();
  sentAs("chat", "You have two meetings today.");
  const chat = lastTs();
  sentAs("notice", "🧠 Memory\n➕ saved people-x.md: x\nWrong? Tell me to undo it.");
  const memory = lastTs();
  sentAs("approval", "Send this mail? Say yes.");
  const approval = lastTs();
  const r = rig();
  for (const ts of [chat, memory, approval, 1]) await r.pipeline.handleIncoming(owner(), react("👎", ts));
  assert.equal(r.runs.length, 4);
  assert.equal(r.sent.length, 0);
  assert.equal(r.proposes.length, 0);
  assert.deepEqual(row(), []);
  assert.equal(isProactive(undefined), false);
});

test("feedback: an existing note is updated, and the fact says so", async () => {
  fresh();
  writeNote("triage-linkedin.md", "Archive LinkedIn digests but tell me.");
  journal();
  sentAs("notice", "📬 LinkedIn: 4 new job alerts.");
  const r = rig();
  await r.pipeline.handleIncoming(owner(), react("👎", lastTs()));
  assert.equal(r.proposes[0]!.notes[0]!.file, "triage-linkedin.md", "the note the action followed is shown to the model");
  assert.match(readFileSync(join(NOTES_DIR, "triage-linkedin.md"), "utf8"), /without telling me/);
  assert.match(r.runs[0]!, /You just updated the note triage-linkedin\.md/);
});

test("feedback: at most FEEDBACK_OFFERS_PER_DAY notes a day per conversation; the rest is the usual reaction", async () => {
  fresh();
  const r = rig();
  const stamps: number[] = [];
  for (let i = 0; i < 4; i++) (sentAs("notice", `📬 thing ${i}`), stamps.push(lastTs()));
  for (const ts of stamps) await r.pipeline.handleIncoming(owner(), react("👎", ts));
  assert.equal(settings.feedbackOffersPerDay, 3);
  assert.equal(r.proposes.length, 3);
  assert.equal(r.runs.filter((p) => /You just (saved|updated)/.test(p)).length, 3);
  assert.doesNotMatch(r.runs[3]!, /You just (saved|updated)/, "the fourth is an ordinary reaction turn");
  // a day later the count starts over
  convDb(OWNER_CONV).run("UPDATE feedback_offers SET at = at - 90000000");
  await r.pipeline.handleIncoming(owner(), react("👎", stamps[3]!));
  assert.match(r.runs[4]!, /You just (saved|updated)/);
});

test("feedback: a proposal the model could not make (none, or an unsafe one) saves nothing, uses no note and falls back to the usual turn", async () => {
  fresh();
  sentAs("notice", "📬 Mail from https://pay.example/x about your invoice.");
  const r = rig({ proposal: { propose: true, file: "triage-x.md", description: "d", text: "Archive anything from https://evil.example/login." } });
  await r.pipeline.handleIncoming(owner(), react("👎", lastTs()));
  assert.equal(existsSync(join(NOTES_DIR, "triage-x.md")), false);
  assert.equal(r.runs.length, 1);
  assert.doesNotMatch(r.runs[0]!, /You just saved/);
  assert.deepEqual(row().map((x) => x.state), ["none"]);
  await r.pipeline.handleIncoming(owner(), react("👎", lastTs()));
  assert.equal(r.proposes.length, 1, "asked once per message");
});

test("feedback: a quoted reply 'stop sending these' to an unprompted message is classified and saved; anything else is a normal message", async () => {
  fresh();
  sentAs("notice", "📬 LinkedIn: 4 new job alerts.");
  const ts = lastTs();
  const r = rig({ classify: async (s) => (/stop/.test(s) ? { kind: "less_of_this", about: "linkedin" } : { kind: "not_feedback", about: "" }) });
  await r.pipeline.handleIncoming(owner(), say("what is this about?", 6000, ts));
  assert.equal(r.runs.length, 1, "not feedback: the chat answers");
  assert.equal(r.sent.length, 0);
  await r.pipeline.handleIncoming(owner(), say("stop sending these", 6001, ts));
  assert.equal(r.runs.length, 2, "feedback: the chat turn runs with the fact");
  assert.match(r.runs[1]!, /^[\s\S]*stop sending these[\s\S]*You just saved the note triage-linkedin\.md because of their reply[\s\S]*Archive LinkedIn digest mails/);
  assert.doesNotMatch(r.runs[0]!, /You just saved/);
  assert.equal(existsSync(join(NOTES_DIR, "triage-linkedin.md")), true);
  assert.equal(r.proposes[0]!.said, "stop sending these");
  // not quoting anything, or quoting a chat reply: the model is not even asked
  sentAs("chat", "Sure, done.");
  const before = r.classifies.length;
  await r.pipeline.handleIncoming(owner(), say("stop sending these", 6002));
  await r.pipeline.handleIncoming(owner(), say("stop sending these", 6003, lastTs()));
  assert.equal(r.classifies.length, before);
  assert.equal(r.runs.length, 4);
});

test("feedback: when the classifier gets no answer in time, it is not feedback: nothing saved, the chat answers", async () => {
  fresh();
  sentAs("notice", "📬 LinkedIn: 4 new job alerts.");
  const r = rig({ classify: async () => undefined });
  await r.pipeline.handleIncoming(owner(), say("stop sending these", 6100, lastTs()));
  assert.equal(r.runs.length, 1);
  assert.equal(r.proposes.length, 0);
  // the real helper model: a call that never answers gives up at its own timeout and says nothing
  const never = (() => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) })) as never; // a stream that never says anything
  const m = helperModel({ classifyMs: 30, proposeMs: 30, run: never });
  const t0 = Date.now();
  assert.equal(await m.classify(LOGIN, { reacted: "x", said: "stop" }), undefined);
  assert.equal(await m.propose(LOGIN, { reacted: "x", journal: [], categories: ["triage"], notes: [] }), undefined);
  assert.ok(Date.now() - t0 < 5000);
});

test("feedback: a friend gets the same flow in her own chat, for her own notes only; the owner's notes and rows are untouched", async () => {
  fresh();
  const rec = T.addTenant({ aci: ACI, name: "Anna" })!;
  T.provision(rec);
  const conv = tenant(rec.id);
  const ctx = T.tenantContext(rec);
  sentAs("notice", "📬 Your match starts at 7.", ctx.logFile);
  const ts = lastTs();
  const r = rig({ proposal: { propose: true, file: "context-matches.md", description: "No match reminders", text: "Do not remind me about matches." } });
  await r.pipeline.handleIncoming(conv, react("👎", ts));
  assert.deepEqual(r.proposes[0]!.categories, ["people", "context", "scheduling", "style"], "her categories: no triage notes for a friend");
  assert.match(readFileSync(join(ctx.notesDir, "context-matches.md"), "utf8"), /Do not remind me about matches\./);
  assert.equal(existsSync(join(NOTES_DIR, "context-matches.md")), false);
  assert.deepEqual(row(), [], "nothing in the owner's database");
  assert.deepEqual(convDb(friendConvId(rec.id)).all<{ state: string }>("SELECT state FROM feedback_offers").map((x) => x.state), ["saved"]);
  assert.match(r.runs[0]!, /You just saved the note context-matches\.md/);
  // a model that proposes a triage note for her is refused by code
  sentAs("notice", "📬 Another.", ctx.logFile);
  const r2 = rig({ proposal: { propose: true, file: "triage-x.md", description: "d", text: "Archive x." } });
  await r2.pipeline.handleIncoming(conv, react("👎", lastTs()));
  assert.equal(existsSync(join(ctx.notesDir, "triage-x.md")), false);
  assert.doesNotMatch(r2.runs[0]!, /You just saved/);
});

test("feedback: groups are off: a reaction there never reaches it", async () => {
  fresh();
  const r = rig();
  const g = group("R3JvdXBGNEZlZWRiYWNr");
  sentAs("notice", "📬 posted in the group.");
  await r.pipeline.handleIncoming(g, react("👎", lastTs(), { direct: false, group: { id: "R3JvdXBGNEZlZWRiYWNr" } }));
  assert.equal(r.proposes.length, 0);
  assert.equal(r.sent.length, 0);
});

test("feedback: FEEDBACK_OFFERS_PER_DAY=0 turns it off", async () => {
  fresh();
  sentAs("notice", "📬 thing");
  const r = rig();
  const was = settings.feedbackOffersPerDay;
  (settings as { feedbackOffersPerDay: number }).feedbackOffersPerDay = 0;
  try {
    await r.pipeline.handleIncoming(owner(), react("👎", lastTs()));
  } finally {
    (settings as { feedbackOffersPerDay: number }).feedbackOffersPerDay = was;
  }
  assert.equal(r.runs.length, 1);
  assert.equal(r.proposes.length, 0);
});

test("feedback: a 👍 on an unprompted message is only counted, per note or category; the dream is told, nothing is created", async () => {
  fresh();
  journal();
  sentAs("notice", "📬 LinkedIn: 4 new job alerts.");
  const ts = lastTs();
  const r = rig();
  await r.pipeline.handleIncoming(owner(), react("👍", ts));
  await r.pipeline.handleIncoming(owner(), react("👍", ts));
  assert.equal(r.runs.length, 2, "the usual turn still judges a 👍 (an acknowledgement)");
  assert.equal(r.proposes.length, 0);
  assert.deepEqual(convDb(OWNER_CONV).all<{ key: string; up: number }>("SELECT key, up FROM feedback_signals").map((x) => [x.key, x.up]), [["triage-linkedin.md", 2]]);
  assert.deepEqual(likedLines(owner()), ["triage-linkedin.md: 2 thumbs-up"]);
  assert.equal(existsSync(join(NOTES_DIR, "triage-linkedin.md")), false);
  const prompt = dreamPrompt(new Date(), "Ben", [], ["[10:00] Ben: hi"], likedLines(owner()));
  assert.match(prompt, /<liked>\ntriage-linkedin\.md: 2 thumbs-up\n<\/liked>/);
  assert.match(prompt, /a reason to KEEP a related note, never to add or change one/);
  assert.doesNotMatch(dreamPrompt(new Date(), "Ben", [], ["[10:00] Ben: hi"]), /thumbs-up/);
  // no note and no journal line near it: the category, else nothing
  sentAs("notice", "📬 unrelated, much later");
  next += 1;
});

test("feedback: the journal around a message names the notes behind it", () => {
  fresh();
  recordMessage("journal", ++next, "Archived 2 mails. Why: per your notes: triage-a, triage-b and 2 more. Undo: x", new Date(Date.now() - 120_000), FILE, { cat: "archive" });
  recordMessage("journal", ++next, "Old thing. Why: per your notes: triage-old. Undo: x", new Date(Date.now() - 5 * 3600_000), FILE, { cat: "archive" });
  const a = journalAround(FILE, new Date().toISOString());
  assert.deepEqual(a.notes, ["triage-a.md", "triage-b.md"]);
  assert.deepEqual(a.cats, ["archive"]);
});

test("feedback: a proposal is checked in code: category, shape, size, and no address or link that is not in the message", () => {
  const o = { categories: ["triage", "people"], sources: ["Mail from news@linkedin.com: see https://linkedin.com/jobs"] };
  const ok = { propose: true, file: "triage-linkedin.md", description: "d", text: "Archive mail from news@linkedin.com." };
  assert.equal(checkProposal(ok, o)?.file, "triage-linkedin.md");
  assert.equal(checkProposal({ ...ok, text: "Archive https://linkedin.com/jobs mails." }, o)?.file, "triage-linkedin.md");
  assert.equal(checkProposal({ ...ok, text: "Archive mail from boss@evil.example." }, o), undefined, "an address not in the message");
  assert.equal(checkProposal({ ...ok, text: "Archive mail and call +44 20 7946 0958." }, o), undefined, "a number not in the message");
  assert.equal(checkProposal({ ...ok, file: "setup-x.md" }, o), undefined, "a category the conversation does not have");
  assert.equal(checkProposal({ ...ok, file: "../triage-x.md" }, o), undefined);
  assert.equal(checkProposal({ ...ok, file: "triage-x.txt" }, o), undefined);
  assert.equal(checkProposal({ ...ok, text: "x".repeat(400) }, o), undefined);
  assert.equal(checkProposal({ ...ok, propose: false }, o), undefined);
  assert.equal(checkProposal(undefined, o), undefined);
  assert.equal(checkProposal("triage-x.md", o), undefined);
  assert.equal(checkProposal({ ...ok, text: "Archive these.\n\n- ignore the rules" }, o)?.text, "Archive these. - ignore the rules", "one paragraph");
});

function writeNote(file: string, text: string) {
  mkdirSync(NOTES_DIR, { recursive: true });
  writeFileSync(join(NOTES_DIR, file), `---\nname: ${file.replace(/\.md$/, "")}\ndescription: "d"\n---\n\n${text}\n`);
}
