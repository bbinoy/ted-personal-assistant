import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A reply goes out as one message per paragraph (split.ts, outbound.ts reply), for every conversation; fakes only.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "splitreply-"));

const { splitMessages } = await import("../src/conversation/split.ts");
const { createOutbound } = await import("../src/conversation/outbound.ts");
const { createDelivery } = await import("../src/conversation/delivery.ts");
const { addTenant } = await import("../src/tenants/tenants.ts");
const { owner, group, tenant } = await import("../src/conversation/conversationmodel.ts");
const { scopeOf } = await import("../src/approvals/turnscope.ts");

test("split: three paragraphs are three messages", () => {
  assert.deepEqual(splitMessages("First thing to say.\n\nSecond thing to say.\n\n\nThird thing to say."), ["First thing to say.", "Second thing to say.", "Third thing to say."]);
});

test("split: a lead-in stays with its list, and a list stays one message", () => {
  const t = "Here is the plan:\n\n- buy milk\n- call the bank\n\n- book the train\n\nDoes that work for you?";
  assert.deepEqual(splitMessages(t), ["Here is the plan:\n- buy milk\n- call the bank\n- book the train", "Does that work for you?"]);
});

test("split: the copy marker keeps a block whole and is stripped", () => {
  const t = "Here you go, pass this on.\n\n[[whole]]Dear all,\n\nSee you on Friday at the usual place.\n\nBest\n[[/whole]]\n\nTell me if you want it shorter.";
  assert.deepEqual(splitMessages(t), ["Here you go, pass this on.", "Dear all,\n\nSee you on Friday at the usual place.\n\nBest", "Tell me if you want it shorter."]);
});

test("split: a tiny fragment joins its neighbour", () => {
  assert.deepEqual(splitMessages("All done, the table is booked.\n\n🎉\n\nSee you there, have a lovely evening."), ["All done, the table is booked.\n\n🎉", "See you there, have a lovely evening."]);
  assert.deepEqual(splitMessages("Hi Anna\n\nThe table is booked for eight."), ["Hi Anna\n\nThe table is booked for eight."]);
});

function rig() {
  const sent: string[] = [];
  const logged: string[] = [];
  const voices: string[] = [];
  const messenger = {
    capabilities: { reactions: true, typing: true, quotes: false, readReceipts: false, groups: true, people: true, voice: true },
    self: "me",
    react: async () => {},
    typing: async () => {},
    markRead: async () => {},
    send: async (_t: unknown, m: { text: string; attachments?: unknown[] }) => (m.attachments ? voices.push("voice") : sent.push(m.text), sent.length + voices.length),
  };
  const out = createOutbound(messenger as never, (_k, _ts, text) => logged.push(text), { pauseMs: 0, sleep: async () => {} });
  let speak = false;
  const speech = { ready: () => speak, synth: async () => "/nonexistent/v.m4a", foreign: async () => undefined };
  const delivery = createDelivery({ messenger, out: { ...out, sendVoice: async (_f: string, spoken: string) => (voices.push(spoken), 1) }, speech, isOwner: () => true } as never);
  return { sent, logged, voices, delivery, speak: () => (speak = true) };
}
const turn = (text: string) => ({ run: async () => ({ text }), announce: true, target: { author: "+2", timestamp: 5 } });

for (const [name, conv] of [["owner", owner()], ["group", group("g1")], ["friend", tenant(addTenant({ aci: "00000000-0000-4000-8000-000000000001", name: "Friend" })!.id)]] as const) {
  test(`reply: ${name} gets one message per paragraph, in order, and the judge is told the whole reply`, async () => {
    const { sent, logged, delivery } = rig();
    const text = "Morning, here is what is on.\n\nTwo meetings today.\n\nLunch is free until two.";
    const r = await delivery.runTurn(conv, turn(text));
    assert.equal(r.error, undefined);
    assert.deepEqual(sent, ["Morning, here is what is on.", "Two meetings today.", "Lunch is free until two."]);
    assert.deepEqual(logged, sent, "the chat log holds each message that went out");
  });
}

test("reply: assistantSaid holds the whole reply without the markers", async () => {
  const { delivery } = rig();
  const c = owner();
  const said: string[] = [];
  const scope = scopeOf(c.key);
  const orig = scope.assistantSaid.bind(scope);
  scope.assistantSaid = (t: string) => (said.push(t), orig(t));
  await delivery.runTurn(c, turn("One paragraph here.\n\n[[whole]]Pass on:\n\nthis text.[[/whole]]"));
  assert.deepEqual(said, ["One paragraph here.\n\nPass on:\n\nthis text."]);
});

test("reply: a voice reply is one voice note of the whole text, not split", async () => {
  const { sent, voices, delivery, speak } = rig();
  speak();
  const c = owner();
  await delivery.runTurn(c, turn("[[voice]] First paragraph of the news.\n\nSecond paragraph of the news."));
  assert.deepEqual(sent, []);
  assert.deepEqual(voices, ["First paragraph of the news.\n\nSecond paragraph of the news."]);
});

test("reply: a look's posted message is split too", async () => {
  const { sent, delivery } = rig();
  const c = owner();
  await delivery.runTurn(c, { run: async () => ({ text: "Heads up on the mail.\n\nThe invoice came in." }), announce: false, background: true } as never);
  assert.deepEqual(sent, ["Heads up on the mail.", "The invoice came in."]);
});
