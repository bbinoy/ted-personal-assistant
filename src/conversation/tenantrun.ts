import { runConversation } from "../run/agent.ts";
import { chatTurn } from "../run/chattail.ts";
import { timeIn } from "../core/timezone.ts";
import { tenant } from "./conversationmodel.ts";
import type { Conversation, RunHooks } from "./conversationmodel.ts";
import type { Picture } from "../run/image.ts";
import type { Document } from "./document.ts";
import { InstanceKeyError, refusalOnce, type Reason } from "../tenants/errors.ts";
import { cooldownOf, isRefusal, mayRun } from "../tenants/payer.ts";
import { markDisclosed, setPaused, tenantById, tenantContext, type TenantContext } from "../tenants/tenants.ts";

// A tenant's turn, around the run itself (agent.ts runConversation): the gates that need no model, in code (payer.ts mayRun, the same for every unattended job too):
//   suspended or deleted since the message arrived -> nothing
//   the instance key (TENANT_ANTHROPIC_API_KEY) is not set -> a plain "not set up for friends" to her and a notice to the admin; the owner's login is NEVER used instead
//   the key is in a cooldown (a limit, no credit, refused) -> a fixed notice until it ends; it is the KEY's cooldown, so it holds for every friend (cooldown.ts)
//   her day's budget is spent -> a fixed notice until tomorrow (her own ledger, her own ceiling)
//   the instance key is refused (expired, over its limit, out of credit) -> her run fails as before, and the owner's chat hears of it once (keynotice.ts, called from errors.ts failure for every kind of run)
// and after the run: her first reply is marked (the model greets her once, in its own voice: persona.ts FIRST_CONTACT). A fixed notice is sent at most every
// 30 minutes (tenants.ts mayNotice); in between the turn stays silent ([[silent]]).

const SILENT = "[[silent]]";

export interface TenantRunnerDeps {
  apiKey?: () => string | undefined; // the instance key tenants run on (default: settings.tenantApiKey)
  ask?: (ctx: TenantContext, apiKey: string, prompt: string, pictures?: Picture[], hooks?: RunHooks, documents?: Document[]) => Promise<{ text: string; costUsd?: number }>;
  now?: () => number;
}

export function createTenantRunner(deps: TenantRunnerDeps) {
  const now = deps.now ?? Date.now;
  const may = (conv: Conversation, what: string) => mayRun(conv, what, { chat: true, now: now(), key: deps.apiKey }); // she wrote: no pause switch; her cooldown, budget and the key
  // Her turn is a conversation turn like any other (agent.ts): her record decides the options, the instance key is the one thing she brings.
  const ask = deps.ask ?? ((ctx: TenantContext, apiKey: string, prompt: string, pictures?: Picture[], hooks?: RunHooks, documents?: Document[]) => runConversation(tenant(ctx.id), { apiKey }, chatTurn(tenant(ctx.id), { prompt, pictures, documents }), hooks?.firstOutput));

  // (the one refusal table and the one throttle, tenants/errors.ts: a ceiling is said once a day, a cooldown or a missing key every 30 minutes)
  const refuse = (ctx: TenantContext, reason: Reason, o: { until?: string; limit?: number } = {}) => ({ text: refusalOnce(reason, "friend", ctx.convId, o, now()) ?? SILENT });

  async function run(conv: Conversation, prompt: string, pictures?: Picture[], hooks?: RunHooks, documents?: Document[]): Promise<{ text: string; costUsd?: number }> {
    const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
    if (!rec) return { text: SILENT };
    const ctx = tenantContext(rec);
    const payer = may(conv, "chat");
    if (isRefusal(payer)) {
      if (payer.refused === "cooldown") return refuse(ctx, "cooldown", { until: timeIn(new Date(payer.until!)) });
      if (payer.refused === "instance-budget") return refuse(ctx, "shared-budget"); // all friends' shared day is spent: the owner heard of it in mayRun
      if (payer.refused === "no-key") return refuse(ctx, "no-key"); // (the admin heard of it in mayRun)
      return { text: SILENT }; // suspended or removed
    }
    if (payer.kind !== "instance") return { text: SILENT };
    let r: Awaited<ReturnType<typeof ask>>;
    try {
      r = await ask(ctx, payer.apiKey, prompt, pictures, hooks, documents);
    } catch (e) {
      if (e instanceof InstanceKeyError) setPaused(ctx, cooldownOf(payer, now())); // for doctor, which is another process (the owner's notice is made where the failure is, errors.ts)
      throw e;
    }
    setPaused(ctx, undefined);
    markDisclosed(ctx); // (her first turn has been answered: the first-contact hint is not given again)
    return { text: r.text, costUsd: r.costUsd };
  }

  return { run };
}
