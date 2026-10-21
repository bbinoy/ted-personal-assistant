import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { budgetSpent, groupOverBudget, instanceKeyOverBudget, recordSpend, tenantOverBudget } from "../core/budget.ts";
import { convDamage } from "../core/convdb.ts";
import { convIdOf, groupConvId, OWNER_CONV } from "../core/convpaths.ts";
import type { Conversation } from "../conversation/conversationmodel.ts";
import { cooldownUntil, coolingDown, noteSuccess, observeRateLimit, skipForCooldown } from "../core/cooldown.ts";
import { reportKeyProblem } from "./keynotice.ts";
import { reportInstanceCap } from "../core/capnotice.ts";
import { isPaused } from "../core/pause.ts";
import { settings } from "../core/settings.ts";
import { tenantById, tenantContext } from "./tenants.ts";

// WHO PAYS for a model call and MAY IT RUN NOW: one answer for every call, whoever started it (a chat turn, a wake-up, the gate, the dream, the mail check and its
// handler, compaction, a notice, the log summary, the approval judge).
//   login      the instance's own Claude login (the owner's, and the groups'): the instance's day budget (the spend ledger, instance.db) and the shared cooldown of its usage limit
//   instance   the instance key (TENANT_ANTHROPIC_API_KEY), on behalf of a friend: her own spend rows and her own daily ceiling; the key's refusal (a limit, an empty balance,
//              an expired key) is the KEY's, so its cooldown is shared by every friend (INSTANCE_KEY_COOLDOWN) and the owner hears of it once (keynotice.ts)
// A Payer is a value to pass along: it carries the key only into the environment of the call (envFor), never into a log or an audit line.

export interface InstancePayer {
  readonly kind: "instance";
  readonly id: string; // the friend it is spent for: her ledger, her budget
  readonly apiKey: string; // only into the environment of a call (envFor); never logged or audited
  readonly ledger: string;
}
export interface LoginPayer {
  readonly kind: "login";
  readonly group?: string; // a group's run: also counted against that group's own daily ceiling (budget.ts GROUP_DAILY_BUDGET_USD)
}
export type Payer = LoginPayer | InstancePayer;

export const LOGIN: Payer = Object.freeze({ kind: "login" });
export const loginFor = (groupId?: string): Payer => (groupId ? Object.freeze({ kind: "login", group: groupId }) : LOGIN);
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
// One row in the spend ledger (budget.ts) says it all: whose conversation, which payer, what kind of run (chat, look, dream, gate, helper...). A friend's row counts toward her own day and the
// instance key's, a group's toward its own day and the owner's login, the owner's toward the owner's: the sums are the ceilings.
export function charge(p: Payer, usd: number, kind = "run"): void { // failures cost money too
  if (p.kind === "instance") recordSpend({ usd, conv: p.ledger, payer: "key", kind });
  else recordSpend({ usd, conv: p.group ? groupConvId(p.group) : OWNER_CONV, payer: "login", kind });
}
export const succeeded = (p: Payer): void => noteSuccess(cooldownKeyOf(p)); // a call went through: the limit is over
export const cooldownOf = (p: Payer, now: number = Date.now()): number | undefined => cooldownUntil(cooldownKeyOf(p), now);

// ---- may it run now ----

export interface Refusal {
  refused: "paused" | "damaged" | "inactive" | "no-key" | "cooldown" | "budget" | "group-budget" | "instance-budget"; // group-budget: that group's own day is spent; instance-budget: all tenants together have spent the key's day
  until?: number; // cooldown: when it ends (epoch ms)
  limit?: number; // budget, group-budget, instance-budget: the ceiling that is spent
}
export const isRefusal = (x: Payer | Refusal): x is Refusal => "refused" in x;

export interface MayRunOptions {
  chat?: boolean; // somebody wrote and waits (or the next message waits): the owner's and a group's turns are never held back by the shared cooldown or the day budget; a friend's are (her cooldown, her budget, the key), and the pause switch is not asked
  now?: number; // epoch ms (tests)
  key?: () => string | undefined; // where the instance key comes from (default settings.tenantApiKey; tests)
  paused?: (now: Date) => boolean; // default: the pause switch (pause.ts)
  spent?: () => boolean; // the instance's day budget (default budget.ts budgetSpent)
  groupSpent?: (groupId: string) => boolean; // one group's day budget (default budget.ts groupOverBudget)
  keySpent?: () => boolean; // all tenants' day on the instance key (default budget.ts instanceKeyOverBudget)
}

// The one gate for work on a model: who would pay, and may it run now? A conversation is a Payer or a refusal, never half of each.
//   owner, group   login; unattended work stops with the pause switch, the shared cooldown of the usage limit (logged once per episode) and the instance's day budget; a group
//                  also stops, chat or not, at its own day's ceiling (GROUP_DAILY_BUDGET_USD)
//   friend         she must be active (a chat turn: not suspended); the instance key must be set (else the owner hears of it once); the key must not be in a cooldown; her own day's budget must not be spent; nor the instance key's day across all tenants (INSTANCE_KEY_DAILY_USD)
// (a conversation the caller only half names, as some callers and tests do, is not one whose database can be damaged)
const damaged = (conv: Pick<Conversation, "kind" | "tenantId"> & { groupId?: string }): boolean => {
  try {
    return convDamage(convIdOf(conv)) !== undefined;
  } catch {
    return false;
  }
};

export function mayRun(conv: Pick<Conversation, "kind" | "tenantId"> & { groupId?: string }, what: string, o: MayRunOptions = {}): Payer | Refusal {
  const now = o.now ?? Date.now();
  if (!o.chat && (o.paused ?? isPaused)(new Date(now))) return { refused: "paused" };
  if (!o.chat && damaged(conv)) return { refused: "damaged" }; // its assistant.db was damaged and set aside (core/convdb.ts): chat goes on with a fresh start, nothing unattended runs for it until a person looks
  if (conv.kind === "group" && conv.groupId && (o.groupSpent ?? groupOverBudget)(conv.groupId)) return { refused: "group-budget", limit: settings.groupDailyBudgetUsd }; // even a turn that was asked for: a noisy group is how the owner's day goes
  if (conv.kind !== "tenant") {
    if (o.chat) return loginFor(conv.kind === "group" ? conv.groupId : undefined);
    if (skipForCooldown(what, now)) return { refused: "cooldown", until: cooldownUntil("", now) };
    if ((o.spent ?? budgetSpent)()) return { refused: "budget" };
    return loginFor(conv.kind === "group" ? conv.groupId : undefined);
  }
  const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
  if (!rec || (o.chat ? rec.status === "suspended" : rec.status !== "active")) return { refused: "inactive" }; // (a suspended friend gets no answer; nothing unattended runs for her unless she is active)
  const ctx = tenantContext(rec);
  const apiKey = o.key ? o.key() : settings.tenantApiKey;
  if (!apiKey) {
    reportKeyProblem("missing", now);
    return { refused: "no-key" };
  }
  if (coolingDown(now, INSTANCE_KEY_COOLDOWN)) return { refused: "cooldown", until: cooldownUntil(INSTANCE_KEY_COOLDOWN, now) };
  if (tenantOverBudget(ctx.ledger, ctx.dailyBudgetUsd)) return { refused: "budget", limit: ctx.dailyBudgetUsd };
  if ((o.keySpent ?? instanceKeyOverBudget)()) { // the key's whole day, whatever each friend's own ceiling says
    reportInstanceCap(settings.instanceKeyDailyUsd, now); // the owner hears once a day, whichever job ran into it
    return { refused: "instance-budget", limit: settings.instanceKeyDailyUsd };
  }
  return { kind: "instance", id: ctx.id, apiKey, ledger: ctx.ledger };
}
