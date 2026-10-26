import { capNoticesTo } from "../core/capnotice.ts";
import { setApprovers } from "../approvals/permissions.ts";
import { keyNotices } from "../tenants/keynotice.ts";
import { holdFact, ownerNotices } from "./notices.ts";
import { removeFriend } from "../conversation/tenantremoval.ts";
import { tenantHooks } from "../tenants/tenanttools.ts";

// Everything main.ts must hand to the modules that cannot import the messenger (or each other) themselves: the senders that reach the owner's chat, the approvers, and the
// tenant lifecycle hooks. They are module-level setters (those modules are used from runs that have no pipeline in reach), so this is the ONE place they are set, once, at start:
// main.ts builds an AppContext and calls wire(). A hook missing here stops the start with its name, instead of a notice or a question silently going nowhere later.
export interface AppContext {
  approvers: Parameters<typeof setApprovers>[0]; // who is asked about a call, in the conversation that triggered it (approvers.ts)
  notifyOwner: (text: string) => void; // a plain notice in the owner's chat: the shared-key notice (keynotice.ts), the daily cap line (capnotice.ts), the budget notice (heartbeat/notices.ts)
  dropTenant: (id: string) => void; // a suspended or removed tenant: her warm process and every connection of hers stop (tenanttools.ts)
  sendFirst?: NonNullable<typeof tenantHooks.sendFirst>; // the owner's hello to a number or username (invite_person); absent where the platform has none, by design
}

let wired = false;
export function wire(ctx: AppContext): void {
  const missing = (["approvers", "notifyOwner", "dropTenant"] as const).filter((k) => typeof ctx[k] !== "function");
  if (missing.length) throw new Error(`startup wiring incomplete: ${missing.join(", ")} not set (main.ts builds the AppContext)`);
  if (wired) throw new Error("startup wiring runs once");
  wired = true;
  setApprovers(ctx.approvers);
  keyNotices.sendTo(holdFact); // (the owner's own look can run on the login: a fact for it, never a ping at night)
  capNoticesTo(holdFact);
  ownerNotices.sendTo(ctx.notifyOwner);
  tenantHooks.sendFirst = ctx.sendFirst;
  tenantHooks.drop = ctx.dropTenant;
  tenantHooks.remove = removeFriend;
}
