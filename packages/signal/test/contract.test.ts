import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messengerContract, type ContractRig } from "@ted-assistant/messenger/contract";
import type { GroupInfo } from "@ted-assistant/messenger";
import { createMessenger } from "../src/messenger.ts";
import { FakeRpcError, FakeSignalDaemon } from "../src/testing.ts";

// The Signal adapter against the contract every Messenger passes (packages/messenger/src/contract.ts), over a fake signal-cli daemon on a real socket.

const OWNER = "+10000000000";
const BOT = "+10000000001";
const OWNER_ACI = "11111111-2222-4333-8444-555555555555";

messengerContract("signal", async (): Promise<ContractRig> => {
  const dir = mkdtempSync(join(tmpdir(), "signal-contract-"));
  mkdirSync(dir, { recursive: true });
  let refuse: "none" | "send" | "everything" = "none";
  let groups: GroupInfo[] = [];
  let stamp = 4000;
  const daemon = await FakeSignalDaemon.start((r) => {
    if (refuse === "everything" || (refuse === "send" && r.method === "send")) return new FakeRpcError("refused");
    if (r.method === "send") return { timestamp: ++stamp };
    if (r.method === "listGroups") return groups;
    return {};
  });
  const messenger = await createMessenger({ owner: { address: OWNER, id: OWNER_ACI }, account: BOT, options: { host: daemon.host, port: daemon.port, attachmentsDir: dir }, logger: { info() {}, warn() {}, error() {} } });
  await messenger.start(); // the fake already listens, so the daemon is reused
  await daemon.whenConnections((n) => n > 0);
  const from = { sourceNumber: OWNER, sourceUuid: OWNER_ACI };
  return {
    messenger,
    deliverMessage: (m) => daemon.push({ ...from, dataMessage: { timestamp: m.timestamp, message: m.text, ...(m.group ? { groupInfo: { groupId: m.group } } : {}) } }),
    deliverReaction: (r) => daemon.push({ ...from, dataMessage: { timestamp: 9, reaction: { emoji: r.emoji, targetSentTimestamp: r.targetTimestamp, targetAuthorNumber: BOT } } }),
    deliverDeletion: (d) => daemon.push({ ...from, dataMessage: { timestamp: 11, remoteDelete: { targetTimestamp: d.targetTimestamp } } }),
    refuse: (o) => void (refuse = o?.everything ? "everything" : "send"),
    accept: () => void (refuse = "none"),
    dropConnection: () => daemon.dropConnections(),
    disconnected: () => daemon.whenConnections((n) => n === 0),
    setGroups: (list) => void (groups = list),
    addAttachment: (id, content) => writeFileSync(join(dir, id), content),
    addLongText: (id, text) => writeFileSync(join(dir, id), text),
    close: async () => {
      await daemon.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
