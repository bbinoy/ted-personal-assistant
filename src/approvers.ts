import type { Target } from "@ted-assistant/messenger";
import { makeApprove } from "./approvalask.ts";
import { DENY_ALL, type Approve, type ApproverOptions } from "./permissions.ts";
import { isTenantKey, OWNER_KEY } from "./ownerkey.ts";
import { targetOf } from "./tenants.ts";

// The one place that decides where a question is asked: IN THE CONVERSATION THAT TRIGGERED THE ACTION, never anywhere else.
//   the owner's chat   the owner's turns and her unattended runs (wake-ups, brief, radar, mail handler): her chat; a background question
//                      only an explicit yes / no or a reply to it answers (approvals.ts)
//   a group            the group itself; any member may answer there
//   "tenant:<id>"      that tenant's own chat, never the admin's: the admin's messages are another conversation and answer nothing here
// A person who is gone (removed) cannot be asked anywhere: the question is not sent, and never falls back to the owner's chat.
// A card payment is asked in the owner's foreground chat only (the card is hers); a group and a tenant never pay.
export function createApprovers(out: { reply(text: string, opts: { plain: true; kind: "approval"; target?: Target }): Promise<number> }, deps: { make?: typeof makeApprove; target?: (tenantId: string) => string | undefined } = {}): (key: string, o?: ApproverOptions) => Approve {
  const make = deps.make ?? makeApprove;
  const target = deps.target ?? targetOf;
  return (key, o = {}) => {
    const background = !!o.background;
    const send = (target?: Target) => (text: string) => out.reply(text, { plain: true, kind: "approval", ...(target ? { target } : {}) });
    if (key === OWNER_KEY) return make(send(), { scope: key, source: background ? "background" : "chat", background, mayPay: true });
    if (isTenantKey(key)) {
      const to = target(key.slice("tenant:".length));
      return to ? make(send(to), { scope: key, source: "group", background }) : DENY_ALL;
    }
    return make(send(key), { scope: key, source: "group", background });
  };
}
