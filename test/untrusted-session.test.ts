import { test } from "node:test";
import assert from "node:assert/strict";
import { carriedTaint, forgetUnresumable, sessionTaint } from "../src/run/chatsession.ts";
import { consume } from "../src/run/agentrun.ts";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { readSession } from "../src/run/sessionstore.ts";
import { groupConvId } from "../src/core/convpaths.ts";
import { settings } from "../src/core/settings.ts";
import { scopeOf } from "../src/approvals/turnscope.ts";
import { OWNER_CHAT } from "./runkinds.ts";

// The untrusted-input flag of a chat session: kept in the session record, so a resumed session that holds a hostile mail is still told to the judge.

const MB = "mcp__mailbird__";
const opts = { signal: new AbortController().signal } as never;
type Out = { behavior: string; message?: string };
type Seen = { description: string; provenance: { kind: string; by?: string; text?: string; message?: string; task?: string; browseTask?: string; assistantSaid?: string }; untrustedInput?: boolean };
const fake = (decision: Verdict["decision"] = "auto", reason = "test") => {
  const seen: Seen[] = [];
  return { seen, fn: (async (i: Seen): Promise<Verdict> => (seen.push(i), { decision, reason })) as never };
};
const setAuto = (mode: "auto" | "off") => void ((settings as { autoApprove: string }).autoApprove = mode);

const FILE = groupConvId("provenance-taint"); // (a conversation of its own: its session record is in its own assistant.db)
const turnEnd = async (sessionId: string) => {
  async function* stream() {
    yield { type: "result", subtype: "success", is_error: false, session_id: sessionId, total_cost_usd: 0.01, result: "ok" } as never;
  }
  await consume(stream(), { kind: OWNER_CHAT, systemPrompt: "x", sessionConv: FILE, maxTurns: 1, maxBudgetUsd: 1 }, 0);
};

test("the untrusted flag is kept in the session record: set by a read of mail, still on the next turn of that session, kept by a compaction, cleared by a new session", async () => {
  setAuto("auto");
  scopeOf("owner").say("tidy my inbox");
  const turn = (resume: string | undefined) => {
    const j = fake("auto");
    const can = makeCanUseTool(async () => ({ approved: false }), OWNER_CHAT, undefined, j.fn, undefined, undefined, false, { provenance: scopeOf("owner").read, conversation: `taint-${Math.random()}`, taint: sessionTaint(FILE, resume) });
    return { j, can };
  };
  let n = 0;
  const archive = (can: ReturnType<typeof turn>["can"]) => can(`${MB}archive_conversation`, { conversationId: `t${n++}` }, opts) as Promise<Out>;
  // turn 1: a fresh session; the run archives, reads a mail, archives again: the judge is told from the read on
  const t1 = turn(undefined);
  await archive(t1.can);
  await t1.can(`${MB}get_message`, { messageId: 1 }, opts);
  await archive(t1.can);
  assert.deepEqual(t1.j.seen.map((s) => s.untrustedInput), [false, true]);
  await turnEnd("S1"); // consume() writes the session: the flag belongs to S1 now
  assert.equal(readSession(FILE).untrustedIn, "S1");
  // turn 2: the same session resumed, nothing read yet in this turn: the hostile mail is still in its context
  const t2 = turn("S1");
  assert.equal(((await archive(t2.can)) as Out).behavior, "allow");
  assert.deepEqual(t2.j.seen.map((s) => s.untrustedInput), [true]);
  await turnEnd("S1");
  assert.equal(readSession(FILE).untrustedIn, "S1", "kept across turns");
  // a compaction continues the session (a new id, its summary may still hold the text): kept, conservatively
  assert.deepEqual(carriedTaint({ costUsd: 0, sessionId: "S1", untrustedIn: "S1" }, "S1-compacted"), { untrustedIn: "S1-compacted" });
  assert.deepEqual(carriedTaint({ costUsd: 0, sessionId: "S1" }, "S1-compacted"), {}, "a clean session stays clean");
  // a session that is not the tainted one is clean: a stale flag never follows a new id
  assert.deepEqual(carriedTaint({ costUsd: 0, sessionId: "S9", untrustedIn: "S1" }, "S10"), {});
  // a new session (the saved one can no longer be resumed, so it is forgotten): starts clean
  assert.ok(forgetUnresumable(FILE, new Error("No conversation found with session ID: S1"), "chat"));
  assert.equal(readSession(FILE).untrustedIn, undefined);
  const t3 = turn(undefined);
  await archive(t3.can);
  assert.deepEqual(t3.j.seen.map((s) => s.untrustedInput), [false], "a fresh session has read nothing");
  await turnEnd("S2");
  assert.equal(readSession(FILE).untrustedIn, undefined);
  const t4 = turn("S2");
  await archive(t4.can);
  assert.deepEqual(t4.j.seen.map((s) => s.untrustedInput), [false]);
});
