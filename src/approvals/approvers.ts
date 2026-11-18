import type { Target } from "@ted-assistant/messenger";
import { makeApprove } from "./approvalask.ts";
import { DENY_ALL, type Approve, type ApproverOptions } from "./permissions.ts";
import { isTenantKey, OWNER_KEY } from "../core/ownerkey.ts";
import { targetOf } from "../tenants/tenants.ts";

// The one place that decides where a question is asked: IN THE CONVERSATION THAT TRIGGERED THE ACTION, never anywhere else.
//   the owner's chat   the owner's turns and her unattended runs (wake-ups, brief, radar, mail handler): her chat
//   a group            the group itself; any member may answer there
//   "tenant:<id>"      that tenant's own chat, never the admin's: the admin's messages are another conversation and answer nothing here
// A person who is gone (removed) cannot be asked anywhere: the question is not sent, and never falls back to the owner's chat.
// A background run (`background`: a look of the owner, a group or a friend, its expert, a routine, meeting prep) asks in the same place and the same way as a chat turn, answered by
// the same rule (approvals.ts). One difference, of timing: while the conversation is being left alone (quiet hours, /quiet) `hold` keeps the wish for the conversation's next look (a held post, notices.ts) and
// nothing is sent; that look puts it again if it still matters, so what has passed lapses.
// A card payment is asked in the card holder's own chat only and needs her typed yes, whoever started it; a group and a tenant never pay.
export function createApprovers(out: { reply(text: string, opts: { plain: true; kind: "approval"; target?: Target }): Promise<number> }, deps: { make?: typeof makeApprove; target?: (tenantId: string) => string | undefined; hold?: (key: string, text: string) => boolean } = {}): (key: string, o?: ApproverOptions) => Approve {
  const make = deps.make ?? makeApprove;
  const target = deps.target ?? targetOf;
  return (key, o = {}) => {
    const ask = approverFor(key);
    return o.background && deps.hold ? async (description, call, abort, ao) => (!deps.hold!(key, `Wanted to ask for a yes on this, but it is quiet hours, so it was not asked: ${description.split("\n").slice(0, 4).join("; ")}. If it still matters, propose it again; otherwise drop it.`) ? ask(description, call, abort, ao) : { approved: false, held: true }) : ask;
  };
  function approverFor(key: string): Approve {
    const send = (target?: Target) => (text: string) => out.reply(text, { plain: true, kind: "approval", ...(target ? { target } : {}) });
    if (key === OWNER_KEY) return make(send(), { scope: key, source: "chat", mayPay: true });
    if (isTenantKey(key)) {
      const to = target(key.slice("tenant:".length));
      return to ? make(send(to), { scope: key, source: "tenant" }) : DENY_ALL;
    }
    return make(send(key), { scope: key, source: "group" });
  }
}
