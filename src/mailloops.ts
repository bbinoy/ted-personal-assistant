import { query } from "@anthropic-ai/claude-agent-sdk";
import { runTenantHandlerTurn } from "./agent.ts";
import { audit } from "./audit.ts";
import { tenantOverBudget } from "./budget.ts";
import { tenant as tenantConversation } from "./conversation.ts";
import { allows } from "./capabilities.ts";
import { noteRateLimit } from "./cooldown.ts";
import { GoogleMail } from "./googlemail.ts";
import { googleHub } from "./googlemcp.ts";
import { createHandler, type HandlerContext } from "./handler.ts";
import { createMailCheck, type MailContext, type MailSource } from "./heartbeat.ts";
import { readDone } from "./intakelinks.ts";
import { googleHandlerTask } from "./modules/google.ts";
import { approveIn, type Approve } from "./permissions.ts";
import { tenantKey } from "./send.ts";
import { settings } from "./settings.ts";
import { listTenants, tenantContext, tenantById } from "./tenants.ts";
import { mailFiles, recordTriage } from "./tenantmail.ts";
import type { TenantAccess } from "./tenantrun.ts";
import { triageBatch } from "./triage.ts";

// The mail check, the triage and the handler for every FRIEND who has mail through her own Google, run on the heartbeat's tick like the owner's. This file is only the
// loop over conversations and what is hers to plug in; the check itself is heartbeat.ts createMailCheck, the handler is handler.ts createHandler, the classification is
// triage.ts: the same code the owner's mail runs, with a MailContext and a HandlerContext made from her record.
//   who      an active friend with the capabilities heartbeat, mail and google (conversationmodel.ts allows), the instance's Google client set up, and a connected account
//   state    her folder (tenants/<id>/mail/: seen mail, last tick, the handler's queue, what was decided), never state/
//   mailbox  her own Google server, read with no model call (googlemail.ts); nothing new, nothing spent
//   model    the small model on the instance key, billed to her cost file, stopped by her cooldown and her day's budget (tenantrun.ts access), with her notes
//   handler  drafts only: a send or an invitation asks HER in her chat (the approver is her conversation's), judged against the standing task
//   notices  her chat and nobody else's; a friend's failure is logged and stops with her; it never reaches another friend or the owner
// Push (Gmail Pub/Sub, calendar webhooks) is not built: polling is cheap here because the look is a search, not a model call.

export interface TenantMailDeps {
  access: (id: string) => TenantAccess | undefined; // tenantrun.ts: suspended, cooling down, over her budget or no instance key: nothing runs
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
  const eligible = (id: string): TenantAccess | undefined => {
    if (!settings.tenants) return undefined;
    const who = { kind: "tenant", tenantId: id } as const;
    if (!allows(who, "heartbeat") || !allows(who, "mail")) return undefined; // (mail of a friend means her own Google with the instance's OAuth client set up: capabilities.ts)
    if (!readDone(id, "google")) return undefined; // she has not connected: there is no mailbox to look at
    return deps.access(id);
  };

  function build(id: string): Loop {
    const rec = tenantById(id)!;
    const ctx = tenantContext(rec);
    const files = mailFiles(ctx);
    const source = deps.source?.(id) ?? new GoogleMail(googleHub.session(id));
    const approve = deps.approve?.(id) ?? approveIn(tenantKey(id), { background: true });
    const hctx: HandlerContext = {
      queue: files.queue,
      who: ctx.name,
      task: () => googleHandlerTask(ctx.name),
      run: deps.handlerRun?.(id) ?? ((prompt, ap, onToolSuccess, task) => {
        const access = deps.access(id);
        if (!access) throw new Error("not available now"); // (cooldown, budget or key changed since the batch was queued)
        return runTenantHandlerTurn(tenantConversation(id), access, prompt, ap, onToolSuccess, task);
      }),
      over: () => tenantOverBudget(ctx.costFile, ctx.dailyBudgetUsd),
      tag: { tenant: id },
    };
    const handler = createHandler({ approve, notify: (text) => deps.notify(id, text), ctx: hctx });
    const mctx: MailContext = {
      files,
      triage:
        deps.triage?.(id) ??
        ((mails) => {
          const a = deps.access(id);
          if (!a) throw new Error("not available now");
          return triageBatch(mails, query, { who: { name: a.name, pronoun: "them" }, notesDir: a.ctx.notesDir, tenant: { id, apiKey: a.apiKey, costFile: a.costFile } });
        }),
      record: (decision, row) => recordTriage(ctx, decision, row),
      archiveLogOnly: () => !settings.google.archiveLive,
      handler: () => true,
      skipForCooldown: () => !deps.access(id), // her cooldown, day's budget, suspension or a missing key: no model call (hers alone)
      onRateLimit: () => noteRateLimit(Date.now(), id),
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
