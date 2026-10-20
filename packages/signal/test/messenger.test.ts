import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directTarget, type Messenger } from "@ted-personal-assistant/messenger";
import { createMessenger, doctor, toSignalStyles } from "../src/messenger.ts";
import { FakeSignalDaemon } from "../src/testing.ts";

// The Signal adapter as the Messenger interface describes it, against a fake signal-cli daemon.

const OWNER = "+10000000000";
const BOT = "+10000000001";
const OWNER_ACI = "11111111-2222-4333-8444-555555555555";
const FRIEND_ACI = "66666666-7777-4888-8999-aaaaaaaaaaaa";

const open: { close: () => Promise<void> }[] = [];
const stoppers: Messenger[] = [];
afterEach(async () => {
  stoppers.splice(0).forEach((m) => m.stop());
  await Promise.all(open.splice(0).map((d) => d.close()));
});
const until = async (f: () => boolean) => {
  for (let i = 0; i < 2000 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(f(), "timed out waiting");
};

async function started(account: string, attachmentsDir = "/nonexistent") {
  const d = await FakeSignalDaemon.start((r) => (r.method === "send" ? { timestamp: 4242 } : r.method === "listGroups" ? [{ id: "g1", name: "Family", members: [{ number: OWNER, uuid: OWNER_ACI }] }] : {}));
  open.push(d);
  const m = await createMessenger({ owner: { address: OWNER, id: OWNER_ACI }, account, options: { host: d.host, port: d.port, attachmentsDir }, logger: console });
  stoppers.push(m);
  await m.start(); // the fake listens already, so the daemon is reused
  await d.whenConnections((n) => n > 0);
  return { d, m };
}

test("capabilities: an own account can do everything, Note to Self cannot show typing, take receipts, groups, friends or voice", async () => {
  const own = await createMessenger({ owner: { address: OWNER }, account: BOT, options: { host: "127.0.0.1", port: 7583, attachmentsDir: "/x" }, logger: console });
  assert.deepEqual(own.capabilities, { reactions: true, typing: true, readReceipts: true, groups: true, people: true, voice: true, quotes: true, voiceFormat: "m4a" });
  assert.equal(own.summary, "own account");
  assert.equal(own.self, BOT);
  const self = await createMessenger({ owner: { address: OWNER }, account: OWNER, options: { host: "127.0.0.1", port: 7583, attachmentsDir: "/x" }, logger: console });
  assert.deepEqual(self.capabilities, { reactions: true, typing: false, readReceipts: false, groups: false, people: false, voice: false, quotes: true, voiceFormat: "m4a" });
  assert.equal(self.summary, "Note to Self");
  assert.equal(self.name, "signal");
});

test("options are checked when the messenger is made", async () => {
  await assert.rejects(() => createMessenger({ owner: { address: OWNER }, account: BOT, options: { host: "127.0.0.1", port: 70000, attachmentsDir: "/x" }, logger: console }), /port/);
  await assert.rejects(() => createMessenger({ owner: { address: OWNER }, account: BOT, options: { port: 7583, attachmentsDir: "/x" }, logger: console }), /option host/);
});

test("send: text, styles and quote, to the owner's chat, a group and one person; a voice message and a picture as attachments", async () => {
  const { d, m } = await started(BOT);
  const quote = { text: "earlier", author: OWNER, timestamp: 99 };
  assert.equal(await m.send(undefined, { text: "hi **there**", styles: [{ start: 3, length: 5, style: "BOLD" }], quote }), 4242);
  await m.send("grp==", { text: "to the group" });
  await m.send(directTarget(FRIEND_ACI), { text: "to her" });
  await m.send(undefined, { text: "", attachments: [{ file: "/tmp/v.m4a", kind: "voice" }] });
  await m.send("grp==", { text: "look", attachments: [{ file: "/tmp/p.png", kind: "picture" }] });
  const params = d.requests.filter((r) => r.method === "send").map((r) => r.params);
  assert.deepEqual(params[0], { recipient: [OWNER], message: "hi **there**", textStyle: ["3:5:BOLD"], quoteTimestamp: 99, quoteAuthor: OWNER, quoteMessage: "earlier" });
  assert.deepEqual(params[1], { groupId: "grp==", message: "to the group" });
  assert.deepEqual(params[2], { recipient: [FRIEND_ACI], message: "to her" });
  assert.deepEqual(params[3], { recipient: [OWNER], attachments: ["/tmp/v.m4a"], voiceNote: true });
  assert.deepEqual(params[4], { groupId: "grp==", message: "look", attachments: ["/tmp/p.png"] });
});

test("react, typing and read receipts address the right conversation; in Note to Self typing and receipts do nothing", async () => {
  const { d, m } = await started(BOT);
  await m.react(undefined, { author: OWNER, timestamp: 5 }, "👍");
  await m.react("grp==", { author: OWNER, timestamp: 6 }, "✅");
  await m.react(directTarget(FRIEND_ACI), { author: FRIEND_ACI, timestamp: 7 }, "👀");
  await m.typing("grp==", true);
  await m.typing(undefined, false);
  await m.markRead(directTarget(FRIEND_ACI), { timestamp: 7, author: FRIEND_ACI });
  await m.markRead(undefined, { timestamp: 5 });
  const by = (method: string) => d.requests.filter((r) => r.method === method).map((r) => r.params);
  assert.deepEqual(by("sendReaction"), [
    { recipient: [OWNER], emoji: "👍", targetAuthor: OWNER, targetTimestamp: 5 },
    { groupId: "grp==", emoji: "✅", targetAuthor: OWNER, targetTimestamp: 6 },
    { recipient: [FRIEND_ACI], emoji: "👀", targetAuthor: FRIEND_ACI, targetTimestamp: 7 },
  ]);
  assert.deepEqual(by("sendTyping"), [{ groupId: "grp==" }, { recipient: [OWNER], stop: true }]);
  assert.deepEqual(by("sendReceipt"), [
    { recipient: FRIEND_ACI, targetTimestamp: [7], type: "read" },
    { recipient: OWNER, targetTimestamp: [5], type: "read" },
  ]);

  const note = await started(OWNER);
  await note.m.typing(undefined, true);
  await note.m.markRead(undefined, { timestamp: 1 });
  assert.equal(note.d.requests.filter((r) => r.method === "sendTyping" || r.method === "sendReceipt").length, 0);
});

test("receiving: messages, deletions and the owner's reactions arrive neutral; reactions we sent ourselves do not", async () => {
  const { d, m } = await started(BOT);
  const got: string[] = [];
  m.onMessage((x) => got.push(`message ${x.text} direct=${x.direct} from=${x.from} id=${x.fromUuid}`));
  m.onReaction((x) => got.push(`reaction ${x.emoji} on ${x.targetTimestamp}`));
  m.onDeletion((x) => got.push(`deletion ${x.targetTimestamp}`));
  await m.react(undefined, { author: OWNER, timestamp: 5 }, "✅"); // our own icon...
  d.push({ sourceNumber: OWNER, sourceUuid: OWNER_ACI, dataMessage: { timestamp: 8, reaction: { emoji: "✅", targetSentTimestamp: 5, targetAuthorNumber: OWNER } } }); // ...comes back
  d.push({ sourceNumber: OWNER, sourceUuid: OWNER_ACI, dataMessage: { timestamp: 9, reaction: { emoji: "👍", targetSentTimestamp: 5, targetAuthorNumber: BOT } } });
  d.push({ sourceNumber: OWNER, sourceUuid: OWNER_ACI, dataMessage: { timestamp: 10, message: "hello" } });
  d.push({ sourceNumber: OWNER, sourceUuid: OWNER_ACI, dataMessage: { timestamp: 11, remoteDelete: { targetTimestamp: 10 } } });
  await until(() => got.length >= 3);
  assert.deepEqual(got, [`reaction 👍 on 5`, `message hello direct=true from=${OWNER} id=${OWNER_ACI}`, "deletion 10"]);
});

test("groups, attachments and long text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "att-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "long1"), "the whole long text");
  const { m } = await started(BOT, dir);
  assert.deepEqual(await m.groups(), [{ id: "g1", name: "Family", members: [{ number: OWNER, uuid: OWNER_ACI }] }]);
  assert.equal(await m.attachmentFile({ id: "abc.m4a" }), join(dir, "abc.m4a"));
  await assert.rejects(() => m.attachmentFile({ id: "../secret" }), /not a plain attachment id/);
  assert.deepEqual(await m.readLongText({ id: "long1" }), { text: "the whole long text", cut: false });
  assert.equal(await m.readLongText({ id: "missing" }), undefined);
});

test("onClose: a lost connection is reported once; stopping on purpose is not a loss", async () => {
  // (also in the contract every messenger passes, contract.test.ts; kept here for the Signal-specific reason text)
  const lost = await started(BOT);
  const reasons: string[] = [];
  const reported = new Promise<void>((resolve) => lost.m.onClose((i) => (reasons.push(i.reason), resolve())));
  lost.d.dropConnections();
  await reported; // the event itself, however long the machine takes
  await lost.d.whenConnections((n) => n === 0);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /^signal socket closed/);

  const quiet = await started(BOT);
  const none: string[] = [];
  quiet.m.onClose((i) => none.push(i.reason));
  quiet.m.stop();
  quiet.m.stop(); // safe twice
  await quiet.d.whenConnections((n) => n === 0); // the daemon saw the client go; had a loss been reported it would have been by now
  assert.deepEqual(none, []);
});

test("styles are signal-cli's start:length:STYLE strings", () => {
  assert.deepEqual(toSignalStyles([{ start: 0, length: 3, style: "BOLD" }, { start: 4, length: 2, style: "MONOSPACE" }]), ["0:3:BOLD", "4:2:MONOSPACE"]);
});

test("doctor: the mode, signal-cli, the account link and whether the daemon is reachable", async () => {
  const d = await FakeSignalDaemon.start();
  open.push(d);
  const up = await doctor({ account: BOT, options: { host: d.host, port: d.port } });
  assert.deepEqual(up.map((l) => l.what), ["Signal channel", "signal-cli installed", "a Signal account is linked to signal-cli", `Signal daemon reachable on ${d.host}:${d.port}`]);
  assert.equal(up[0]!.detail, "the assistant's own account (its own chat)");
  assert.equal(up[3]!.ok, true);
  await d.close();
  open.pop();
  const down = await doctor({ options: { host: d.host, port: d.port } });
  assert.match(down[0]!.detail!, /^Note to Self/);
  assert.deepEqual([down[3]!.ok, down[3]!.detail], ["warn", "only running while the agent is"]);
});
