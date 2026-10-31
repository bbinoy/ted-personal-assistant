import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import type { Source } from "../core/audit.ts";
import { emit } from "../core/events.ts";
import { convDbAt } from "../core/convdb.ts";
import { dataRoot, isConvId, layout } from "../core/convpaths.ts";
import { callKey } from "../core/callkey.ts";
import { fence } from "../core/fence.ts";
import { LIMITS } from "../core/sanitize.ts";
import { formatWait, noteLapsed, request, type Decision, type Handoff } from "./approvals.ts";
import { clearDeclined, noteDeclined } from "./declined.ts";
import { argsForAudit } from "./auditargs.ts";
import { closePending, grantPending, livePending, savePending, voidGrant, type Pending } from "./pendingstore.ts";
import { renderHashOf } from "./permissions.ts";
import type { Change } from "../policy/policy.ts";
import type { RunProvenance } from "./autojudge.ts";
import { prepareJudge } from "./approvaljudge.ts";

// THE APPROVAL HAND-OFF (docs/SAFETY.md). A question that needs a person's yes used to hold its turn (and the conversation's queue) for up to 15 minutes. Now the question is composed, judge-checked
// and sent as before, a row is stored (pendingstore.ts), and the call is denied back to the run at once with "asked; it runs on their yes", so the turn ends and the queue is free. What the
// question ends in is handled here, in code, whenever it comes:
//   yes (any path: the phrase, the judge's reading, a reaction, a quoted reply, an approved edit)   a single-use grant for exactly this call, and a CONTINUATION turn in the same conversation, through
//        the usual intake (so it merges with what is waiting). Its prompt is code-written data: what was approved, fenced. The run calls the tool again; permissions.ts consumes the grant.
//   a reply that is neither yes nor no ("yes but 16:00")   no grant; a continuation turn carries the words so the run re-proposes
//   no, or silence   no grant, nothing said: the next run of the conversation is told as a fact (lapsed_approvals, heartbeat/facts.ts)
// Payments and the browse guard's steps never come here (permissions.ts): they keep the blocking ask. The grant is the only thing a yes leaves; an approval is the chat's own answer (approvals.ts
// scopes it), so no text a run, a mail or another conversation relays can create one. This module cannot import the conversation pipeline: main.ts hands the continuation in (setContinuation).

const GRANT_MINUTES = 5; // a yes only has to last until its continuation runs; one that no run has used by then is void
let proceed: (scope: string, prompt: string, provenance?: RunProvenance) => void = () => {};
/** main.ts (wiring.ts): how a continuation turn enters the conversation `scope`. `provenance`: what led to the turn that asked (the judge reads that, never the prompt below). */
export const setContinuation = (fn: typeof proceed): void => void (proceed = fn);

const callBlock = (tool: string, input: Record<string, unknown>) => fence("approved_call", JSON.stringify({ tool, input }, null, 2));
const changed = (changes?: readonly Change[]) => (changes?.length ? `They approved it with a change (${changes.map((c) => `${c.field} = ${c.value}`).join(", ")}); the arguments above already include it.\n` : "");
const approvedPrompt = (tool: string, input: Record<string, unknown>, changes?: readonly Change[]) =>
  `The person you asked said yes in this conversation, so this call is approved:\n${callBlock(tool, input)}\n${changed(changes)}Run it now, exactly as given (one call, the same tool and arguments), unless a later message from the person cancels or changes it (then do not run it, and answer that message), then report the outcome in your own words, and carry on with what you were doing.`;
const repliedPrompt = (tool: string, input: Record<string, unknown>, reply: string, failure?: string) =>
  `You asked the person to approve this call:\n${callBlock(tool, input)}\nThey did NOT approve it${failure ? ` (${failure})` : ""}. Nothing was executed. Their reply:\n${fence("their_reply", reply)}\nMake a new proposal now (call the tool again with the arguments changed as that reply asks; a fresh question is asked) if you still want to act, otherwise answer them. Do not repeat the original unchanged.`;

/** What the hand-off needs to know about a question that was just sent (or, after a restart, is being brought back). */
type Asked = Omit<Pending, "id" | "status" | "qTs" | "askedAt" | "expiresAt" | "callKey"> & { id?: string; askedAt?: number };

export function handoffFor(a: Asked, minutes: number): Handoff {
  const id = a.id ?? randomUUID();
  const askedAt = a.askedAt ?? Date.now();
  const source = a.askedBy as Source;
  const row = (decision: string, meta: Record<string, unknown>): void => emit({ type: "tool", tool: a.tool, decision, source, conv: a.conv, meta });
  async function decide(d: Decision): Promise<void> {
    if (d.superseded) return void closePending(a.conv, id, "superseded"); // a newer question about the same action replaced it: the run that asked it is still going
    if (d.approved) {
      const input = d.updatedInput ?? a.input;
      const hash = d.updatedInput ? await renderHashOf(a.conv, a.tool, input) : a.renderHash; // (an edit is shown the way the run will call it)
      if (!hash || !grantPending(a.conv, id, input, a.tool, hash, Date.now() + GRANT_MINUTES * 60_000, d.changes && { changes: d.changes })) return void console.error("approvals: a yes could not be turned into a grant, nothing is run");
      clearDeclined(a.conv, a.tool, a.input, Date.now());
      row(d.updatedInput ? "ask-granted-modified" : "ask-granted", { handoff: true }); // (the yes; "granted-run" is the call actually running on it, permissions.ts)
      row("approval-outcome", { approved: true, modified: !!d.updatedInput, argsEqual: callKey("", a.input) === callKey("", input), ...(d.updatedInput ? { executed: argsForAudit(input) } : {}) });
      return proceed(a.conv, approvedPrompt(a.tool, input, d.changes), a.provenance as RunProvenance | undefined);
    }
    if (d.feedback) {
      row("ask-feedback", { handoff: true });
      row("approval-outcome", { approved: false, modified: false, argsEqual: true, feedback: d.feedback.slice(0, LIMITS.line) });
      closePending(a.conv, id, "declined", { feedback: d.feedback });
      return proceed(a.conv, repliedPrompt(a.tool, a.input, d.feedback, d.failure), a.provenance as RunProvenance | undefined);
    }
    row(d.expired ? "ask-expired" : "ask-declined", { handoff: true });
    row("approval-outcome", { approved: false, modified: false, argsEqual: true });
    closePending(a.conv, id, d.expired ? "expired" : "declined");
    if (!d.expired) noteDeclined(a.conv, a.tool, a.input, Date.now()); // a plain no stands until they ask again (declined.ts)
    noteLapsed(a.conv, a.label, formatWait(minutes), d.expired ? "lapsed" : "declined"); // silent: the next run is told as a fact
  }
  return {
    sent: (ts, expiresAt) => savePending({ ...a, id, callKey: callKey(a.tool, a.input), qTs: ts, askedAt, expiresAt }),
    decided: (d) => void decide(d).catch((e) => console.error("approvals: could not settle a handed-off question:", (e as Error).message)),
  };
}

/** After a restart: every question still waiting is open again (its timer runs to the stored end), and a yes that was given but not yet used is void. Call once, after the pipeline is up. */
export function rehydrate(now = Date.now()): void {
  let opened = false;
  const l = layout(dataRoot());
  for (const c of existsSync(l.conversations) ? readdirSync(l.conversations) : []) {
    if (!isConvId(c) || !existsSync(l.conv(c).db)) continue;
    for (const p of livePending(convDbAt(l.root, c))) {
      if (p.expiresAt <= now) {
        if (p.status === "pending" && closePending(p.conv, p.id, "expired")) noteLapsed(p.conv, p.label, formatWait((p.expiresAt - p.askedAt) / 60_000));
      } else if (p.status === "granted") {
        // A yes nobody ran before the stop: words may have come in meanwhile that took it back, and nothing here can tell. It is void; the next run is told, and the person can say it again.
        if (voidGrant(p.conv, p.id)) noteLapsed(p.conv, p.label, "", "interrupted");
      } else {
        opened = true;
        const minutes = (p.expiresAt - now) / 60_000;
        void request(async () => p.qTs, p.label, { tool: p.tool, input: p.input }, undefined, { scope: p.conv, source: p.askedBy as Source, question: p.question, minutes, resumed: true, handoff: handoffFor(p, (p.expiresAt - p.askedAt) / 60_000) });
      }
    }
  }
  if (opened) prepareJudge(); // once, for all of them
}
