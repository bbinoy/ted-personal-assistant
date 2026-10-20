import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { isTriage, readAudit, type AuditEntry } from "../audit.ts";
import { createBrowseServer } from "../browse.ts";
import { browseStatus, browserServer } from "../browseserver.ts";
import { readConnectors } from "../connectors.ts";
import { createDrawServer } from "../drawtool.ts";
import { googleHub, googleProxy, sweepStaleCredentialDirs } from "../googlemcp.ts";
import { notionHub, notionProxy } from "../notionmcp.ts";
import { GmailMail, gmailReaders } from "../gmail.ts";
import { createIntakeServer } from "../intaketools.ts";
import { Mailbird } from "../mailbird.ts";
import { createMemoryServer } from "../memory-tools.ts";
import { recordMemoryChange } from "../memorynotice.ts";
import { createProposer } from "../propose.ts";
import { LIMITS } from "../sanitize.ts";
import { createSendServer } from "../send.ts";
import { settings } from "../settings.ts";
import { createTenantAdminServer } from "../tenanttools.ts";
import { createVoiceServer } from "../voicetool.ts";
import { createWeatherServer } from "../weathertools.ts";
import { loaded, mailModule } from "./index.ts";
import { setGmailReaders } from "./gmail.ts";
import { GOOGLE_PREFIX } from "./google.ts";
import { NOTION_FRIEND_PREFIX, NOTION_FRIEND_TOOLS } from "./notionhosted.ts";
import { setDraftReader } from "./mailbird.ts";
import type { DoctorLine, MailRuntime, RunContext, ServerFactory } from "./types.ts";

// The code the tool modules wrap, bound to them by name. The declarations (this folder's other files) are read by nearly everything, so they import nothing
// of the application; what they start, and the mail clients they talk to, is here, and only the places that start things import this file: agentrun.ts
// (the run's servers), main.ts, heartbeat.ts and cli.ts (the mail client), doctor.ts (the checks).

// ---- the MCP servers ----

// By the `name` of a module's in-process or external connection. The module says WHEN a run has the server (`when`); this builds it.
export const SERVERS: Readonly<Record<string, ServerFactory>> = {
  send: (ctx) => createSendServer(ctx.key!),
  weather: () => createWeatherServer(),
  draw: (ctx) => createDrawServer(ctx.key!),
  voice: (ctx) => createVoiceServer(ctx.key!),
  memory: (ctx) => createMemoryServer({ notesDir: ctx.memory!.dir, groupId: ctx.memory!.groupId, tenantLog: ctx.tenant?.logFile, record: ctx.memory!.notify ? recordMemoryChange : () => {} }),
  browse: (ctx) => createBrowseServer({ mode: ctx.mode, groupId: ctx.memory?.groupId, key: ctx.key, tenant: !!ctx.tenant, spent: ctx.tenant?.overBudget, run: ctx.browseRun }),
  // The browse run's browser: a separate @playwright/mcp process under the guard's directory (browseserver.ts).
  browser: (ctx) => {
    const status = browseStatus();
    if (!status.ok) throw new Error(`browsing is not set up: ${status.reason}`);
    return browserServer(status, ctx.guard!.outDir, undefined, { mode: ctx.guard!.vision, cdpPort: ctx.guard!.cdpPort });
  },
  intake: (ctx) => createIntakeServer(ctx.tenant!),
  // A friend's Google tools: her own server process, started by this process with her token (googlemcp.ts), forwarded to the run through a proxy that has no command line and no environment.
  google: (ctx) => googleProxy(ctx.tenant!.id, (name) => ctx.offers(GOOGLE_PREFIX + name)),
  // A friend's Notion tools: Notion's hosted server, called by this process with her token (notionmcp.ts), through the same kind of proxy: no header for the CLI to carry.
  notion: (ctx) =>
    notionProxy(
      ctx.tenant!.id,
      (name) => ctx.offers(NOTION_FRIEND_PREFIX + name),
      NOTION_FRIEND_TOOLS.map((t) => t.slice(NOTION_FRIEND_PREFIX.length)),
    ),
  tenants: () => createTenantAdminServer(),
};

// ---- what runs between runs ----

// A server that outlives a run (a friend's Google process with her token in a private folder, her Notion connection) is stopped by the application, not left to the
// idle timer: `start` once when the application starts (clearing what a process that died left behind), `stop` when it exits, `drop` for one person who is suspended or
// removed. By the same `name` as SERVERS; a module whose servers keep nothing between runs has no entry.
export interface ModuleLifecycle {
  start?: () => void;
  stop: () => void;
  drop: (tenantId: string) => void;
}
export const LIFECYCLE: Readonly<Record<string, ModuleLifecycle>> = {
  google: {
    start: () => {
      const n = sweepStaleCredentialDirs();
      if (n) console.log(`google: removed ${n} credentials folder(s) a stopped process left behind`);
    },
    stop: () => googleHub.closeAll(),
    drop: (id) => googleHub.drop(id),
  },
  notion: { stop: () => notionHub.closeAll(), drop: (id) => notionHub.drop(id) },
};
export const startAll = (): void => void Object.values(LIFECYCLE).forEach((l) => l.start?.());
export const stopAll = (): void => void Object.values(LIFECYCLE).forEach((l) => l.stop());
export const dropAll = (tenantId: string): void => void Object.values(LIFECYCLE).forEach((l) => l.drop(tenantId));

// The MCP servers of a run, by the name the run knows them under: every loaded module's in-process or external server for this conversation, in module order.
// The browse sub-run has only the servers marked `forBrowse` (the browser); every other run has all the others. A connector is not here: it comes with the login.
export function serversFor(ctx: RunContext): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const m of loaded()) {
    const c = m.connection;
    if ((c.kind !== "in-process" && c.kind !== "external") || !!c.forBrowse !== ctx.browsing || !c.when(ctx)) continue;
    const make = SERVERS[c.name];
    if (!make) throw new Error(`module ${m.name}: no server is built under the name ${c.name}`);
    servers[c.name] = make(ctx);
  }
  return servers;
}

// ---- the mail providers ----

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// `npm run restore <id>` for Mailbird: an archived conversation back in the inbox. The audit id may be a different conversation id than the one Mailbird knows
// now, so the ids the triage row recorded are tried, and last the archive is searched by subject. Returns the exit code.
async function restoreMailbird(id: string): Promise<number> {
  const client = new Mailbird();
  await client.connect();
  const entry: AuditEntry | undefined = readAudit((e) => isTriage(e) && e.meta?.id === id).pop();
  const candidates = [id, ...(String(entry?.meta?.result ?? "").match(UUID) ?? []).filter((u: string) => u !== id)];
  for (const c of candidates) {
    try {
      await client.call("move_conversation_to_inbox", { conversationId: c });
      console.log(`Restored to the inbox (conversation ${c}).`);
      return 0;
    } catch {
      /* try the next candidate */
    }
  }
  // Last resort: find it in the archive by subject.
  if (entry?.meta?.subject) {
    const hits = await client.call<{ conversationId: string; subject: string }[]>("search_conversations", { query: `subject:"${entry.meta.subject.replace(/"/g, "")}"`, limit: 5 });
    const hit = Array.isArray(hits) ? hits.find((h) => h.subject === entry.meta!.subject) : undefined;
    if (hit) {
      await client.call("move_conversation_to_inbox", { conversationId: hit.conversationId });
      console.log(`Restored via subject search (conversation ${hit.conversationId}).`);
      return 0;
    }
  }
  console.error("Could not restore it automatically. Find it in Mailbird's archive by subject.");
  return 1;
}

// The mail check. Reachable means the local server answers and lists its inboxes.
export async function mailbirdCheck(line: DoctorLine, connect: () => Promise<number>): Promise<void> {
  try {
    line(true, "Mailbird MCP reachable", `${await connect()} inbox(es)`);
  } catch (e) {
    line(false, "Mailbird MCP reachable", (e as Error).message.slice(0, LIMITS.reason));
  }
}

// The Gmail checks (MAIL_PROVIDER=gmail): the owner's own address is set, the claude.ai connector was available in the last run, and which archive mode is on.
// The connector comes with the Claude login; whether it is there is only known from a run's start-up message (connectors.ts), so before the first run it is a warning.
export function gmailChecks(line: DoctorLine, o: { self: string | undefined; connector: boolean | undefined; archiveLive: boolean; briefEmail: boolean }): void {
  line(!!o.self, "MAIL_SELF_ADDRESS set", o.self ? "" : "your own Gmail address, the only address the brief may be emailed to (.env.example)");
  line(o.connector === undefined ? "warn" : o.connector, "Gmail connector available", o.connector === undefined ? "no run yet: start the agent, then run doctor again" : o.connector ? "" : "not available in the last run: connect Gmail in your Claude account (Settings, Connectors)");
  line(true, "Gmail archiving", o.archiveLive ? "live (ARCHIVE=live)" : "LOG-ONLY (ARCHIVE=log): it records would-archive and archives nothing; remove ARCHIVE=log (or set live) after the trial week");
  line(o.briefEmail && !o.self ? false : true, "brief by email", o.briefEmail ? "on: emailed to MAIL_SELF_ADDRESS only, plus the Signal summary" : "off (BRIEF_EMAIL=off): the brief goes to Signal only");
}

// By the name of the mail module (the value of MAIL_PROVIDER).
export const MAIL: Readonly<Record<string, MailRuntime>> = {
  mailbird: {
    source: () => new Mailbird(),
    restore: restoreMailbird,
    // Mailbird's connection for reply drafts: the handler's drafts are shown on the phone (propose.ts), and the approval of any send shows the draft read back from here.
    start: (io) => {
      const proposer = createProposer({ mail: new Mailbird(), send: (t) => io.reply(t) });
      setDraftReader(proposer.read);
      return { propose: proposer.show };
    },
    check: (line) =>
      mailbirdCheck(line, async () => {
        const client = new Mailbird();
        try {
          await client.connect();
          return (await client.inboxes()).length;
        } finally {
          await client.close().catch(() => {});
        }
      }),
  },
  gmail: {
    source: () => new GmailMail(),
    // Gmail: an archive is only the INBOX label removed, so undoing it is adding INBOX back to the thread (the audit id is the thread id).
    restore: async (id) => {
      await new GmailMail().call("move_conversation_to_inbox", { conversationId: id });
      console.log(`Put back in the inbox (thread ${id}).`);
      return 0;
    },
    // The approval of a send reads the draft (or the message being replied to) back through the connector (gmail.ts).
    start: () => {
      setGmailReaders(gmailReaders());
      return {};
    },
    check: (line) => gmailChecks(line, { self: settings.mailSelfAddress, connector: readConnectors()?.gmail, archiveLive: settings.archiveLive, briefEmail: settings.briefEmail }),
  },
};

// The loaded mail module's code, or undefined when there is no mail (MAIL_PROVIDER=none).
export const mailRuntime = (provider?: string): MailRuntime | undefined => {
  const m = mailModule(provider);
  return m && MAIL[m.name];
};
