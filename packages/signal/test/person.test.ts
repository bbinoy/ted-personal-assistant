import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { personOf, SignalClient, toPerson } from "../src/client.ts";
import { interpretEnvelope } from "../src/envelope.ts";
import { FakeSignalDaemon } from "../src/testing.ts";

// Own-account mode with more than one person: who wrote privately (someone other than the peer), and sending to one of them.

const ME = "+10000000000";
const BOT = "+10000000001";
const FRIEND_ACI = "22222222-2222-4222-8222-222222222222";
const peerCh = { account: BOT, peer: ME };

test("a private message from someone other than the peer is flagged `other`, with her account id and name", () => {
  const env = { sourceNumber: "+15555550105", sourceUuid: FRIEND_ACI, sourceName: "Mara", timestamp: 3, dataMessage: { message: "hi", timestamp: 3 } };
  const m = interpretEnvelope(env, peerCh).message!;
  assert.deepEqual([m.direct, m.other, m.fromUuid, m.fromName, m.from, m.group], [false, true, FRIEND_ACI, "Mara", "+15555550105", undefined]);
  // her number may be hidden: the account id is what identifies her
  assert.equal(interpretEnvelope({ ...env, sourceNumber: undefined, source: undefined }, peerCh).message?.from, "");
  const react = interpretEnvelope({ sourceNumber: "+15555550105", sourceUuid: FRIEND_ACI, dataMessage: { timestamp: 4, reaction: { emoji: "👍", targetSentTimestamp: 2 } } }, peerCh).reaction!;
  assert.deepEqual([react.other, react.fromUuid], [true, FRIEND_ACI]);
  const del = interpretEnvelope({ sourceNumber: "+15555550105", sourceUuid: FRIEND_ACI, dataMessage: { timestamp: 5, remoteDelete: { timestamp: 3 } } }, peerCh).deletion!;
  assert.deepEqual([del.other, del.fromUuid], [true, FRIEND_ACI]);
});

test("`other` is for private messages from others only: not the peer, not a group, not Note to Self", () => {
  const fromPeer = { sourceNumber: ME, sourceUuid: "1", dataMessage: { message: "x", timestamp: 1 } };
  assert.equal(interpretEnvelope(fromPeer, peerCh).message?.other, undefined);
  const inGroup = { sourceNumber: "+15555550105", sourceUuid: FRIEND_ACI, dataMessage: { message: "x", timestamp: 1, groupInfo: { groupId: "g" } } };
  assert.equal(interpretEnvelope(inGroup, peerCh).message?.other, undefined);
  const fromFriend = { sourceNumber: "+15555550105", sourceUuid: FRIEND_ACI, dataMessage: { message: "hello", timestamp: 2 } };
  assert.equal(interpretEnvelope(fromFriend, { account: ME }).message?.other, undefined, "in Note to Self mode nobody else is ever heard");
});

test("a target made by toPerson is a person, not a group", () => {
  assert.equal(toPerson("abc"), "to:abc");
  assert.equal(personOf("to:abc"), "abc");
  assert.equal(personOf("groupId=="), undefined);
  assert.equal(personOf(undefined), undefined);
});

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => void (await Promise.all(open.splice(0).map((d) => d.close()))));

test("client: sending, typing and reacting to a person by toPerson go to her, not to the peer or a group", async () => {
  const d = await FakeSignalDaemon.start((r) => (r.method === "send" ? { timestamp: 1234 } : {}));
  open.push(d);
  const c = new SignalClient({ host: "127.0.0.1", port: d.port, account: BOT, peer: { number: ME } });
  await c.connect();
  for (let i = 0; i < 400 && d.connections === 0; i++) await new Promise((r) => setTimeout(r, 5));
  await c.send("hello", { groupId: toPerson(FRIEND_ACI) });
  assert.deepEqual(d.requests[0]!.params, { recipient: [FRIEND_ACI], message: "hello" });
  await c.typing(false, toPerson(FRIEND_ACI));
  assert.deepEqual(d.requests[1]!.params, { recipient: [FRIEND_ACI] });
  await c.react("👍", { author: FRIEND_ACI, timestamp: 5 }, toPerson(FRIEND_ACI));
  assert.deepEqual(d.requests[2]!.params, { recipient: [FRIEND_ACI], emoji: "👍", targetAuthor: FRIEND_ACI, targetTimestamp: 5 });
  await c.send("to the peer");
  assert.deepEqual(d.requests[3]!.params, { recipient: [ME], message: "to the peer" });
  await c.send("to a group", { groupId: "grp==" });
  assert.deepEqual(d.requests[4]!.params, { groupId: "grp==", message: "to a group" });
});
