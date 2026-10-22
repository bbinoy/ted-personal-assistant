import type { Target } from "@ted-assistant/messenger";
import { makeApprove } from "./approvalask.ts";
import { DENY_ALL, UNATTENDED_SKIP, type Approve, type ApproverOptions } from "./permissions.ts";
import { isTenantKey, OWNER_KEY } from "../core/ownerkey.ts";
import { targetOf } from "../tenants/tenants.ts";

// The approver of an unattended run: nothing is ever sent or parked; the call is refused with the run's fixed text (permissions.ts already said it before this is reached).
export const NEVER_ASKS: Approve = async () => ({ approved: false, failure: UNATTENDED_SKIP });

// The one place that decides where a question is asked: IN THE CONVERSATION THAT TRIGGERED THE ACTION, never anywhere else.
//   the owner's chat   the owner's turns and her unattended runs (wake-ups, brief, radar, mail handler): her chat; a background question
//                      only an explicit yes / no or a reply to it answers (approvals.ts)
//   a group            the group itself; any member may answer there
//   "tenant:<id>"      that tenant's own chat, never the admin's: the admin's messages are another conversation and answer nothing here
// A person who is gone (removed) cannot be asked anywhere: the question is not sent, and never falls back to the owner's chat.
// An unattended run (`background`: a look of the owner, a group or a friend, its expert, meeting prep) asks NOBODY: permissions.ts declines what would need a yes back to the
// run (UNATTENDED_SKIP), and its approver here is NEVER_ASKS, so even a path that got past that sends nothing and parks nothing.
// A card payment is asked in the owner's foreground chat only (the card is hers); a group and a tenant never pay.
export function createApprovers(out: { reply(text: string, opts: { plain: true; kind: "approval"; target?: Target }): Promise<number> }, deps: { make?: typeof makeApprove; target?: (tenantId: string) => string | undefined } = {}): (key: string, o?: ApproverOptions) => Approve {
  const make = deps.make ?? makeApprove;
  const target = deps.target ?? targetOf;
  return (key, o = {}) => {
    if (o.background) return NEVER_ASKS;
    const send = (target?: Target) => (text: string) => out.reply(text, { plain: true, kind: "approval", ...(target ? { target } : {}) });
    if (key === OWNER_KEY) return make(send(), { scope: key, source: "chat", mayPay: true });
    if (isTenantKey(key)) {
      const to = target(key.slice("tenant:".length));
      return to ? make(send(to), { scope: key, source: "group" }) : DENY_ALL;
    }
    return make(send(key), { scope: key, source: "group" });
  };
}
