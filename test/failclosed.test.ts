import { test } from "node:test";
import assert from "node:assert/strict";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { readAudit } from "../src/audit.ts";
import { setDraftReader } from "../src/modules/mailbird.ts";
import { makeCanUseTool, type CallGuard } from "../src/approvals/permissions.ts";
import { settings } from "../src/settings.ts";

// A check that fails for any reason denies the call.

const MB = "mcp__mailbird__";
const CAL = "mcp__claude_ai_Google_Calendar__create_event";
const opts = { signal: new AbortController().signal } as never;
type Out = { behavior: string; message?: string };
type Seen = { description: string; provenance: { kind: string; by?: string; text?: string; message?: string; task?: string; browseTask?: string; assistantSaid?: string }; untrustedInput?: boolean };
const fake = (decision: Verdict["decision"] = "auto", reason = "test") => {
  const seen: Seen[] = [];
  return { seen, fn: (async (i: Seen): Promise<Verdict> => (seen.push(i), { decision, reason })) as never };
};
const noJudge = async (): Promise<Verdict> => ({ decision: "ask", reason: "test" });
const setAuto = (mode: "auto" | "off") => void ((settings as { autoApprove: string }).autoApprove = mode);

test("any error on the way is a deny with a fixed message and an audit row, never an allow", async () => {
  setAuto("off");
  const start = new Date().toISOString();
  const throwing: CallGuard = { decide: async () => { throw new Error("guard exploded with words in it"); } };
  const canGuard = makeCanUseTool(async () => ({ approved: true }), "chat", undefined, noJudge, throwing);
  const r1 = (await canGuard(`${MB}archive_conversation`, { conversationId: "x1" }, opts)) as Out;
  assert.equal(r1.behavior, "deny");
  assert.match(r1.message ?? "", /could not be checked, so it was not run/);
  assert.doesNotMatch(r1.message ?? "", /exploded/);
  // the read-back of a draft throws
  setDraftReader(async () => { throw new Error("mail client gone"); });
  const canSend = makeCanUseTool(async () => ({ approved: true }), "chat", undefined, noJudge);
  assert.equal(((await canSend("mcp__mailbird__send_message_now", { messageId: 1, confirm: true }, opts)) as Out).behavior, "deny");
  // the approver throws
  setDraftReader(async () => ({ to: ["a@example.com"], cc: [], bcc: [], subject: "s", body: "b", hasAttachments: false }) as never);
  const canAsk = makeCanUseTool(async () => { throw new Error("signal down"); }, "chat", undefined, noJudge);
  assert.equal(((await canAsk(CAL, { summary: "Boom", startTime: "2026-10-22T10:00:00" }, opts)) as Out).behavior, "deny");
  // the judge's set-up throws (a provenance that cannot be read)
  const canJudge = makeCanUseTool(async () => ({ approved: true }), "chat", undefined, fake().fn, undefined, undefined, false, { provenance: () => { throw new Error("scope broken"); } });
  setAuto("auto");
  assert.equal(((await canJudge(CAL, { summary: "Boom2", startTime: "2026-10-22T11:00:00" }, opts)) as Out).behavior, "deny");
  const rows = readAudit((e) => e.decision === "deny-error" && e.ts >= start);
  assert.ok(rows.length >= 3, "each failure is audited (the guard, the approver, the judge's set-up)");
  assert.ok(rows.every((e) => e.meta?.error === "Error"), "the class of the error, never its words");
});
