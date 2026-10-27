import { test } from "node:test";
import assert from "node:assert/strict";
import { createPipeline, owner } from "../src/conversation/conversation.ts";
import { createOutbound } from "../src/conversation/outbound.ts";
import { sendNow } from "../src/modules/send/send.ts";
import { OWNER_KEY } from "../src/core/ownerkey.ts";
import { FakeMessenger } from "@ted-assistant/messenger/testing";

// The app against the Messenger interface alone: what it does with a platform that has everything, and how it degrades quietly when a
// capability is missing. No Signal anywhere.

const OWNER = "+10000000000";

function rig(caps: ConstructorParameters<typeof FakeMessenger>[0], run: () => Promise<string> = async () => "ok") {
  const messenger = new FakeMessenger(caps);
  const pipeline = createPipeline({
    messenger,
    out: createOutbound(messenger),
    record: () => {},
    run: async () => ({ text: await run() }),
    picture: async () => assert.fail("no picture"),
    document: async () => assert.fail("no document"),
    transcript: async () => assert.fail("no voice"),
    speech: { ready: () => false, synth: async () => "", foreign: async () => undefined },
    approvals: { answer: async () => ({ outcome: "none" as const }), answerReaction: () => "ignored" },
    vouch: async () => true,
    isOwner: () => true,
    wait: async () => {},
  });
  const say = (timestamp = 7) => pipeline.handleIncoming(owner(), { type: "message", m: { from: OWNER, text: "hello", timestamp, direct: true } });
  return { messenger, pipeline, say };
}

test("a platform with everything: typing is shown and cleared, the sender gets a read receipt, no status icons, the answer goes to the owner's chat", async () => {
  const { messenger, say } = rig({});
  await say();
  assert.deepEqual(messenger.typings.map((t) => [t.target, t.on]), [[undefined, true], [undefined, false]]);
  assert.deepEqual(messenger.reads, [{ target: undefined, timestamp: 7, author: undefined }]);
  assert.deepEqual(messenger.reactions, []);
  assert.deepEqual(messenger.sent.map((s) => [s.target, s.message.text]), [[undefined, "ok"]]);
});

test("a platform without typing shows working and done as reactions on the message instead", async () => {
  const { messenger, say } = rig({ typing: false });
  await say();
  assert.deepEqual(messenger.reactions.map((r) => [r.emoji, r.message]), [["👀", { author: OWNER, timestamp: 7 }], ["✅", { author: OWNER, timestamp: 7 }]]);
});

test("a platform without reactions, receipts and typing gets none of them, and the answer still arrives", async () => {
  const { messenger, say } = rig({ reactions: false, typing: false, readReceipts: false });
  await say();
  assert.deepEqual(messenger.reactions, []);
  assert.deepEqual(messenger.reads, []);
  assert.deepEqual(messenger.sent.map((s) => s.message.text), ["ok"]);
});

test("the send tool's reaction: done where reactions exist, a plain sentence to the model where they do not", async () => {
  let told = "";
  const yes = rig({ typing: true }, async () => ((told = await sendNow(OWNER_KEY, { react: "👍" })), "ok"));
  await yes.say();
  assert.match(told, /^Reacted\./);
  assert.deepEqual(yes.messenger.reactions.map((r) => r.emoji), ["👍"]);

  const no = rig({ reactions: false }, async () => ((told = await sendNow(OWNER_KEY, { react: "👍" })), "ok"));
  await no.say();
  assert.match(told, /^Reactions are not available here\./);
  assert.deepEqual(no.messenger.reactions, []);
});

test("MESSENGER=signal (the default) is found by name, and the doctor reports the messenger first", async () => {
  const { settings } = await import("../src/core/settings.ts");
  assert.equal(settings.messenger, "signal");
  const { loadMessengerModule } = await import("@ted-assistant/messenger");
  const mod = await loadMessengerModule("signal");
  const m = await mod.createMessenger({ owner: { address: OWNER }, account: OWNER, options: { host: "127.0.0.1", port: 7583, attachmentsDir: "/x" }, logger: console });
  assert.equal(m.name, "signal");
  const { messengerDoctor } = await import("../src/conversation/messenger.ts");
  const lines = await messengerDoctor(undefined);
  assert.deepEqual([lines[0]!.what, lines[0]!.detail, lines[1]!.what], ["messenger", "signal", "Signal channel"]);
});

test("a platform that is not installed is named in the error", async () => {
  const { loadMessenger } = await import("@ted-assistant/messenger");
  await assert.rejects(loadMessenger("nonesuch", { owner: { address: OWNER }, account: OWNER, options: {}, logger: console }), /MESSENGER=nonesuch: the package is not installed/);
});
