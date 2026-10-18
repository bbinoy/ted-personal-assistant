import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SignalClient } from "../src/client.ts";
import { attachmentPath } from "../src/envelope.ts";
import { FakeSignalDaemon, FakeRpcError, type FakeRequest } from "../src/testing.ts";

type Req = FakeRequest;
const RpcError = FakeRpcError;

const ME = "+10000000000";
const PEER = { number: "+10000000001", aci: "11111111-2222-3333-4444-555555555555" };
const wrap = (envelope: object) => ({ jsonrpc: "2.0", method: "receive", params: { envelope } });
const until = async (f: () => boolean) => {
  for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(f(), "timed out waiting");
};

// Closed after every test, so a failing assertion cannot leave a server running and hang the runner.
const open: { close: () => Promise<void> }[] = [];
afterEach(async () => void (await Promise.all(open.splice(0).map((d) => d.close()))));

async function connected(peer?: typeof PEER, answer?: (r: Req) => unknown) {
  const d = await FakeSignalDaemon.start(answer ?? ((r) => (r.method === "send" ? { timestamp: 1234 } : {})));
  const c = new SignalClient({ host: "127.0.0.1", port: d.port, account: ME, peer });
  await c.connect();
  await until(() => d.connections > 0); // the server sees the connection a moment after the client does
  open.push(d);
  return { d, c, done: () => d.close() };
}

test("client: framing handles several lines in one chunk and one line split over chunks", async () => {
  const { d, c, done } = await connected();
  const got: string[] = [];
  c.onMessage((m) => got.push(m.text));
  const env = (t: string) => JSON.stringify(wrap({ sourceNumber: ME, syncMessage: { sentMessage: { destinationNumber: ME, message: t, timestamp: 1 } } }));
  d.raw(env("one") + "\n" + env("two") + "\n");
  const third = env("three") + "\n";
  d.raw(third.slice(0, 20));
  await new Promise((r) => setTimeout(r, 20));
  d.raw(third.slice(20));
  await until(() => got.length === 3);
  assert.deepEqual(got, ["one", "two", "three"]);
  await done();
});

test("client: a document attachment arrives as a file with its id and name; only the plain id is joined to the folder", async () => {
  const { d, c, done } = await connected(PEER);
  const got: { text: string; file?: { id: string; size: number; name?: string } }[] = [];
  c.onMessage((m) => got.push({ text: m.text, file: m.file }));
  d.push({ sourceNumber: PEER.number, dataMessage: { timestamp: 5, message: "the contract", attachments: [{ contentType: "application/pdf", id: "doc-1.pdf", size: 1234, filename: "contract.pdf" }] } });
  d.push({ sourceNumber: PEER.number, dataMessage: { timestamp: 6, message: "sneaky", attachments: [{ contentType: "application/pdf", id: "../../secret", size: 10 }] } });
  await until(() => got.length === 2);
  assert.deepEqual(got[0], { text: "the contract", file: { id: "doc-1.pdf", size: 1234, name: "contract.pdf" } });
  assert.deepEqual(got[1], { text: "sneaky", file: undefined });
  assert.equal(attachmentPath(got[0]!.file!, "/data/att"), "/data/att/doc-1.pdf");
  await done();
});

test("client: an unparseable line is skipped and later lines still work", async () => {
  const { d, c, done } = await connected();
  const got: string[] = [];
  c.onMessage((m) => got.push(m.text));
  d.raw("{not json\n");
  d.push({ sourceNumber: ME, syncMessage: { sentMessage: { destinationNumber: ME, message: "ok", timestamp: 2 } } });
  await until(() => got.length === 1);
  await done();
});

test("client: responses are matched to requests by id, even out of order", async () => {
  const held: Req[] = [];
  const { d, c, done } = await connected(undefined, (r) => (held.push(r), undefined));
  const a = c.send("a");
  const b = c.send("b");
  await until(() => held.length === 2);
  d.reply(held[1]!.id, { timestamp: 22 });
  d.reply(held[0]!.id, { timestamp: 11 });
  assert.deepEqual(await Promise.all([a, b]), [11, 22]);
  await done();
});

test("client: an rpc error rejects that request with signal-cli's message", async () => {
  const { c, done } = await connected(undefined, () => new RpcError("Invalid number"));
  await assert.rejects(c.send("x"), /Invalid number/);
  await done();
});

test("client: send in Note to Self mode", async () => {
  const { d, c, done } = await connected();
  assert.equal(await c.send("hi"), 1234);
  assert.deepEqual(d.requests[0]!.params, { noteToSelf: true, message: "hi" });
  await done();
});

test("client: send in peer mode, with style, quote and attachments", async () => {
  const { d, c, done } = await connected(PEER);
  await c.send("hi", { style: ["0:2:BOLD"], quote: { text: "earlier", author: PEER.number, timestamp: 99 }, attachments: ["/tmp/a.m4a"] });
  assert.deepEqual(d.requests[0]!.params, {
    recipient: [PEER.number],
    message: "hi",
    attachments: ["/tmp/a.m4a"],
    textStyle: ["0:2:BOLD"],
    quoteTimestamp: 99,
    quoteAuthor: PEER.number,
    quoteMessage: "earlier",
  });
  await done();
});

test("client: a voice message is marked as a voice note, a picture is not", async () => {
  const { d, c, done } = await connected(PEER);
  await c.send("", { attachments: ["/tmp/voice.m4a"], voiceNote: true });
  await c.send("", { attachments: ["/tmp/a.png"] });
  assert.deepEqual(d.requests[0]!.params, { recipient: [PEER.number], attachments: ["/tmp/voice.m4a"], voiceNote: true });
  assert.deepEqual(d.requests[1]!.params, { recipient: [PEER.number], attachments: ["/tmp/a.png"] });
  await done();
});

test("client: send to a group, attachment only", async () => {
  const { d, c, done } = await connected(PEER);
  await c.send("", { groupId: "grp==", attachments: ["/tmp/a.png"] });
  assert.deepEqual(d.requests[0]!.params, { groupId: "grp==", attachments: ["/tmp/a.png"] });
  await done();
});

test("client: react sends the target and is remembered as our own", async () => {
  const { d, c, done } = await connected(PEER);
  await c.react("👍", { author: PEER.number, timestamp: 5 });
  assert.deepEqual(d.requests[0]!.params, { recipient: [PEER.number], emoji: "👍", targetAuthor: PEER.number, targetTimestamp: 5 });
  assert.equal(c.isOwnReaction({ emoji: "👍", targetTimestamp: 5 }), true);
  assert.equal(c.isOwnReaction({ emoji: "👎", targetTimestamp: 5 }), false);
  await c.react("🔥", { author: PEER.number, timestamp: 6 }, "grp==");
  assert.equal(d.requests[1]!.params.groupId, "grp==");
  assert.equal(d.requests[1]!.params.recipient, undefined);
  await done();
});

test("client: a failed reaction is swallowed (best effort)", async () => {
  const { c, done } = await connected(PEER, () => new RpcError("nope"));
  await c.react("👍", { author: PEER.number, timestamp: 5 });
  await done();
});

test("client: typing and read receipts do nothing in Note to Self mode", async () => {
  const { d, c, done } = await connected();
  await c.typing();
  await c.markRead(1);
  assert.equal(d.requests.length, 0);
  await done();
});

test("client: typing in peer mode, direct and in a group", async () => {
  const { d, c, done } = await connected(PEER);
  await c.typing();
  await c.typing(true, "grp==");
  assert.deepEqual(d.requests[0]!.params, { recipient: [PEER.number] });
  assert.deepEqual(d.requests[1]!.params, { groupId: "grp==", stop: true });
  await done();
});

test("client: groups() maps members and drops groups we left", async () => {
  const { c, done } = await connected(PEER, () => [
    { id: "g1", name: "Team", members: [{ number: "+10000000002", uuid: "u2" }, "+10000000003", { uuid: "u4" }] },
    { id: "g2", name: "Old", isMember: false, members: [] },
  ]);
  assert.deepEqual(await c.groups(), [
    { id: "g1", name: "Team", members: [{ number: "+10000000002", uuid: "u2" }, { number: "+10000000003", uuid: "+10000000003" }, { number: undefined, uuid: "u4" }] },
  ]);
  await done();
});

test("client: an incoming reaction reaches the reaction handler", async () => {
  const { d, c, done } = await connected(PEER);
  const got: string[] = [];
  c.onReaction((r) => got.push(r.emoji));
  d.push({ sourceNumber: PEER.number, dataMessage: { timestamp: 7, reaction: { emoji: "👍", targetSentTimestamp: 5, targetAuthorNumber: ME } } });
  await until(() => got.length === 1);
  await done();
});

// signal-cli's sendReceipt takes ONE recipient string (unlike send/sendTyping/sendReaction, which take a list); a list
// made it fail with "Invalid phone number '[<uuid>]'" for peers known only by account id.
test("client: a read receipt names a single recipient string (peer, peer by account id, group author)", async () => {
  const { d, c, done } = await connected(PEER);
  await c.markRead(10);
  await c.markRead(11, PEER.aci);
  await c.markRead(12, "+10000000002");
  assert.deepEqual(d.requests.map((r) => r.method), ["sendReceipt", "sendReceipt", "sendReceipt"]);
  assert.deepEqual(d.requests.map((r) => r.params.recipient), [PEER.number, PEER.aci, "+10000000002"]);
  assert.deepEqual(d.requests.map((r) => r.params.targetTimestamp), [[10], [11], [12]]);
  assert.equal(d.requests[0]!.params.type, "read");
  await done();
});

test("client: warnings go to the injected logger (and nowhere by default)", async () => {
  const d = await FakeSignalDaemon.start(() => new RpcError("nope"));
  open.push(d);
  const lines: string[] = [];
  const c = new SignalClient({ host: "127.0.0.1", port: d.port, account: ME, peer: PEER, logger: { info: () => {}, error: () => {}, warn: (...a) => void lines.push(a.join(" ")) } });
  await c.connect();
  await until(() => d.connections > 0);
  await c.markRead(1);
  d.raw("garbage\n");
  await c.react("x", { author: PEER.number, timestamp: 1 });
  await until(() => lines.length === 3);
  assert.match(lines.join("|"), /read receipt failed: nope/);
  assert.match(lines.join("|"), /unparseable line/);
  assert.match(lines.join("|"), /reaction x failed: nope/);
});

test("client: when signal-cli goes away onClose fires once and pending requests are rejected", async () => {
  const held: Req[] = [];
  const { d, c } = await connected(undefined, (r) => (held.push(r), undefined));
  const closes: { requested: boolean }[] = [];
  c.onClose((info) => closes.push(info));
  const p = c.send("x");
  await until(() => held.length === 1);
  d.dropConnections();
  await assert.rejects(p, /socket closed/);
  await until(() => closes.length === 1);
  assert.equal(closes[0]!.requested, false);
  await assert.rejects(c.send("y"), /closed/);
});

test("client: close() ends the connection on purpose", async () => {
  const { d, c } = await connected();
  const closes: { requested: boolean }[] = [];
  c.onClose((info) => closes.push(info));
  c.close();
  c.close();
  await until(() => closes.length === 1);
  assert.equal(closes[0]!.requested, true);
  await until(() => d.connections === 0);
});

test("client: a socket error after connecting is reported, not thrown", async () => {
  const { d, c } = await connected();
  const closes: { error?: Error }[] = [];
  c.onClose((info) => closes.push(info));
  d.resetConnections();
  await until(() => closes.length === 1);
  assert.ok(closes[0]!.error, "the reset is passed on");
});

test("client: sending before connect() says so", async () => {
  const c = new SignalClient({ host: "127.0.0.1", port: 1, account: ME });
  await assert.rejects(c.send("x"), /not connected/);
});

test("client: a request that gets no answer times out after rpcTimeoutMs", async () => {
  const d = await FakeSignalDaemon.start(() => undefined);
  open.push(d);
  const c = new SignalClient({ host: d.host, port: d.port, account: ME, rpcTimeoutMs: 50 });
  await c.connect();
  await assert.rejects(c.send("x"), /timed out after 0.05s/);
  c.close();
});

test("client: a line that never ends is not buffered without limit; the connection is closed instead", async () => {
  const d = await FakeSignalDaemon.start();
  open.push(d);
  const errors: string[] = [];
  const c = new SignalClient({ host: d.host, port: d.port, account: ME, maxLineChars: 500, logger: { ...console, error: (...a: unknown[]) => void errors.push(a.join(" ")) } });
  await c.connect();
  await until(() => d.connections > 0);
  const closes: { requested: boolean; error?: Error }[] = [];
  c.onClose((info) => closes.push(info));
  const got: string[] = [];
  c.onMessage((m) => got.push(m.text));
  // lines shorter than the limit are fine, however many arrive
  d.push({ sourceNumber: ME, syncMessage: { sentMessage: { destinationNumber: ME, message: "fine", timestamp: 1 } } });
  await until(() => got.length === 1);
  d.raw("x".repeat(400));
  d.raw("y".repeat(400)); // 800 characters and still no line break
  await until(() => closes.length === 1);
  assert.equal(closes[0]!.requested, false);
  assert.match(String(closes[0]!.error?.message), /line too long/);
  assert.match(errors[0] ?? "", /more than 500 characters/);
});

test("client: attachmentPath joins a plain id to the folder and refuses anything else", () => {
  assert.equal(attachmentPath({ id: "abc-DEF_1.m4a" }, "/data/att"), "/data/att/abc-DEF_1.m4a");
  for (const id of ["../x", "a/b", ".hidden", "", "x".repeat(101)]) assert.throws(() => attachmentPath({ id }, "/data/att"), /plain attachment id/);
  assert.match(attachmentPath({ id: "x" }), /signal-cli\/attachments\/x$/);
});

test("client: an edit arrives as a message with `edited`, a remote delete goes to onDelete only", async () => {
  const { d, c, done } = await connected(PEER);
  const got: { text: string; edited?: unknown }[] = [];
  const deleted: number[] = [];
  c.onMessage((m) => got.push({ text: m.text, edited: m.edited }));
  c.onDelete((x) => deleted.push(x.targetTimestamp));
  d.push({ sourceNumber: PEER.number, editMessage: { targetSentTimestamp: 4, dataMessage: { timestamp: 9, message: "fixed" } } });
  d.push({ sourceNumber: PEER.number, dataMessage: { timestamp: 10, remoteDelete: { targetTimestamp: 9 } } });
  await until(() => got.length === 1 && deleted.length === 1);
  assert.deepEqual(got, [{ text: "fixed", edited: { targetTimestamp: 4 } }]);
  assert.deepEqual(deleted, [9]);
  await done();
});
