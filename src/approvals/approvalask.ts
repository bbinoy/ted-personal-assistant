import { audit, wordless, type Source } from "../core/audit.ts";
import * as approvals from "./approvals.ts";
import { callKey, type Approve } from "./permissions.ts";
import { recentIn } from "./recentchat.ts";
import { composeQuestion } from "./approvalmodel.ts";
import { LIMITS } from "../core/sanitize.ts";
import { isTenantKey } from "../core/ownerkey.ts";

// Asking the owner: a model writes the question in one call and code validates it against the exact arguments (approvalmodel.ts,
// questionfacts.ts); if that fails nothing is asked. The ask is audited with the FULL arguments, the exact text sent and, afterwards,
// the outcome and whether the call that ran has the arguments the question was written for, so a divergence between intent and
// behaviour can be investigated.

// Full arguments, size-capped; audit() redacts secrets in the whole line.
export const argsForAudit = (input: Record<string, unknown>): unknown => {
  const json = JSON.stringify(input);
  return json.length <= LIMITS.args ? input : `${json.slice(0, LIMITS.args)}… (+${json.length - LIMITS.args} more characters)`;
};

// Plain equality of two argument sets (key order does not matter).
export const sameArgs = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => callKey("", a) === callKey("", b);

// `scope`: the conversation the question is asked in (its Conversation.key): only an answer there applies. `source`: the audit label of
// the asker. `mayPay`: the chat of the person whose card it is; a group and an unattended run never pay.
// `request` and `compose` are the real ones unless a test supplies its own.
export function makeApprove(send: (text: string) => Promise<number>, o: { scope: string; source: Source; background?: boolean; mayPay?: boolean; request?: typeof approvals.request; compose?: typeof composeQuestion }): Approve {
  const { scope, source, background = false, mayPay = false, request = approvals.request, compose = composeQuestion } = o;
  const rows = (meta: Record<string, unknown>) => (isTenantKey(scope) ? wordless(meta) : meta); // a tenant's rows carry no words (audit.ts)
  return async (description, call, abort, o) => {
    // A card payment is asked in the chat of the person whose card it is only, never in a group and never by an unattended run.
    if (o?.typedYes && (background || !mayPay)) return { approved: false, failure: "a card payment can only be approved in the owner's own chat" };
    // One model call writes it, code validates it. No question means no ask and no card: the agent gets the failure as the tool result.
    const c = await compose({ tool: call.tool, args: call.input, details: description, recent: recentIn(scope), background, source });
    if (c.text === undefined) return { approved: false, failure: `no question could be written that states the exact arguments (${c.failure})` };
    const question = c.text;
    const asked = structuredClone(call.input);
    audit(call.tool, "approval-asked", source, rows({ args: argsForAudit(asked), question, details: description, writeMs: c.ms, by: c.by }));
    const d = await request(send, description, call, abort, { background, question, scope, source, typedYes: o?.typedYes });
    // Post-hoc, never blocking: is what will run what the question was written for?
    audit(call.tool, "approval-outcome", source, rows({ approved: d.approved, modified: !!d.updatedInput, argsEqual: sameArgs(asked, d.updatedInput ?? call.input), ...(d.feedback ? { feedback: d.feedback.slice(0, LIMITS.line) } : {}), ...(d.updatedInput ? { executed: argsForAudit(d.updatedInput) } : {}) }));
    return { ...d, question };
  };
}
