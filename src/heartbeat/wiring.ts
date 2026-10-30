import { setApprovers } from "../approvals/permissions.ts";
import { factsFor } from "./facts.ts";
import { turnFactsFrom } from "../run/turncontext.ts";
import { removeFriend } from "../conversation/tenantremoval.ts";
import { tenantHooks } from "../tenants/tenanttools.ts";

// Everything main.ts must hand to the modules that cannot import the messenger (or each other) themselves: the senders that reach the owner's chat, the approvers, and the
// tenant lifecycle hooks. They are module-level setters (those modules are used from runs that have no pipeline in reach), so this is the ONE place they are set, once, at start:
// main.ts builds an AppContext and calls wire(). A hook missing here stops the start with its name, instead of a notice or a question silently going nowhere later.
export interface AppContext {
  approvers: Parameters<typeof setApprovers>[0]; // who is asked about a call, in the conversation that triggered it (approvers.ts)
  dropTenant: (id: string) => void; // a suspended or removed tenant: her warm process and every connection of hers stop (tenanttools.ts)
  sendFirst?: NonNullable<typeof tenantHooks.sendFirst>; // the owner's hello to a number or username (invite_person); absent where the platform has none, by design
}

let wired = false;
export function wire(ctx: AppContext): void {
  const missing = (["approvers", "dropTenant"] as const).filter((k) => typeof ctx[k] !== "function");
  if (missing.length) throw new Error(`startup wiring incomplete: ${missing.join(", ")} not set (main.ts builds the AppContext)`);
  if (wired) throw new Error("startup wiring runs once");
  wired = true;
  setApprovers(ctx.approvers);
  turnFactsFrom((conv, now) => factsFor(conv, now, true)); // every chat turn gets the facts a look gets (facts.ts)
  tenantHooks.sendFirst = ctx.sendFirst;
  tenantHooks.drop = ctx.dropTenant;
  tenantHooks.remove = removeFriend;
}
