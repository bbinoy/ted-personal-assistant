import { test } from "node:test";
import assert from "node:assert/strict";
import { directOf, directTarget, loadMessenger, loadMessengerModule } from "@ted-personal-assistant/messenger";
import { FakeMessenger, FULL_CAPABILITIES } from "@ted-personal-assistant/messenger/testing";

test("targets: a person's private chat round-trips, the owner's chat and a group are not people", () => {
  assert.equal(directOf(directTarget("11111111-2222-4333-8444-555555555555")), "11111111-2222-4333-8444-555555555555");
  assert.equal(directOf(undefined), undefined);
  assert.equal(directOf("c29tZSBncm91cCBpZA=="), undefined);
});

test("loadMessenger: only a plain platform name is imported, and a missing package says how to install it", async () => {
  for (const bad of ["", "../x", "Signal", "a b", "signal/../../x", "x".repeat(40)]) await assert.rejects(() => loadMessengerModule(bad), /MESSENGER must be a platform name/);
  await assert.rejects(() => loadMessenger("nonesuch", { owner: { address: "x" }, account: "x", options: {}, logger: console }), /MESSENGER=nonesuch: the package is not installed \(npm install -w packages\/nonesuch\)/);
});

test("the fake messenger records what the app does and delivers what a test pushes", async () => {
  const m = new FakeMessenger();
  const seen: string[] = [];
  m.onMessage((x) => seen.push(`message ${x.text}`));
  m.onReaction((x) => seen.push(`reaction ${x.emoji}`));
  m.onDeletion((x) => seen.push(`deletion ${x.targetTimestamp}`));
  m.onClose((x) => seen.push(`close ${x.reason}`));
  await m.start();
  m.pushMessage({ from: "+1", text: "hi", timestamp: 1, direct: true });
  m.pushReaction({ from: "+1", emoji: "👍", targetTimestamp: 1, isRemove: false, direct: true });
  m.pushDeletion({ from: "+1", targetTimestamp: 1, direct: true });
  m.pushClose("gone");
  assert.deepEqual(seen, ["message hi", "reaction 👍", "deletion 1", "close gone"]);

  const ts = await m.send("g1", { text: "hello", attachments: [{ file: "/tmp/a.m4a", kind: "voice" }] });
  assert.equal(m.sent[0]!.timestamp, ts);
  await m.react("g1", { author: "+1", timestamp: 1 }, "👍");
  await m.typing(undefined, true);
  await m.markRead(undefined, { timestamp: 1 });
  assert.deepEqual([m.sent.length, m.reactions.length, m.typings.length, m.reads.length], [1, 1, 1, 1]);
  assert.throws(() => new FakeMessenger().pushMessage({ from: "", text: "", timestamp: 1, direct: true }), /no onMessage handler/);
});

test("the fake declares full capabilities unless told otherwise, and resolves only attachments it was given", async () => {
  assert.deepEqual(new FakeMessenger().capabilities, FULL_CAPABILITIES);
  const m = new FakeMessenger({ reactions: false, voiceFormat: "ogg-opus" });
  assert.equal(m.capabilities.reactions, false);
  assert.equal(m.capabilities.voiceFormat, "ogg-opus");
  m.files.set("a", "/tmp/a");
  assert.equal(await m.attachmentFile({ id: "a" }), "/tmp/a");
  await assert.rejects(() => m.attachmentFile({ id: "../b" }), /not a plain attachment id/);
  assert.equal(await m.readLongText({ id: "a" }), undefined);
});
