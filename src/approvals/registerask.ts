import * as approvals from "./approvals.ts";
import { OWNER_KEY } from "../core/ownerkey.ts";
import { approve, decline, labelOf, openRequests, shortId, type Held, type Request } from "../tenants/registration.ts";
import type { TenantRecord } from "../tenants/tenants.ts";

// Asking the owner whether a stranger may join (registration.ts), through the same approval machinery as every other question (approvals.ts): in the OWNER'S chat only
// (scope OWNER_KEY), answered there by a yes / no, a reply to the question or a 👍 / 👎, and nowhere else: a group, a friend's chat or the stranger's own
// messages never answer it (approvals.ts scopes every question to its conversation). The question is written HERE, by code: her sanitised profile name and a short id, never
// anything she wrote and never a model's words about her. Yes: she becomes a tenant and what she wrote meanwhile is replayed as her first turn. No: remembered as declined,
// silent, her held text deleted. No answer for a day: the question lapses, the request stays open (and is asked again at the next start) until it expires after 7 days.

export const questionFor = (r: Pick<Request, "aci" | "name" | "number">): string => `Approve ${labelOf(r)} as a friend? They wrote to me; I have not looked at what they wrote. Reply yes or no.`;
const LAPSE_MINUTES = 24 * 60;

export interface Registrar {
  ask(request: Request): void; // put one request to the owner (once at a time per person)
  askOpen(): void; // after a start: every open request that is not being asked
}

export function createRegistrar(deps: {
  send: (text: string) => Promise<number>; // the owner's chat (plain, kind approval)
  joined: (tenant: TenantRecord, held: Held[], request: Request) => void; // she is in: replay what she wrote
  request?: typeof approvals.request;
}): Registrar {
  const request = deps.request ?? approvals.request;
  const asking = new Set<string>();
  function ask(r: Request): void {
    if (asking.has(r.aci)) return;
    asking.add(r.aci);
    let unsent = false; // a question that could not be sent is no "no": the request stays open and is asked again at the next start
    const send = (text: string) => deps.send(text).catch((e) => ((unsent = true), Promise.reject(e)));
    void request(send, `Approve ${shortId(r)} as a friend`, { tool: "tenant_register", input: { id: shortId(r) } }, undefined, {
      scope: OWNER_KEY,
      source: "chat",
      background: true,
      question: questionFor(r),
      minutes: LAPSE_MINUTES,
      quietExpiry: true, // it lapses without a line in the chat: the request stays open and is asked again at the next start
    })
      .then((d) => {
        asking.delete(r.aci);
        if (d.expired || unsent) return;
        if (d.approved) {
          const done = approve(r.aci);
          if (done?.request) deps.joined(done.tenant, done.held, done.request);
        } else decline(r.aci);
      })
      .catch((e) => {
        asking.delete(r.aci);
        console.error("registration question failed:", (e as Error).message);
      });
  }
  return { ask, askOpen: () => openRequests().forEach(ask) };
}
