import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutbound, fitParts } from "../src/outbound.ts";
import { toSignalStyles } from "@ted-assistant/signal/messenger";
import { FakeMessenger } from "@ted-assistant/messenger/testing";
import type { OutgoingMessage } from "@ted-assistant/messenger";

// A fake messenger that records what is sent and can deliver the echo BEFORE the send returns.
function fake(caps: ConstructorParameters<typeof FakeMessenger>[0] = {}) {
  const messenger = new FakeMessenger(caps);
  const sent = messenger.sent;
  return { messenger, sent, styles: (i: number) => toSignalStyles(sent[i]!.message.styles ?? []) };
}

test("no robot prefix on outgoing messages", async () => {
  const { messenger, sent, styles } = fake();
  await createOutbound(messenger).reply("hello **world**");
  assert.equal(sent[0]!.message.text, "hello world");
  assert.deepEqual(styles(0), ["6:5:BOLD"]); // offsets start at 0 now, no prefix shift
});

test("echo guard: our own reply is recognised even before the send returns", async () => {
  const { messenger } = fake();
  let out!: ReturnType<typeof createOutbound>;
  // the echo "arrives" while the send is still in flight
  messenger.send = async (_target, m: OutgoingMessage) => {
    assert.equal(out.isOwnEcho({ text: m.text, timestamp: 999 }), true, "echo must be recognised by text, timestamp unknown yet");
    return 1234;
  };
  out = createOutbound(messenger);
  await out.reply("some answer");
});

test("echo guard: plain and styled sends are both registered, a user's own text is not", async () => {
  const { messenger } = fake();
  const out = createOutbound(messenger);
  await out.replyPlain("Approve?\n📅 Create calendar event");
  await out.reply("**Focus** today");
  assert.equal(out.isOwnEcho({ text: "Approve?\n📅 Create calendar event", timestamp: 1 }), true);
  assert.equal(out.isOwnEcho({ text: "Focus today", timestamp: 2 }), true);
  assert.equal(out.isOwnEcho({ text: "what's on my calendar?", timestamp: 3 }), false);
});

test("echo guard: known timestamps are recognised even when the text differs", async () => {
  const { messenger } = fake();
  const out = createOutbound(messenger);
  await out.reply("x"); // timestamp 1001
  assert.equal(out.isOwnEcho({ text: "different text", timestamp: 1001 }), true);
  assert.equal(out.isOwnEcho({ text: "different text", timestamp: 1002 }), false);
});

test("a message to another conversation is not echo-registered and goes to that target", async () => {
  const { messenger, sent } = fake();
  const out = createOutbound(messenger);
  await out.reply("to the group", { target: "grp" });
  assert.equal(sent[0]!.target, "grp");
  assert.equal(out.isOwnEcho({ text: "to the group", timestamp: sent[0]!.timestamp }), false);
});

test("a voice message and a picture go out as attachments of their kind, a picture with its caption", async () => {
  const { messenger, sent } = fake();
  const out = createOutbound(messenger);
  await out.sendVoice("/tmp/v.m4a", "hello", "grp");
  await out.sendPicture("/tmp/p.png", "a **drawing**");
  assert.deepEqual(sent[0]!.message, { text: "", attachments: [{ file: "/tmp/v.m4a", kind: "voice" }] });
  assert.equal(sent[0]!.target, "grp");
  assert.equal(sent[1]!.message.text, "a drawing");
  assert.deepEqual(sent[1]!.message.attachments, [{ file: "/tmp/p.png", kind: "picture" }]);
  assert.deepEqual(sent[1]!.message.styles, [{ start: 2, length: 7, style: "BOLD" }]);
});

test("a messenger without quotes never gets one", async () => {
  const q = { text: "earlier", author: "+1", timestamp: 7 };
  const without = fake({ quotes: false });
  await createOutbound(without.messenger).reply("answer", { quote: q });
  await createOutbound(without.messenger).sendPicture("/tmp/p.png", "", { quote: q });
  assert.deepEqual(without.sent.map((s) => s.message.quote), [undefined, undefined]);
  const withQuotes = fake();
  await createOutbound(withQuotes.messenger).reply("answer", { quote: q });
  assert.deepEqual(withQuotes.sent[0]!.message.quote, q);
});

test("a messenger with a size limit gets the text in parts that fit, the quote on the first only, each part remembered as our echo", async () => {
  const { messenger, sent } = fake({ maxMessageBytes: 60 });
  const out = createOutbound(messenger);
  const q = { text: "earlier", author: "+1", timestamp: 7 };
  const text = "First paragraph is here.\n\nSecond paragraph is a bit longer than the first one.\n\nThird.";
  await out.reply(text, { quote: q });
  assert.ok(sent.length >= 2);
  for (const s of sent) assert.ok(Buffer.byteLength(s.message.text) <= 60, s.message.text);
  assert.deepEqual(sent.map((s) => s.message.quote), [q, ...sent.slice(1).map(() => undefined)]);
  const words = (t: string) => t.split(/\s+/).filter(Boolean).join(" ");
  assert.equal(words(sent.map((s) => s.message.text).join(" ")), words(text)); // nothing lost
  for (const s of sent) assert.equal(out.isOwnEcho({ text: s.message.text, timestamp: 1 }), true);
});

test("fitParts: cuts at breaks, never inside a character, and styles follow their text", () => {
  assert.deepEqual(fitParts({ text: "short", styles: [] }, 60), [{ text: "short", styles: [] }]);
  assert.deepEqual(fitParts({ text: "short", styles: [] }, undefined), [{ text: "short", styles: [] }]);
  const emoji = "😀".repeat(5); // 4 bytes each
  assert.deepEqual(fitParts({ text: emoji, styles: [] }, 9).map((p) => p.text), ["😀😀", "😀😀", "😀"]);
  const parts = fitParts({ text: "aaaa **bbbb** cccc dddd", styles: [] }, 10);
  assert.ok(parts.every((p) => Buffer.byteLength(p.text) <= 10));
  const styled = fitParts({ text: "one two three four", styles: [{ start: 8, length: 5, style: "BOLD" }] }, 10);
  assert.deepEqual(styled.map((p) => p.text), ["one two", "three four"]);
  assert.deepEqual(styled.map((p) => p.styles), [[], [{ start: 0, length: 5, style: "BOLD" }]]);
});
