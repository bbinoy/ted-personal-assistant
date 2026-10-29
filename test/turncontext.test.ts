import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratch } from "./scratch.ts";

// What changes between two messages (what is connected, the messages sent on its own) is not in the chat's system prompt but at the start of the
// turn's message, and only when the session has not been told it yet. The system prompt, and with it the warm process and the cached session, stays put.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "turncontext-"));

const { runConversation } = await import("../src/run/agent.ts");
const { owner } = await import("../src/conversation/conversation.ts");
const { runFor } = await import("../src/run/runoptions.ts");
const { recordMessage } = await import("../src/core/messages.ts");
const { recordConnectors } = await import("../src/modules/connectors.ts");
const { forgetShown, markShown, unseen } = await import("../src/run/turncontext.ts");
const { settings } = await import("../src/core/settings.ts");

const NOW = new Date("2026-10-12T09:00:00");
const conv = owner();
const inputs = { now: NOW };
const sessionOf = (id: string) => ({ type: "result", subtype: "success", is_error: false, result: "hi", session_id: id, total_cost_usd: 0.01 });
function rig(sessionId = "s1") {
  const prompts: string[] = [];
  // (the owner's prompt reaches the SDK as a message stream, held until the connectors are settled)
  const textOf = async (p: any): Promise<string> => (typeof p === "string" ? p : String((await p[Symbol.asyncIterator]().next()).value.message.content));
  const query = ((p: { prompt: unknown }) => (async function* () { prompts.push(await textOf(p.prompt)); yield sessionOf(sessionId); })()) as any;
  return { prompts, ask: (text: string) => runConversation(conv, inputs, () => ({ prompt: text }), undefined, { query }) };
}
const warm = settings.warm;

test("turn context: the system prompt does not move with notices or the connectors", () => {
  (settings as { warm: boolean }).warm = false;
  const before = runFor(conv, "message", inputs).systemPrompt;
  recordMessage("notice", Date.now(), "Meeting prep: call at 11:00", new Date());
  recordConnectors([], [{ name: "claude.ai Notion", status: "failed" }]);
  assert.equal(runFor(conv, "message", inputs).systemPrompt, before);
  assert.ok(!before.includes("Meeting prep: call at 11:00") && !before.includes("Not connected right now"));
  (settings as { warm: boolean }).warm = warm;
});

test("turn context: told at the start of the message once, again when it changes, after a new session, and after a compaction", async () => {
  forgetShown(conv.convId);
  const r = rig();
  await r.ask("hello");
  assert.match(r.prompts[0]!, /Meeting prep: call at 11:00[\s\S]*\n\nhello$/);
  await r.ask("second");
  assert.match(r.prompts[1]!, /^CURRENT TIME[^\n]*\n\nsecond$/, "the session has it: not told again");
  recordMessage("notice", Date.now() + 1, "Meeting prep: call at 15:00", new Date());
  await r.ask("third");
  assert.match(r.prompts[2]!, /call at 15:00[\s\S]*third$/);
  assert.match(r.prompts[2]!, /Meeting prep: call at 11:00/, "the whole block again, not only the change");
  await r.ask("fourth");
  assert.match(r.prompts[3]!, /^CURRENT TIME[^\n]*\n\nfourth$/);
  forgetShown(conv.convId); // a compaction
  await r.ask("fifth");
  assert.match(r.prompts[4]!, /call at 15:00[\s\S]*fifth$/);
});

test("turn context: a session that is no longer the one told is told again; a fresh one always", () => {
  const f = scratch("x.json");
  assert.equal(unseen(f, "s1", "ctx"), "ctx");
  markShown(f, "s1", "ctx");
  assert.equal(unseen(f, "s1", "ctx"), undefined);
  assert.equal(unseen(f, "s2", "ctx"), "ctx", "another session");
  assert.equal(unseen(f, undefined, "ctx"), "ctx", "no session to resume: fresh");
  assert.equal(unseen(f, "s1", "other"), "other");
  assert.equal(unseen(f, "s1", undefined), undefined);
  markShown(f, undefined, "ctx");
  assert.equal(unseen(f, "s1", "ctx"), "ctx");
});
