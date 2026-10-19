import { prepare as prepareWarm, runConversation } from "./agent.ts";
import { tenant } from "./conversationmodel.ts";
import { tenantOverBudget } from "./budget.ts";
import { cooldownUntil } from "./cooldown.ts";
import type { Conversation, RunHooks } from "./conversationmodel.ts";
import type { Picture } from "./image.ts";
import type { Document } from "./document.ts";
import { TenantKeyError } from "./errors.ts";
import { settings } from "./settings.ts";
import { mayNotice, markDisclosed, setPaused, tenantById, tenantContext, wasDisclosed, type TenantContext } from "./tenants.ts";
import { DISCLOSURE, notSetUpReply } from "./tenantroute.ts";

// A tenant's turn, around the run itself (agent.ts runConversation): the gates that need no model, in code, in this order:
//   suspended or deleted since the message arrived -> nothing
//   she is in a cooldown (a limit, no credit, refused) -> a fixed notice until it ends; nobody else is affected (cooldown.ts, per tenant)
//   her day's budget is spent -> a fixed notice until tomorrow
//   the instance key (TENANT_ANTHROPIC_API_KEY) is not set -> a plain "not set up for friends" to her and a notice to the admin; the owner's login is NEVER used instead
// and after the run: the AI disclosure in the first reply she ever gets (a fixed one, or the model's). A fixed notice is sent at most every
// TENANT_NOTICE_MINUTES; in between the turn stays silent ([[silent]]).
// `access` is the same gates for work nobody asked for (the idle look, a wake-up, the dream, quiet compaction): silent, and without the key no run at all.

const SILENT = "[[silent]]";
const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

// What her unattended work (the idle look, a wake-up, the dream, quiet compaction) runs on: the instance key, her cost file, her id.
export interface TenantAccess {
  id: string;
  name: string;
  apiKey: string;
  costFile: string;
  ctx: TenantContext;
}

export interface TenantRunnerDeps {
  apiKey?: () => string | undefined; // the instance key tenants run on (default: settings.tenantApiKey)
  alertAdmin?: (text: string) => void; // a notice for the admin (the owner's chat); at most one per notice interval

  ask?: (ctx: TenantContext, apiKey: string, prompt: string, pictures?: Picture[], hooks?: RunHooks, documents?: Document[]) => Promise<{ text: string; costUsd?: number }>;
  prepare?: (ctx: TenantContext, apiKey: string) => void;
  now?: () => number;
}

export function createTenantRunner(deps: TenantRunnerDeps) {
  const now = deps.now ?? Date.now;
  const instanceKey = deps.apiKey ?? (() => settings.tenantApiKey);
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
    if (!rec || rec.status === "suspended") return { text: SILENT };
    const ctx = tenantContext(rec);
    const until = cooldownUntil(ctx.id, now());
    if (until) return notice(ctx, "cooldown", `I'm paused for a while (a usage limit, a billing problem or a refused request on the account I run on). I'll try again around ${hhmm(until)}.`);
    if (tenantOverBudget(ctx.costFile, ctx.dailyBudgetUsd)) return notice(ctx, "budget", `You've reached your daily limit of ${ctx.dailyBudgetUsd}, so I'm resting until tomorrow.`);
    const apiKey = instanceKey();
    if (!apiKey) {
      if (mayNotice(ctx, "admin-setup", now())) deps.alertAdmin?.(`${ctx.name} (${ctx.id}) wrote to me but TENANT_ANTHROPIC_API_KEY is not set, so I can't answer friends yet. Set it in .env (a separate Console workspace key with a spend limit) and restart.`);
      return notice(ctx, "setup", notSetUpReply());
    }
    let r: Awaited<ReturnType<typeof ask>>;
    try {
      r = await ask(ctx, apiKey, prompt, pictures, hooks, documents);
    } catch (e) {
      if (e instanceof TenantKeyError) setPaused(ctx, cooldownUntil(ctx.id, now())); // for doctor, which is another process
      throw e;
    }
    setPaused(ctx, undefined);
    return { text: disclose(ctx, r.text), costUsd: r.costUsd };
  }

  // After her turn: a warm process for her next message, if the instance key is set (never a reason to fail anything).
  function warm(conv: Conversation): void {
    const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
    if (!rec || rec.status === "suspended") return;
    const ctx = tenantContext(rec);
    if (cooldownUntil(ctx.id, now()) || tenantOverBudget(ctx.costFile, ctx.dailyBudgetUsd)) return;
    const apiKey = instanceKey();
    if (apiKey) prepare(ctx, apiKey);
  }

  // The same gates for work nobody asked for, and silent: suspended, in a cooldown or past her day's budget means nothing runs and she is told nothing;
  // without the instance key nothing runs either and the admin hears of it once (not once per tenant). The owner's login is never a fallback.
  let keyAlertAt = 0;
  function access(id: string | undefined): TenantAccess | undefined {
    const rec = id ? tenantById(id) : undefined;
    if (!rec || rec.status !== "active") return undefined;
    const ctx = tenantContext(rec);
    if (cooldownUntil(ctx.id, now()) || tenantOverBudget(ctx.costFile, ctx.dailyBudgetUsd)) return undefined;
    const apiKey = instanceKey();
    if (!apiKey) {
      if (now() - keyAlertAt >= settings.tenantNoticeMinutes * 60_000) {
        keyAlertAt = now();
        deps.alertAdmin?.("TENANT_ANTHROPIC_API_KEY is not set, so I can't look in on friends' chats or tidy their notes. Set it in .env (a separate Console workspace key with a spend limit) and restart.");
      }
      return undefined;
    }
    return { id: ctx.id, name: ctx.name, apiKey, costFile: ctx.costFile, ctx };
  }

  return { run, warm, access };
}
