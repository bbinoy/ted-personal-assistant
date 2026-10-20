import { query } from "@anthropic-ai/claude-agent-sdk";
import { runHandlerTurn } from "./agent.ts";
import { mailHandlerOf } from "./mailhandler.ts";
import { audit } from "./audit.ts";
import { tenant as tenantConversation } from "./conversation.ts";
import { allows } from "./policy/capabilities.ts";
import { GoogleMail } from "./googlemail.ts";
import { googleHub } from "./modules/google/googlemcp.ts";
import { createHandler, handlerTask, type HandlerContext } from "./handler.ts";
import { createMailCheck, type MailContext, type MailSource } from "./heartbeat.ts";
import { readDone } from "./intake/intakelinks.ts";
import { isRefusal, mayRun } from "./payer.ts";
import { approveIn, type Approve } from "./approvals/permissions.ts";
import { tenantKey } from "./ownerkey.ts";
import { settings } from "./settings.ts";
import { listTenants, tenantContext, tenantById } from "./tenants/tenants.ts";
import { mailFiles, recordTriage } from "./tenantmail.ts";
import { triageBatch } from "./triage.ts";

// The mail check, the triage and the handler for every FRIEND who has mail through her own Google, run on the heartbeat's tick like the owner's. This file is only the
// loop over conversations and what is hers to plug in; the check itself is heartbeat.ts createMailCheck, the handler is handler.ts createHandler, the classification is
// triage.ts: the same code the owner's mail runs, with a MailContext and a HandlerContext made from her record.
//   who      an active friend with the capabilities heartbeat, mail and google (conversationmodel.ts allows), the instance's Google client set up, and a connected account
//   state    her folder (tenants/<id>/mail/: seen mail, last tick, the handler's queue, what was decided), never state/
//   mailbox  her own Google server, read with no model call (googlemail.ts); nothing new, nothing spent
//   model    the small model on the instance key, billed to her cost file, stopped by the key's cooldown and her day's budget (payer.ts mayRun), with her notes
//   handler  drafts only: a send or an invitation asks HER in her chat (the approver is her conversation's), judged against the standing task
//   notices  her chat and nobody else's; a friend's failure is logged and stops with her; it never reaches another friend or the owner
// Push (Gmail Pub/Sub, calendar webhooks) is not built: polling is cheap here because the look is a search, not a model call.

export interface TenantMailDeps {
  key?: () => string | undefined; // where the instance key comes from (default settings.tenantApiKey; tests). Suspended, cooling down, over her budget or no key: nothing runs (payer.ts mayRun)
  notify: (id: string, text: string) => Promise<void>; // a plain message in HER chat
  approve?: (id: string) => Approve; // where the handler's questions go (default: her conversation, as a background run)
  ids?: () => string[]; // the people to look at (default: the registry's tenants)
  source?: (id: string) => MailSource; // her mailbox (default: her Google server)
  triage?: (id: string) => MailContext["triage"]; // tests: a fake small model
  handlerRun?: (id: string) => HandlerContext["run"]; // tests: a fake handler run
}

interface Loop {
  check: () => Promise<void>;
  handler: ReturnType<typeof createHandler>;
}

export function createTenantMailLoops(deps: TenantMailDeps) {
  const loops = new Map<string, Loop>();

  // May she have a mail check now? Her record (active, with the capabilities), the instance's Google client, and her connection (the intake page's record).
  const who = (id: string) => ({ kind: "tenant", tenantId: id }) as const;
  const eligible = (id: string): boolean => {
    if (!settings.tenants) return false;
    if (!allows(who(id), "heartbeat") || !allows(who(id), "mail")) return false; // (mail of a friend means her own Google with the instance's OAuth client set up: capabilities.ts)
    return !!readDone(id, "google"); // she has not connected: there is no mailbox to look at
  };
  // The Payer for one model call of hers (mail triage, the handler): a refusal means nothing runs now.
  const payer = (id: string, what: string) => mayRun(who(id), what, { key: deps.key });

  function build(id: string): Loop {
    const rec = tenantById(id)!;
    const ctx = tenantContext(rec);
    const files = mailFiles(ctx);
    const source = deps.source?.(id) ?? new GoogleMail(googleHub.session(id));
    const approve = deps.approve?.(id) ?? approveIn(tenantKey(id), { background: true });
    const hctx: HandlerContext = {
      queue: files.queue,
      who: ctx.name,
      task: () => handlerTask(ctx.name, who(id)),
      run: deps.handlerRun?.(id) ?? ((prompt, ap, onToolSuccess, task) => {
        const p = payer(id, "mail handler");
        if (isRefusal(p) || p.kind !== "instance") throw new Error("not available now"); // (cooldown, budget or key changed since the batch was queued)
        return runHandlerTurn(tenantConversation(id), p, prompt, ap, onToolSuccess, task);
      }),
      over: () => isRefusal(payer(id, "mail handler")), // the key in a cooldown, her day spent, no key: the queue waits
      tag: { tenant: id },
    };
    const handler = createHandler({ approve, notify: (text) => deps.notify(id, text), ctx: hctx });
    const mctx: MailContext = {
      files,
      triage:
        deps.triage?.(id) ??
        ((mails) => {
          const p = payer(id, "mail triage");
          if (isRefusal(p)) throw new Error("not available now");
          return triageBatch(mails, query, { who: { name: ctx.name }, notesDir: ctx.notesDir, payer: p });
        }),
      record: (decision, row) => recordTriage(ctx, decision, row),
      handler: () => !!mailHandlerOf(who(id)), // her mail module can draft
      blocked: (what) => isRefusal(payer(id, what)), // the key's cooldown, her day's budget, suspension or a missing key: no model call
      tidyOwnBriefs: false,
    };
    const check = createMailCheck(source, mctx, { alert: (text) => deps.notify(id, text), handle: (items) => handler.enqueue(items), briefDue: () => false });
    handler.resume(); // anything queued before a restart
    return { check, handler };
  }

  // One tick: every eligible friend, each on her own. A friend whose check throws (it should not: createMailCheck catches) is logged and the others go on.
  async function tick(): Promise<void> {
    const ids = deps.ids?.() ?? listTenants().filter((r) => r.status === "active").map((r) => r.id);
    for (const id of [...loops.keys()]) if (!ids.includes(id)) loops.delete(id); // removed or suspended since
    await Promise.allSettled(
      ids.map(async (id) => {
        try {
          if (!eligible(id)) return;
          const loop = loops.get(id) ?? (loops.set(id, build(id)), loops.get(id)!);
          await loop.check();
        } catch (e) {
          console.error(`mail check (${id}): failed:`, (e as Error).message);
          audit("tenant_mail_check", "failed", "heartbeat", { tenant: id });
        }
      }),
    );
  }

  // Resolves when no friend's handler is working on a batch (tests).
  const idle = async (): Promise<void> => void (await Promise.all([...loops.values()].map((l) => l.handler.idle())));
  return { tick, idle, loops: () => [...loops.keys()] };
}
