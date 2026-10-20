import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { budgetSpent, recordCost, tenantOverBudget } from "./budget.ts";
import type { Conversation } from "./conversationmodel.ts";
import { cooldownUntil, coolingDown, noteSuccess, observeRateLimit, skipForCooldown } from "./cooldown.ts";
import { reportKeyProblem } from "./tenants/keynotice.ts";
import { isPaused } from "./pause.ts";
import { settings } from "./settings.ts";
import { tenantById, tenantContext } from "./tenants/tenants.ts";

// WHO PAYS for a model call and MAY IT RUN NOW: one answer for every call, whoever started it (a chat turn, a wake-up, the gate, the dream, the mail check and its
// handler, compaction, a notice, the log summary, the approval judge).
//   login      the instance's own Claude login (the owner's, and the groups'): the instance's day budget (state/cost.json) and the shared cooldown of its usage limit
//   instance   the instance key (TENANT_ANTHROPIC_API_KEY), on behalf of a friend: her own cost file and her own daily ceiling; the key's refusal (a limit, an empty balance,
//              an expired key) is the KEY's, so its cooldown is shared by every friend (INSTANCE_KEY_COOLDOWN) and the owner hears of it once (keynotice.ts)
// A Payer is a value to pass along: it carries the key only into the environment of the call (envFor), never into a log or an audit line.

export interface InstancePayer {
  readonly kind: "instance";
  readonly id: string; // the friend it is spent for: her ledger, her budget
  readonly apiKey: string; // only into the environment of a call (envFor); never logged or audited
  readonly costFile: string;
}
export type Payer = { readonly kind: "login" } | InstancePayer;

export const LOGIN: Payer = Object.freeze({ kind: "login" });
export const INSTANCE_KEY_COOLDOWN = "instance-key";

// The cooldown state a payer's refusals feed and its calls read: the login's own, or the shared key's.
export const cooldownKeyOf = (p: Payer): string => (p.kind === "login" ? "" : INSTANCE_KEY_COOLDOWN);

// The environment of a call: the process's for the login; for the instance key, minus every way of authenticating as the owner, plus the key (as ANTHROPIC_API_KEY, in this env only).
const OWN_LOGIN = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_API_KEY_HELPER"];
export function tenantEnv(base: Record<string, string | undefined>, apiKey: string): Record<string, string | undefined> {
  if (!apiKey) throw new Error("a tenant's run needs the instance API key"); // never a quiet fall back to the owner's login
  const env = { ...base };
  for (const k of OWN_LOGIN) delete env[k];
  env.ANTHROPIC_API_KEY = apiKey;
  return env;
}
export const envFor = (p: Payer, base: Record<string, string | undefined>): Record<string, string | undefined> => (p.kind === "instance" ? tenantEnv(base, p.apiKey) : base);

// ---- the bookkeeping of a call, the same for every payer ----

export const observe = (p: Payer, m: SDKMessage | { type: string }): void => observeRateLimit(m as SDKMessage, cooldownKeyOf(p)); // a rejected limit's reset time
export const charge = (p: Payer, usd: number): void => recordCost(usd, p.kind === "instance" ? p.costFile : undefined); // failures cost money too
export const succeeded = (p: Payer): void => noteSuccess(cooldownKeyOf(p)); // a call went through: the limit is over
export const cooldownOf = (p: Payer, now: number = Date.now()): number | undefined => cooldownUntil(cooldownKeyOf(p), now);

// ---- may it run now ----

export interface Refusal {
  refused: "paused" | "inactive" | "no-key" | "cooldown" | "budget";
  until?: number; // cooldown: when it ends (epoch ms)
  limit?: number; // budget: the ceiling that is spent
}
export const isRefusal = (x: Payer | Refusal): x is Refusal => "refused" in x;

export interface MayRunOptions {
  chat?: boolean; // somebody wrote and waits (or the next message waits): the owner's and a group's turns are never held back by the shared cooldown or the day budget; a friend's are (her cooldown, her budget, the key), and the pause switch is not asked
  now?: number; // epoch ms (tests)
  key?: () => string | undefined; // where the instance key comes from (default settings.tenantApiKey; tests)
  paused?: (now: Date) => boolean; // default: the pause switch (pause.ts)
  spent?: () => boolean; // the instance's day budget (default budget.ts budgetSpent)
}

// The one gate for work on a model: who would pay, and may it run now? A conversation is a Payer or a refusal, never half of each.
//   owner, group   login; unattended work stops with the pause switch, the shared cooldown of the usage limit (logged once per episode) and the instance's day budget
//   friend         she must be active (a chat turn: not suspended); the instance key must be set (else the owner hears of it once); the key must not be in a cooldown; her own day's budget must not be spent
export function mayRun(conv: Pick<Conversation, "kind" | "tenantId">, what: string, o: MayRunOptions = {}): Payer | Refusal {
  const now = o.now ?? Date.now();
  if (!o.chat && (o.paused ?? isPaused)(new Date(now))) return { refused: "paused" };
  if (conv.kind !== "tenant") {
    if (o.chat) return LOGIN;
    if (skipForCooldown(what, now)) return { refused: "cooldown", until: cooldownUntil("", now) };
    if ((o.spent ?? budgetSpent)()) return { refused: "budget" };
    return LOGIN;
  }
  const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
  if (!rec || (o.chat ? rec.status === "suspended" : rec.status !== "active")) return { refused: "inactive" }; // (an invited friend answers her consent in a chat turn; nothing unattended runs for her until she is active)
  const ctx = tenantContext(rec);
  const apiKey = o.key ? o.key() : settings.tenantApiKey;
  if (!apiKey) {
    reportKeyProblem("missing", now);
    return { refused: "no-key" };
  }
  if (coolingDown(now, INSTANCE_KEY_COOLDOWN)) return { refused: "cooldown", until: cooldownUntil(INSTANCE_KEY_COOLDOWN, now) };
  if (tenantOverBudget(ctx.costFile, ctx.dailyBudgetUsd)) return { refused: "budget", limit: ctx.dailyBudgetUsd };
  return { kind: "instance", id: ctx.id, apiKey, costFile: ctx.costFile };
}
