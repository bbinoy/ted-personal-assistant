import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { emitRecord } from "../core/events.ts";
import { spentToday } from "../core/budget.ts";
import { cooldownUntil } from "../core/cooldown.ts";
import { INSTANCE_KEY_COOLDOWN, tenantEnv } from "./payer.ts";
import { connectionSummary } from "./connections.ts";
import { capabilitiesOfRecord } from "./capabilityset.ts";
import { invitePerson } from "./registration.ts";
import { OWNER_ID, people, setStatus, tenantById, tenantContext } from "./tenants.ts";
import { appBao, deleteTenantItems, TENANT_ID } from "../secrets/secrets.ts";
import { removeTenant, type RemovalDeps } from "./removal.ts";

// The tenant administration: a small in-process MCP server (like memory-tools.ts) in the owner's chat, only with TENANTS=on: list tenants, suspend, resume, delete
// (the last two ask on the phone, toolmanifest.ts).

const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

// What a tenant's run is made of, beyond the options of any run (agentrun.ts RunOptions.tenant).
export interface TenantRun {
  id: string;
  key: string; // her conversation's key ("tenant:<id>"): where send, voice and the browse questions go
  apiKey: string; // the instance key (TENANT_ANTHROPIC_API_KEY): only into the environment of this run (payer.ts envFor), nowhere else, never logged or audited
  keyTag: string; // a short fingerprint of that key, so a warm process built on an old key is not reused after it changed
  ledger: string;
  logFile: string; // her history: what search_logs reads
}

export { tenantEnv }; // (payer.ts: the environment of a call on the instance key)

// ---- the owner's side ----

// Set by main.ts (a hook, so this file does not import the agent): stops what is in flight for a tenant who was suspended or deleted.
export const tenantHooks: { drop?: (id: string) => void; remove?: (id: string, d: RemovalDeps) => ReturnType<typeof removeTenant>; sendFirst?: (recipient: string, text: string) => Promise<{ timestamp: number; accountId?: string }> } = {};

export interface AdminDeps {
  drop?: (id: string) => void; // stop anything in flight for her (warm process, queue state)
  sendFirst?: (recipient: string, text: string) => Promise<{ timestamp: number; accountId?: string }>; // the messenger's first message to somebody (undefined: the platform has none)
  remove?: typeof tenantHooks.remove; // removal with the pieces of the upper layers wired (conversation/tenantremoval.ts); default: tenantHooks.remove, else the plain one
  secrets?: RemovalDeps["secrets"]; // how her secret-store items are deleted when she is removed (default: the app's token; tests)
}

const when = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

// One line per person: id, name, role, status, capabilities, which of her own accounts (Google, Notion) are connected (never a token) and today's spend.
// Everybody, the owner first (it is also what `npm run tenants -- list` shows).
export function describeTenants(): string[] {
  const lines: string[] = [];
  for (const rec of people()) {
    if (rec.id === OWNER_ID) {
      lines.push(`${rec.id} (${rec.name}): ${rec.role}; capabilities ${[...capabilitiesOfRecord(rec)].join(", ") || "none"}`);
      continue;
    }
    const ctx = tenantContext(rec);
    const c = cooldownUntil(INSTANCE_KEY_COOLDOWN); // (the key is cooling down: for every friend alike)
    const connections = connectionSummary(rec);
    lines.push(`${rec.id} (${rec.name}): ${rec.role}, ${rec.status}; capabilities ${[...capabilitiesOfRecord(rec)].join(", ") || "none"}${connections ? `; connections: ${connections}` : ""}${ctx.config.timeZone ? `; time zone ${ctx.config.timeZone}` : ""}; today ${spentToday(ctx.ledger).toFixed(2)}${c ? `; paused until ${when(c)}` : ""}`);
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
      tool("list_tenants", "List the tenants (friends who use this assistant): id, name, role, status, capabilities, whether her Google or Notion is connected, what she spent today against her own limit, and any pause. Never shows a key or anything she said.", {}, async () => {
        const lines = describeTenants();
        return reply(lines.length ? lines.join("\n") : "No tenants yet.");
      }),
      tool(
        "invite_person",
        "Send ONE fixed first hello (written by code, not by you) to a person the owner names by phone number or Signal username, so that she can answer and is then a friend with no further question. Only when the owner asks for it. (Asks the owner's approval first.)",
        { recipient: z.string().min(5).max(60).describe("A phone number with country code (+15555550114) or a Signal username (name.42), exactly as the owner gave it") },
        async ({ recipient }) => {
          const send = deps.sendFirst ?? tenantHooks.sendFirst;
          if (!send) return reply("This chat platform cannot write first to a person.", true);
          try {
            const { preapproved } = await invitePerson(recipient, send);
            emitRecord("tenant_invite", "sent", "chat");
            return reply(preapproved ? "The hello is sent. When she answers she is a friend, no further question." : "The hello is sent, but her account could not be recognised, so if she answers the owner is asked as for anyone else.");
          } catch (e) {
            emitRecord("tenant_invite", "failed", "chat");
            return reply(`The hello was not sent: ${(e as Error).message}`, true);
          }
        },
      ),
      tool(
        "suspend_tenant",
        "Suspend a tenant: she gets no answers at all from now on, her data stays. (Asks the owner's approval first.)",
        idArg,
        async ({ id }) => {
          if (!found(id)) return reply("No such tenant.", true);
          setStatus(id, "suspended");
          (deps.drop ?? tenantHooks.drop)?.(id);
          emitRecord("tenant_status", "suspended", "chat", { tenant: id });
          return reply(`${id} is suspended.`);
        },
      ),
      tool("resume_tenant", "Let a suspended tenant talk to the assistant again.", idArg, async ({ id }) => {
        const rec = found(id);
        if (!rec) return reply("No such tenant.", true);
        setStatus(id, "active");
        emitRecord("tenant_status", "resumed", "chat", { tenant: id });
        return reply(`${id} can talk to me again.`);
      }),
      tool(
        "remove_tenant",
        "Delete a tenant AND her data for good: her notes, her chat history, and her session. Cannot be undone. (Asks the owner's approval first.)",
        { ...idArg, confirm: z.literal(true).describe("Always true: the owner's approval is what actually decides") },
        async ({ id }) => {
          if (!found(id)) return reply("No such tenant.", true);
          const r = await (deps.remove ?? tenantHooks.remove ?? removeTenant)(id, { drop: (t) => (deps.drop ?? tenantHooks.drop)?.(t), secrets: deps.secrets ?? [(t) => deleteTenantItems(appBao(), t)] });
          emitRecord("tenant_status", "deleted", "chat", { tenant: id });
          return reply([`Deleted ${id} and her data${r?.removed.length ? `: ${r.removed.join(", ")}` : ""}.`, ...(r?.failed.length ? [`Not removed (ask again): ${r.failed.join(", ")}.`] : []), ...(r?.manual ? [r.manual] : [])].join(" "));
        },
      ),
    ],
  });
}

;
