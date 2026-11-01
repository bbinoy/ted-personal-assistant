import * as approvals from "./approvals.ts";
import { OWNER_KEY } from "../core/ownerkey.ts";
import { approve, decline, labelOf, openRequests, shortId, type Held, type Request } from "../tenants/registration.ts";
import type { TenantRecord } from "../tenants/tenants.ts";

// Asking the owner whether a stranger may join (registration.ts), through the same approval machinery as every other question (approvals.ts): in the OWNER'S chat only
// (scope OWNER_KEY), answered there by a yes / no, a reply to the question or a 👍 / 👎, and nowhere else: a group, a friend's chat or the stranger's own
// messages never answer it (approvals.ts scopes every question to its conversation). The question is written HERE, by code: her sanitised profile name and a short id, never
// anything she wrote and never a model's words about her. Yes: she becomes a tenant and what she wrote meanwhile is replayed as her first turn. No: remembered as declined,
// silent, her held text deleted. No answer for a day: the question lapses, the request stays open until it expires after 7 days (a restart tells the owner's next run as a fact, openRequestsFact; it sends no second card).

export const questionFor = (r: Pick<Request, "aci" | "name" | "number">): string => `Approve ${labelOf(r)} as a friend? They wrote to me; I have not looked at what they wrote. Reply to this message with yes or no, or react 👍 / 👎.`;
const LAPSE_MINUTES = 24 * 60;

export interface Registrar {
  ask(request: Request): void; // put one request to the owner (once at a time per person)
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
    let unsent = false; // a question that could not be sent is no "no": the request stays open
    const send = (text: string) => deps.send(text).catch((e) => ((unsent = true), Promise.reject(e)));
    void request(send, `Approve ${shortId(r)} as a friend`, { tool: "tenant_register", input: { id: shortId(r) } }, undefined, {
      scope: OWNER_KEY,
      source: "chat",
      background: true,
      question: questionFor(r),
      minutes: LAPSE_MINUTES, // it lapses silently (approvals.ts): the request stays open
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
  return { ask };
}

/** The requests still open at a start, as a fact for the owner's next run (core/ownerfact.ts): only their ids and how many, never a name or a word of theirs. The question card was sent once, when the person first wrote, and is not sent again at a restart. undefined: none. */
export function openRequestsFact(): string | undefined {
  const open = openRequests();
  return open.length ? `${open.length} person(s) who wrote to me are still waiting to be let in as friends (ids: ${open.map(shortId).join(", ")}). She can answer a question still open in this chat, or decide on the Mac with npm run tenants -- approve <id> or decline <id>; the requests expire after 7 days.` : undefined;
}
