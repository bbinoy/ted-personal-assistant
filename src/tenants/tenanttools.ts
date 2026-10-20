import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { audit } from "../audit.ts";
import { spentToday } from "../budget.ts";
import { cooldownUntil } from "../cooldown.ts";
import { INSTANCE_KEY_COOLDOWN, tenantEnv } from "../payer.ts";
import { connectionSummary } from "./connections.ts";
import { deleteTenant, mintInvite, OWNER_ID, people, readConsent, recordConsent, setStatus, tenantById, tenantContext, TENANT_CONSENT_TOOL, type TenantContext } from "./tenants.ts";
import { TENANT_ID } from "../secrets/secrets.ts";
import { settings } from "../settings.ts";

// Two small in-process MCP servers (like memory-tools.ts):
//   tenant   in a tenant's run: record_consent, her one-time confirmation of age and region (the only tool she has until it is made)
//   tenants  in the owner's chat, only with TENANTS=on: mint an invite code, list tenants, suspend, resume, delete (the last two ask on the phone, toolmanifest.ts)
// Scope is closed over, never a parameter: record_consent can only write the consent of the tenant whose run it is in.

const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

// What a tenant's run is made of, beyond the options of any run (agentrun.ts RunOptions.tenant).
export interface TenantRun {
  id: string;
  key: string; // her conversation's key ("tenant:<id>"): where send, voice and the browse questions go
  apiKey: string; // the instance key (TENANT_ANTHROPIC_API_KEY): only into the environment of this run (payer.ts envFor), nowhere else, never logged or audited
  keyTag: string; // a short fingerprint of that key, so a warm process built on an old key is not reused after it changed
  costFile: string;
  logFile: string; // her history: what search_logs reads
  consentFile: string;
  consented: boolean;
  overBudget: () => boolean; // her own ledger against her own ceiling (the browse run asks)
}

export { tenantEnv }; // (payer.ts: the environment of a call on the instance key)

export function createTenantServer(t: Pick<TenantRun, "id" | "consentFile">) {
  return createSdkMcpServer({
    name: "tenant",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        TENANT_CONSENT_TOOL.split("__")[2]!,
        "Record that this person has confirmed she is 18 or older and where she lives. Call it once, only after she has told you both in her own words. If she said she is under 18, do not call it.",
        { ageConfirmed: z.literal(true).describe("She said she is 18 or older"), region: z.string().min(2).max(100).describe("The country or region she said she lives in") },
        async ({ region }) => {
          const ctx = { id: t.id, consentFile: t.consentFile };
          if (readConsent(ctx)) return reply("Already recorded.");
          recordConsent(ctx, region);
          audit("tenant_consent", "recorded", "group", { tenant: t.id });
          return reply("Recorded. Carry on: you can help her now.");
        },
        { alwaysLoad: true },
      ),
    ],
  });
}

// ---- the owner's side ----

// Set by main.ts (a hook, so this file does not import the agent): stops what is in flight for a tenant who was suspended or deleted.
export const tenantHooks: { drop?: (id: string) => void } = {};

export interface AdminDeps {
  drop?: (id: string) => void; // stop anything in flight for her (warm process, queue state)
}

const when = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

// One line per person: id, name, role, status, capabilities, which of her own accounts (Google, Notion) are connected (never a token), consent and today's spend.
// Everybody, the owner first (it is also what `npm run tenants -- list` shows).
export function describeTenants(): string[] {
  const lines: string[] = [];
  for (const rec of people()) {
    if (rec.id === OWNER_ID) {
      lines.push(`${rec.id} (${rec.name}): ${rec.role}; capabilities ${rec.capabilities.join(", ") || "none"}`);
      continue;
    }
    const ctx = tenantContext(rec);
    const c = cooldownUntil(INSTANCE_KEY_COOLDOWN); // (the key is cooling down: for every friend alike)
    const connections = connectionSummary(rec);
    lines.push(`${rec.id} (${rec.name}): ${rec.role}, ${rec.status}; capabilities ${rec.capabilities.join(", ") || "none"}${connections ? `; connections: ${connections}` : ""}; consent ${readConsent(ctx) ? "given" : "not yet"}; today ${spentToday(ctx.costFile).toFixed(2)} of ${ctx.dailyBudgetUsd}${c ? `; paused until ${when(c)}` : ""}`);
  }
  return lines;
}

export function createTenantAdminServer(deps: AdminDeps = {}) {
  const idArg = { id: z.string().regex(TENANT_ID).describe("The tenant's id, as list_tenants shows it") };
  const found = (id: string) => tenantById(id);
  return createSdkMcpServer({
    name: "tenants",
    version: "1.0.0",
    tools: [
      tool(
        "create_invite",
        `Mint a single-use invite code for a friend of ${settings.owner}. It is valid for ${settings.inviteTtlHours} hours and works once. Tell ${settings.owner} the code in your reply, and that the friend sends it to ${settings.assistant} in a private Signal message (${settings.assistant} never writes first to anybody). `,
        { note: z.string().max(100).optional().describe("Who it is for, for the owner's own reference (like: for Anna)") },
        async ({ note }) => {
          const made = mintInvite(note);
          audit("tenant_invite", made ? "minted" : "refused", "chat");
          return made ? reply(`Invite code: ${made.code} (single use, valid until ${new Date(made.expiresAt).toLocaleString()}).`) : reply("Too many invite codes are open already; wait for some to expire or be used.", true);
        },
      ),
      tool("list_tenants", "List the tenants (friends who use this assistant): id, name, role, status, capabilities, whether her Google or Notion is connected, whether her consent is in place, what she spent today against her own limit, and any pause. Never shows a key or anything she said.", {}, async () => {
        const lines = describeTenants();
        return reply(lines.length ? lines.join("\n") : "No tenants yet.");
      }),
      tool(
        "suspend_tenant",
        "Suspend a tenant: she gets no answers at all from now on, her data stays. (Asks the owner's approval first.)",
        idArg,
        async ({ id }) => {
          if (!found(id)) return reply("No such tenant.", true);
          setStatus(id, "suspended");
          (deps.drop ?? tenantHooks.drop)?.(id);
          audit("tenant_status", "suspended", "chat", { tenant: id });
          return reply(`${id} is suspended.`);
        },
      ),
      tool("resume_tenant", "Let a suspended tenant talk to the assistant again.", idArg, async ({ id }) => {
        const rec = found(id);
        if (!rec) return reply("No such tenant.", true);
        setStatus(id, readConsent(tenantContext(rec)) ? "active" : "invited");
        audit("tenant_status", "resumed", "chat", { tenant: id });
        return reply(`${id} can talk to me again.`);
      }),
      tool(
        "remove_tenant",
        "Delete a tenant AND her data for good: her notes, her chat history, and her session. Cannot be undone. (Asks the owner's approval first.)",
        { ...idArg, confirm: z.literal(true).describe("Always true: the owner's approval is what actually decides") },
        async ({ id }) => {
          if (!found(id)) return reply("No such tenant.", true);
          deleteTenant(id, { drop: deps.drop ?? tenantHooks.drop });
          audit("tenant_status", "deleted", "chat", { tenant: id });
          return reply(`Deleted ${id} and her data.`);
        },
      ),
    ],
  });
}

export type { TenantContext };
