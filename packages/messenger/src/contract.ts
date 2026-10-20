import { test } from "node:test";
import assert from "node:assert/strict";
import { directTarget, type GroupInfo, type IncomingDeletion, type IncomingMessage, type IncomingReaction, type Messenger } from "./index.ts";

// Entry point "./contract": ONE test suite that every Messenger must pass, whatever the platform. The fake (testing.ts) runs it, and so does every platform package against its
// own fake server: a behaviour the app relies on is written down here once, and an adapter that breaks it fails the same test. A platform supplies a RIG: a started messenger plus
// the few levers the suite needs on the platform's side (deliver something, make it refuse, hang up). Nothing here knows a platform's protocol.
//
//   import { messengerContract } from "@ted-assistant/messenger/contract";
//   messengerContract("signal", async () => ({ messenger, deliverMessage, ... }));

/** The platform's side of a test: what the suite pushes into the messenger and what it breaks. */
export interface ContractRig {
  /** A started messenger. The suite never starts or stops it before the rig is returned; it may call `stop` itself. */
  messenger: Messenger;
  /** The OWNER writes in her own chat, or someone writes in a group. Delivered to the handler the suite registered. */
  deliverMessage(m: { text: string; timestamp: number; group?: string }): void | Promise<void>;
  /** The owner reacts to a message of ours / a message is deleted for everyone. */
  deliverReaction(r: { emoji: string; targetTimestamp: number }): void | Promise<void>;
  deliverDeletion(d: { targetTimestamp: number }): void | Promise<void>;
  /** From now on the platform answers a send with an error (until {@link ContractRig.accept}), and refuses every other call too when `everything`. */
  refuse(o?: { everything?: boolean }): void;
  accept(): void;
  /** The connection to the platform is lost (the platform hangs up). */
  dropConnection(): void | Promise<void>;
  /** Resolves when the platform has seen the messenger's connection go (after `stop`), so "nothing was reported" can be checked without waiting for a timer. */
  disconnected(): Promise<void>;
  /** The groups the platform reports. */
  setGroups(groups: GroupInfo[]): void;
  /** An attachment the platform saved, by id; a long message's text. */
  addAttachment(id: string, content: string): void | Promise<void>;
  addLongText(id: string, text: string): void | Promise<void>;
  /** Releases everything the rig holds (servers, folders). Called after every test. */
  close(): Promise<void>;
}

const OWNER_TARGET = undefined;
const GROUP = "Z3JvdXAtaWQ=";
const FRIEND = directTarget("66666666-7777-4888-8999-aaaaaaaaaaaa");

const next = <T>(register: (h: (x: T) => void) => void): Promise<T> => new Promise((resolve) => register(resolve));

/**
 * Registers the suite as tests named `<name> messenger: ...`. `make` builds a fresh rig for each test.
 * Each behaviour is one the app relies on (packages/messenger/src/index.ts documents it on the interface).
 */
export function messengerContract(name: string, make: () => Promise<ContractRig>): void {
  const withRig = (what: string, f: (rig: ContractRig) => Promise<void>) =>
    test(`${name} messenger: ${what}`, async () => {
      const rig = await make();
      try {
        await f(rig);
      } finally {
        rig.messenger.stop();
        await rig.close();
      }
    });

  withRig("it says what it is, and declares every capability honestly", async ({ messenger: m }) => {
    assert.ok(m.name.length > 0 && m.summary.length > 0 && m.self.length > 0);
    for (const key of ["reactions", "typing", "readReceipts", "groups", "people", "voice", "quotes"] as const) assert.equal(typeof m.capabilities[key], "boolean", key);
    assert.ok(["m4a", "ogg-opus"].includes(m.capabilities.voiceFormat));
    if (m.capabilities.maxMessageBytes !== undefined) assert.ok(m.capabilities.maxMessageBytes > 0);
  });

  withRig("send returns each message's own timestamp, to the owner's chat, a group and one person", async ({ messenger: m }) => {
    const stamps = [await m.send(OWNER_TARGET, { text: "one" }), await m.send(GROUP, { text: "two" }), await m.send(FRIEND, { text: "three" }), await m.send(OWNER_TARGET, { text: "four", styles: [{ start: 0, length: 4, style: "BOLD" }], quote: { text: "earlier", author: m.self, timestamp: 1 } })];
    for (const s of stamps) assert.ok(Number.isFinite(s) && s > 0, `a timestamp (${s})`);
    assert.equal(new Set(stamps).size, stamps.length, "distinct");
  });

  withRig("send fails when the platform refuses, and works again once it does not", async ({ messenger: m, refuse, accept }) => {
    refuse();
    await assert.rejects(() => m.send(OWNER_TARGET, { text: "no" }));
    accept();
    assert.ok((await m.send(OWNER_TARGET, { text: "yes" })) > 0);
  });

  withRig("react, typing and markRead are best effort: they resolve, even when the platform refuses everything", async ({ messenger: m, refuse }) => {
    await m.react(OWNER_TARGET, { author: m.self, timestamp: 5 }, "👍");
    await m.typing(GROUP, true);
    await m.typing(GROUP, false);
    await m.markRead(FRIEND, { timestamp: 5, author: "x" });
    refuse({ everything: true });
    await m.react(OWNER_TARGET, { author: m.self, timestamp: 5 }, "👍");
    await m.react(GROUP, { author: "x", timestamp: 6 }, "✅");
    await m.typing(OWNER_TARGET, true);
    await m.markRead(OWNER_TARGET, { timestamp: 5 });
  });

  withRig("a message in the owner's chat arrives neutral: text, timestamp, direct, no group", async (rig) => {
    const got = next<IncomingMessage>((h) => rig.messenger.onMessage(h));
    await rig.deliverMessage({ text: "hello there", timestamp: 4321 });
    const m = await got;
    assert.equal(m.text, "hello there");
    assert.equal(m.timestamp, 4321);
    assert.equal(m.direct, true);
    assert.equal(m.group, undefined);
  });

  withRig("a group message names its group and is not direct", async (rig) => {
    if (!rig.messenger.capabilities.groups) return; // a platform without groups has nothing to deliver
    const got = next<IncomingMessage>((h) => rig.messenger.onMessage(h));
    await rig.deliverMessage({ text: "hi all", timestamp: 77, group: GROUP });
    const m = await got;
    assert.equal(m.group?.id, GROUP);
    assert.equal(m.direct, false);
    assert.equal(m.text, "hi all");
  });

  withRig("reactions and deletions arrive neutral", async (rig) => {
    const reaction = next<IncomingReaction>((h) => rig.messenger.onReaction(h));
    const deletion = next<IncomingDeletion>((h) => rig.messenger.onDeletion(h));
    await rig.deliverReaction({ emoji: "👍", targetTimestamp: 5 });
    await rig.deliverDeletion({ targetTimestamp: 10 });
    const r = await reaction;
    assert.deepEqual([r.emoji, r.targetTimestamp, r.isRemove], ["👍", 5, false]);
    assert.equal((await deletion).targetTimestamp, 10);
  });

  withRig("one handler per kind: registering again replaces the earlier one", async (rig) => {
    const seen: string[] = [];
    rig.messenger.onMessage(() => seen.push("old"));
    const second = next<IncomingMessage>((h) => rig.messenger.onMessage((x) => (seen.push("new"), h(x))));
    await rig.deliverMessage({ text: "x", timestamp: 1 });
    await second;
    assert.deepEqual(seen, ["new"]);
  });

  withRig("groups lists what the platform reports", async (rig) => {
    if (!rig.messenger.capabilities.groups) return;
    const list: GroupInfo[] = [{ id: "g1", name: "Family", members: [{ number: "+10000000000", uuid: "11111111-2222-4333-8444-555555555555" }] }];
    rig.setGroups(list);
    assert.deepEqual(await rig.messenger.groups(), list);
  });

  withRig("attachments: a plain id resolves to a local file with its content, anything that could leave the folder is refused; long text is read whole or not at all", async (rig) => {
    await rig.addAttachment("abc.m4a", "voice bytes");
    const file = await rig.messenger.attachmentFile({ id: "abc.m4a" });
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(file, "utf8"), "voice bytes");
    for (const bad of ["../secret", "a/b", ""]) await assert.rejects(() => rig.messenger.attachmentFile({ id: bad }), bad);
    await rig.addLongText("long1", "the whole long text");
    assert.deepEqual(await rig.messenger.readLongText({ id: "long1" }), { text: "the whole long text", cut: false });
    assert.equal(await rig.messenger.readLongText({ id: "missing" }), undefined);
    assert.equal(await rig.messenger.readLongText({ id: "../secret" }), undefined);
  });

  withRig("onClose: a lost connection is reported once", async (rig) => {
    const reasons: string[] = [];
    const first = next<{ reason: string }>((h) => rig.messenger.onClose((i) => (reasons.push(i.reason), h(i))));
    await rig.dropConnection();
    const info = await first;
    assert.ok(info.reason.length > 0);
    rig.messenger.stop(); // after the loss: whatever else happens while it winds down is not a second loss
    await rig.disconnected();
    assert.equal(reasons.length, 1);
  });

  withRig("stopping on purpose is not a loss, and stopping twice is safe", async (rig) => {
    const reasons: string[] = [];
    rig.messenger.onClose((i) => reasons.push(i.reason));
    rig.messenger.stop();
    rig.messenger.stop();
    await rig.disconnected(); // the platform saw it go; had a close been reported it would have been by now
    assert.deepEqual(reasons, []);
  });
}
