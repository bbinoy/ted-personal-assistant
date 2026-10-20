import { prepare as prepareWarm, runConversation } from "../run/agent.ts";
import { tenant } from "./conversationmodel.ts";
import type { Conversation, RunHooks } from "./conversationmodel.ts";
import type { Picture } from "../run/image.ts";
import type { Document } from "./document.ts";
import { InstanceKeyError } from "../tenants/errors.ts";
import { cooldownOf, isRefusal, mayRun } from "../tenants/payer.ts";
import { mayNotice, markDisclosed, setPaused, tenantById, tenantContext, wasDisclosed, type TenantContext } from "../tenants/tenants.ts";
import { DISCLOSURE, notSetUpReply } from "../tenants/tenantroute.ts";

// A tenant's turn, around the run itself (agent.ts runConversation): the gates that need no model, in code (payer.ts mayRun, the same for every unattended job too):
//   suspended or deleted since the message arrived -> nothing
//   the instance key (TENANT_ANTHROPIC_API_KEY) is not set -> a plain "not set up for friends" to her and a notice to the admin; the owner's login is NEVER used instead
//   the key is in a cooldown (a limit, no credit, refused) -> a fixed notice until it ends; it is the KEY's cooldown, so it holds for every friend (cooldown.ts)
//   her day's budget is spent -> a fixed notice until tomorrow (her own ledger, her own ceiling)
//   the instance key is refused (expired, over its limit, out of credit) -> her run fails as before, and the owner's chat hears of it once (keynotice.ts, called from errors.ts failure for every kind of run)
// and after the run: the AI disclosure in the first reply she ever gets (a fixed one, or the model's). A fixed notice is sent at most every
// TENANT_NOTICE_MINUTES; in between the turn stays silent ([[silent]]).

const SILENT = "[[silent]]";
const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

export interface TenantRunnerDeps {
  apiKey?: () => string | undefined; // the instance key tenants run on (default: settings.tenantApiKey)
  ask?: (ctx: TenantContext, apiKey: string, prompt: string, pictures?: Picture[], hooks?: RunHooks, documents?: Document[]) => Promise<{ text: string; costUsd?: number }>;
  prepare?: (ctx: TenantContext, apiKey: string) => void;
  now?: () => number;
}

export function createTenantRunner(deps: TenantRunnerDeps) {
  const now = deps.now ?? Date.now;
  const may = (conv: Conversation, what: string) => mayRun(conv, what, { chat: true, now: now(), key: deps.apiKey }); // she wrote: no pause switch; her cooldown, budget and the key
  // Her turn is a conversation turn like any other (agent.ts): her record decides the options, the instance key is the one thing she brings.
  const ask = deps.ask ?? ((ctx: TenantContext, apiKey: string, prompt: string, pictures?: Picture[], hooks?: RunHooks, documents?: Document[]) => runConversation(tenant(ctx.id), { apiKey }, () => ({ prompt, pictures, documents }), hooks?.firstOutput));
  const prepare = deps.prepare ?? ((ctx: TenantContext, apiKey: string) => prepareWarm(tenant(ctx.id), { apiKey }));

  // The first thing she is ever told starts with the disclosure, whoever wrote it.
  function disclose(ctx: TenantContext, text: string): string {
    if (wasDisclosed(ctx)) return text;
    markDisclosed(ctx);
    const body = text.trim() === SILENT ? "" : text;
    return body.startsWith(DISCLOSURE) ? body : `${DISCLOSURE}${body ? `\n\n${body}` : ""}`;
  }
  const notice = (ctx: TenantContext, kind: string, text: string) => ({ text: mayNotice(ctx, kind, now()) ? disclose(ctx, text) : SILENT });

  async function run(conv: Conversation, prompt: string, pictures?: Picture[], hooks?: RunHooks, documents?: Document[]): Promise<{ text: string; costUsd?: number }> {
    const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
    if (!rec) return { text: SILENT };
    const ctx = tenantContext(rec);
    const payer = may(conv, "chat");
    if (isRefusal(payer)) {
      if (payer.refused === "cooldown") return notice(ctx, "cooldown", `I'm paused for a while (a usage limit, a billing problem or a refused request on the account I run on). I'll try again around ${hhmm(payer.until!)}.`);
      if (payer.refused === "budget") return notice(ctx, "budget", `You've reached your daily limit of ${ctx.dailyBudgetUsd}, so I'm resting until tomorrow.`);
      if (payer.refused === "no-key") return notice(ctx, "setup", notSetUpReply()); // (the admin heard of it in mayRun)
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
    return { text: disclose(ctx, r.text), costUsd: r.costUsd };
  }

  // After her turn: a warm process for her next message, if she may run and the instance key is set (never a reason to fail anything).
  function warm(conv: Conversation): void {
    const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
    const payer = rec ? may(conv, "warm") : undefined;
    if (rec && payer && !isRefusal(payer) && payer.kind === "instance") prepare(tenantContext(rec), payer.apiKey);
  }

  return { run, warm };
}
