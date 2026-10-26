import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { owner, type Conversation } from "../src/conversation/conversation.ts";
import { createWakeups } from "../src/heartbeat/wake.ts";
import { recordMessage, type Kind } from "../src/core/messages.ts";
import { settings } from "../src/core/settings.ts";
import { instanceDb } from "../src/core/instancedb.ts";
import { resetHeld } from "../src/heartbeat/notices.ts";
import { peekConvDb } from "../src/core/convdb.ts";
import { convIdOfKey } from "../src/core/convpaths.ts";
import { rememberMail } from "../src/approvals/journalrender.ts";
import { setShadowRuntime, shadowEndedFact } from "../src/approvals/shadow.ts";
import { scratchLog } from "./scratch.ts";

// The heartbeat look and the gentle first week: a look in shadow mode is handed the floor, its archives end as ONE proposal message, a look after the first week gets no floor and tells the end once,
// SHADOW_MODE=off leaves the look as it was. The permission floor itself and the answers are test/shadow.test.ts.

const s = settings as unknown as Record<string, unknown>;
s.briefBackstopHour = 24;
const DAY = new Date(2026, 9, 14, 14, 0, 0); // a Wednesday, 14:00 local
const DAYS = 86_400_000;
const MB = "mcp__mailbird__";

function rig(run: (extra: { shadow?: (t: string, i: Record<string, unknown>) => string | undefined }, prompt: string) => void | string, firstMessageDaysAgo: number, triage = false) {
  instanceDb().run("DELETE FROM looks");
  resetHeld(owner());
  peekConvDb(convIdOfKey("owner"))?.run("DELETE FROM shadow_state");
  peekConvDb(convIdOfKey("owner"))?.run("DELETE FROM shadow_proposals");
  const dir = mkdtempSync(join(tmpdir(), "shl-"));
  mkdirSync(join(dir, "n"));
  if (triage) writeFileSync(join(dir, "n", "triage-newsletters.md"), "Archive newsletters.\n");
  const conv: Conversation = { ...owner(), logFile: scratchLog(`shl-owner-${Math.random().toString(36).slice(2)}.jsonl`), notesDir: join(dir, "n") };
  recordMessage("owner", DAY.getTime() - firstMessageDaysAgo * DAYS, "hello", new Date(DAY.getTime() - firstMessageDaysAgo * DAYS), conv.logFile);
  let now = DAY;
  const pipeline = {
    canSpeak: () => false, busy: () => false, sendWhile: async (_c: unknown, f: () => Promise<unknown>) => f(), enqueue: <T>(_c: Conversation, job: () => Promise<T>) => job(),
    record: (_c: Conversation, kind: Kind, ts: number, text: string) => recordMessage(kind, ts, text, now, conv.logFile),
    runTurn: async (_c: Conversation, turn: any) => (await turn.run(), { spoke: true }),
  };
  const w = createWakeups({
    pipeline: pipeline as any, groupChats: false, vouch: async () => true,
    run: async (_c, _p, prompt, extra) => ({ text: "", costUsd: 0.01, structured: { message: run(extra, prompt) || "[[silent]]", nextCheckMinutes: 30 } }),
    notesChangedAt: () => 0, now: () => now, guards: { paused: () => false, budgetSpent: () => false },
  });
  return { w, conv, at: (d: Date) => (now = d) };
}
function runtime(o: { holding?: boolean } = {}) {
  const sent: string[] = [];
  setShadowRuntime({ send: async (_c, t) => (sent.push(t), 100 + sent.length), holding: () => !!o.holding, execute: async (_c, calls) => ({ ran: calls.map(() => true) }) });
  return sent;
}
const withMode = async (mode: string, f: () => Promise<void>) => {
  const was = s.shadowMode;
  s.shadowMode = mode;
  try {
    await f();
  } finally {
    s.shadowMode = was;
  }
};

test("a new install's look gets the floor; what it tries to archive ends as ONE proposal message and is not archived", async () => {
  await withMode("auto", async () => {
    const sent = runtime();
    rememberMail("owner", JSON.stringify([{ id: "c1", subject: "Weekly digest", from: "Substack" }, { id: "c2", subject: "Your receipt", from: "Shop" }]), DAY.getTime());
    let verdicts: (string | undefined)[] = [];
    const { w, conv } = rig((extra) => {
      assert.ok(extra.shadow, "the look is in its first week");
      verdicts = [extra.shadow!(`${MB}archive_conversation`, { conversationId: "c1" }), extra.shadow!(`${MB}archive_conversation`, { conversationIds: ["c2"] }), extra.shadow!(`${MB}get_message`, { messageId: 1 })];
    }, 1);
    await w.look(conv, DAY);
    assert.match(verdicts[0] ?? "", /Not archived/);
    assert.match(verdicts[1] ?? "", /Not archived/);
    assert.equal(verdicts[2], undefined, "a read is not an archive");
    assert.equal(sent.length, 1, "ONE message");
    assert.match(sent[0]!, /I'd archive these 2 \(nothing was touched\):\n1\. “Weekly digest” from Substack\n2\. “Your receipt” from Shop\n\n👍 to archive them all/);
  });
});

test("a look that proposes nothing says nothing, and the first week is not over yet (day 1, no triage note)", async () => {
  await withMode("auto", async () => {
    const sent = runtime();
    const { w, conv } = rig(() => {}, 1);
    await w.look(conv, DAY);
    assert.deepEqual(sent, []);
  });
});

test("after the first week (3 days and a triage note) the look gets no floor, and the end as a fact until a look has spoken; no fixed text", async () => {
  await withMode("auto", async () => {
    const sent = runtime();
    let floor: unknown = "unset";
    const prompts: string[] = [];
    let say = "";
    const { w, conv, at } = rig((extra, prompt) => ((floor = extra.shadow), prompts.push(prompt), say), 4, true);
    await w.look(conv, DAY);
    assert.equal(floor, undefined, "no floor: it archives as the notes say");
    assert.match(prompts[0]!, /The gentle first week is over/);
    assert.deepEqual(sent, [], "code says nothing itself");
    at(new Date(DAY.getTime() + 2 * 3_600_000));
    say = "Quick one: I'll archive the routine stuff myself from now on.";
    await w.look(conv, new Date(DAY.getTime() + 2 * 3_600_000));
    assert.match(prompts[1]!, /The gentle first week is over/, "the silent look did not tell it: still a fact");
    assert.equal(shadowEndedFact(conv), "", "the look that spoke told it");
    at(new Date(DAY.getTime() + 4 * 3_600_000));
    await w.look(conv, new Date(DAY.getTime() + 4 * 3_600_000));
    assert.doesNotMatch(prompts[2] ?? "", /The gentle first week is over/, "told once");
  });
});

test("SHADOW_MODE=off: the look is handed no floor on a brand-new install, and nothing is proposed or told", async () => {
  await withMode("off", async () => {
    const sent = runtime();
    let floor: unknown = "unset";
    const { w, conv } = rig((extra) => void (floor = extra.shadow), 0);
    await w.look(conv, DAY);
    assert.equal(floor, undefined);
    assert.deepEqual(sent, []);
  });
});

test("SHADOW_MODE=on: still proposing at 40 days with a triage note", async () => {
  await withMode("on", async () => {
    runtime();
    let floor: unknown;
    const { w, conv } = rig((extra) => void (floor = extra.shadow), 40, true);
    await w.look(conv, DAY);
    assert.equal(typeof floor, "function");
  });
});
