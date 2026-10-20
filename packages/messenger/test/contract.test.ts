import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messengerContract, type ContractRig } from "@ted-personal-assistant/messenger/contract";
import { FakeMessenger } from "@ted-personal-assistant/messenger/testing";

// The fake messenger passes the same contract as a real platform: what the app's tests run on behaves like what it will run against.

messengerContract("fake", async (): Promise<ContractRig> => {
  const dir = mkdtempSync(join(tmpdir(), "fake-contract-"));
  const messenger = new FakeMessenger();
  await messenger.start();
  const base = { from: "+10000000000", fromUuid: "11111111-2222-4333-8444-555555555555", direct: true };
  return {
    messenger,
    deliverMessage: (m) => messenger.pushMessage({ ...base, text: m.text, timestamp: m.timestamp, direct: !m.group, ...(m.group ? { group: { id: m.group } } : {}) }),
    deliverReaction: (r) => messenger.pushReaction({ ...base, emoji: r.emoji, targetTimestamp: r.targetTimestamp, isRemove: false }),
    deliverDeletion: (d) => messenger.pushDeletion({ ...base, targetTimestamp: d.targetTimestamp }),
    refuse: () => void (messenger.sendError = new Error("refused")), // (the fake only ever fails a send)
    accept: () => void (messenger.sendError = undefined),
    dropConnection: () => messenger.pushClose("the connection was lost"),
    disconnected: async () => {},
    setGroups: (list) => void (messenger.groupList = list),
    addAttachment: (id, content) => {
      const file = join(dir, id);
      writeFileSync(file, content);
      messenger.files.set(id, file);
    },
    addLongText: (id, text) => void messenger.longTexts.set(id, { text, cut: false }),
    close: async () => rmSync(dir, { recursive: true, force: true }),
  };
});
