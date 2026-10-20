import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { browseRunOptions } from "../src/run/agentrun.ts";
import { judgePrompt, provenanceFor, type Verdict } from "../src/approvals/autojudge.ts";
import type { BrowseGuard } from "../src/modules/browse/browseguard.ts";
import * as permissions from "../src/approvals/permissions.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { settings } from "../src/core/settings.ts";
import { derivedTurn, scopeOf } from "../src/approvals/turnscope.ts";

// Provenance is code: the turn scope of a conversation, derived text for what nobody wrote, the browse sub-run inheriting its parent's.

const opts = { signal: new AbortController().signal } as never;
type Seen = { description: string; provenance: { kind: string; by?: string; text?: string; message?: string; task?: string; browseTask?: string; assistantSaid?: string }; untrustedInput?: boolean };
const fake = (decision: Verdict["decision"] = "auto", reason = "test") => {
  const seen: Seen[] = [];
  return { seen, fn: (async (i: Seen): Promise<Verdict> => (seen.push(i), { decision, reason })) as never };
};
const setAuto = (mode: "auto" | "off") => void ((settings as { autoApprove: string }).autoApprove = mode);

// ---- the turn scope ----

test("a conversation's scope: the owner's last three messages and what the assistant said, a member's single message (gone at the end), a gate's derived task, each conversation its own", () => {
  const o = scopeOf("owner");
  o.end();
  assert.equal(o.read(), undefined);
  for (const m of ["one", "two", "three", "four"]) o.say(m);
  o.assistantSaid("Draft shown. Say send.");
  assert.deepEqual(o.read(), { kind: "owner", message: "four", earlier: ["two", "three"], assistantSaid: "Draft shown. Say send." });
  o.end();
  assert.equal(o.read()?.kind, "owner", "the owner's recent messages stay across turns");
  // a reaction: the reaction is the message and the reacted-to text is what the assistant said
  o.say("Ben reacted 👍", "Here is the invoice text from the mail");
  assert.deepEqual(o.read(), { kind: "owner", message: "Ben reacted 👍", earlier: ["three", "four"], assistantSaid: "Here is the invoice text from the mail" });
  // a member's
  const g = scopeOf("g-scope");
  g.say("book a table");
  assert.deepEqual(g.read(), { kind: "member", message: "book a table" });
  assert.equal(scopeOf("g-other").read(), undefined, "another conversation reads nothing of it");
  g.end();
  assert.equal(g.read(), undefined, "forgotten when the turn ends");
  // an unattended turn
  g.derive("gate", "water the plants");
  assert.deepEqual(g.read(), { kind: "derived", by: "gate", of: "member", text: "water the plants" });
  g.end();
  assert.equal(g.read(), undefined);
});

test("derivedTurn: the task is derived while the run goes on, gone after it, even when the run fails", async () => {
  const seen: unknown[] = [];
  await derivedTurn("g-derived", "gate", "task text", async () => void seen.push(scopeOf("g-derived").read()));
  await assert.rejects(derivedTurn("g-derived", "gate", "t2", async () => { throw new Error("x"); }));
  assert.deepEqual(seen, [{ kind: "derived", by: "gate", of: "member", text: "task text" }]);
  assert.equal(scopeOf("g-derived").read(), undefined);
});

test("no message state is process-global in permissions.ts, and the mail handler's provenance is passed in, not a made-up speaker", () => {
  for (const gone of ["setConversationMessage", "setChatOwnerMessage", "setChatAssistantMessage"]) assert.equal(gone in permissions, false, gone);
  for (const file of ["src/approvals/permissions.ts", "src/run/agent.ts", "src/run/agentrun.ts"]) {
    const code = readFileSync(join(import.meta.dirname, "..", file), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.doesNotMatch(code, /mail-handler:|recentMessages|chatAssistantMessage|judgeContext|\bspeaker\b/, file);
  }
});

// ---- the browse sub-run inherits ----

test("the browse sub-run inherits the provenance and the conversation of the run that started it, and its own task is the assistant's", async () => {
  const guard = { task: "pay Dr Strange's invoice", vision: "off", profileKeys: () => [], cardInfo: () => undefined } as unknown as BrowseGuard;
  const parent = { provenance: () => ({ kind: "derived", by: "gate", of: "owner", text: "wake-up task" }) as const, conversation: "owner" };
  const o = browseRunOptions(guard, undefined, parent);
  assert.equal(o.provenance, parent.provenance);
  assert.equal(o.conversation, "owner");
  assert.equal(o.untrusted, true);
  // the judge: the parent's words stay the authority; the worker's task is labelled as written by the assistant, never as the instructions a job was given
  const j = fake("ask");
  setAuto("auto");
  const can = makeCanUseTool(async () => ({ approved: false }), "browse", undefined, j.fn, undefined, undefined, false, { provenance: o.provenance, conversation: o.conversation, browseTask: guard.task, untrusted: true });
  await can("mcp__browser__browser_navigate", { url: "https://example.com/a" }, opts);
  assert.deepEqual(j.seen[0]!.provenance.kind, "derived");
  assert.equal(j.seen[0]!.provenance.browseTask, "pay Dr Strange's invoice");
  const prompt = judgePrompt(j.seen[0] as never);
  assert.match(prompt, /PROVENANCE: scheduled wake-up/);
  assert.match(prompt, /gave its browser worker \(written by the assistant/);
  assert.doesNotMatch(prompt, /job_instructions/);
  // a worker with no parent provenance has only what the assistant wrote: derived by the assistant, not standing
  assert.equal(provenanceFor(undefined, "browse", "t")?.kind, "derived");
});
