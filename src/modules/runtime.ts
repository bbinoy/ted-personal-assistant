import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { createBrowseServer } from "./browse/browse.ts";
import { browseStatus, browserServer } from "./browse/browseserver.ts";
import { connected, readConnectors } from "./connectors.ts";
import { createDrawServer } from "./draw/drawtool.ts";
import { dreamScope } from "./memory/dreamscope.ts";
import { googleHub, googleProxy, searchContacts, sweepStaleCredentialDirs } from "./google/googlemcp.ts";
import { notionHub, notionProxy } from "./notion/notionmcp.ts";
import { gmailReaders, putBackInInbox } from "./gmail/gmail.ts";
import { createIntakeServer } from "../intake/intaketools.ts";
import { Mailbird } from "./mailbird/mailbird.ts";
import { createMemoryServer } from "./memory/memory-tools.ts";
import { viewDraft } from "./mailbird/proposals.ts";
import { LIMITS } from "../core/sanitize.ts";
import { createSendServer } from "./send/send.ts";
import { auditSource } from "../core/runkind.ts";
import { createPeopleServer } from "./people/peopletool.ts";
import { createTasksServer } from "./tasks/tasktools.ts";
import { createSeenMailServer } from "./seenmail/seenmail.ts";
import { createMeetingsServer } from "./meetings/meetingtools.ts";
import { settings } from "../core/settings.ts";
import { createTenantAdminServer } from "../tenants/tenanttools.ts";
import { zoneOf } from "../tenants/tenants.ts";
import { createVoiceServer } from "./voice/voicetool.ts";
import { createWeatherServer } from "./weather/weathertools.ts";
import { loaded, mailModule } from "./index.ts";
import { setGmailReaders } from "./gmail/module.ts";
import { GOOGLE_MAIL_TOOL, GOOGLE_PREFIX, GOOGLE_TOOLS } from "./google/module.ts";
import { NOTION_FRIEND_PREFIX, NOTION_FRIEND_TOOLS } from "./notion/module.ts";
import { setDraftReader } from "./mailbird/module.ts";
import type { DoctorLine, MailRuntime, RunContext, ServerFactory } from "./types.ts";

// The code the tool modules wrap, bound to them by name. The declarations (this folder's other files) are read by nearly everything, so they import nothing
// of the application; what they start, and the mail clients they talk to, is here, and only the places that start things import this file: agentrun.ts
// (the run's servers), main.ts and cli.ts (the mail client), doctor.ts (the checks).

// ---- the code of each module ----

// What a module's code does that its declaration may not (it would pull the application into every file that reads the module list): the server it builds for a run, and what
// runs between runs. ONE record per module, by the module's `name` (not its connection's: the module `notionhosted` serves the server `notion`), so adding a module that starts a
// server is one entry here. test/modules.test.ts proves that every module that names a server has one here and that nothing here belongs to no module.
export interface ModuleRuntime {
  server?: ServerFactory; // for a module with an in-process or external connection: the module says WHEN a run has the server (`when`); this builds it
  lifecycle?: ModuleLifecycle; // a server that outlives a run (below)
}

// A server that outlives a run (a friend's Google process with her token in a private folder, her Notion connection) is stopped by the application, not left to the
// idle timer: `start` once when the application starts (clearing what a process that died left behind), `stop` when it exits, `drop` for one person who is suspended or
// removed. A module whose servers keep nothing between runs has no lifecycle.
export interface ModuleLifecycle {
  start?: () => void;
  stop: () => void;
  drop: (tenantId: string) => void;
}

export const RUNTIME: Readonly<Record<string, ModuleRuntime>> = {
  send: { server: (ctx) => createSendServer(ctx.key!) },
  weather: { server: () => createWeatherServer() },
  draw: { server: (ctx) => createDrawServer(ctx.key!) },
  voice: { server: (ctx) => createVoiceServer(ctx.key!) },
  memory: { server: (ctx) => createMemoryServer({ notesDir: ctx.memory!.dir, source: auditSource(ctx.kind), groupId: ctx.groupId, tenantLog: ctx.tenant?.logFile, zone: ctx.tenant ? () => zoneOf({ tenantId: ctx.tenant!.id }) : undefined, dream: ctx.tenant ? dreamScope({ kind: "tenant", tenantId: ctx.tenant.id }) : ctx.groupId ? dreamScope({ kind: "group", groupId: ctx.groupId }) : undefined, offers: ctx.offers }) },
  // find_person: this conversation's people notes and, for a friend whose set has Google, her own Contacts through her own session; a group or the owner has notes only (the owner's Google connectors have no contacts tool).
  people: {
    server: (ctx) =>
      createPeopleServer({
        notesDir: ctx.memory!.dir,
        source: auditSource(ctx.kind),
        zone: ctx.tenant ? () => zoneOf({ tenantId: ctx.tenant!.id }) : undefined,
        contacts: ctx.tenant && ctx.offers(GOOGLE_MAIL_TOOL) ? (query) => searchContacts(ctx.tenant!.id, query) : undefined,
        contactsWhy: ctx.tenant ? "she has not connected Google" : ctx.groupId ? "a group has no contacts of its own" : "the Google connectors on the owner's login have no contacts tool",
      }),
  },
  // The conversation's task list. A look has the same task tools as a chat turn (tasktools.ts).
  tasks: {
    server: (ctx) =>
      createTasksServer({
        key: ctx.key!,
        source: auditSource(ctx.kind),
        unattended: !ctx.kind.attended,
        zone: () => zoneOf({ tenantId: ctx.tenant?.id }),
      }),
  },
  seenmail: { server: (ctx) => createSeenMailServer(ctx.seenMail!) },
  // note_upcoming_meetings: any run with the calendar, writing that conversation's own meetings table (meetingtools.ts).
  meetings: { server: (ctx) => createMeetingsServer({ key: ctx.key!, source: auditSource(ctx.kind) }) },
  browse: { server: (ctx) => createBrowseServer({ mode: ctx.mode, groupId: ctx.groupId, key: ctx.key, attended: ctx.kind.attended, tenant: !!(ctx.tenant ?? ctx.sponsor), run: ctx.browseRun }) },
  // The browse run's browser: a separate @playwright/mcp process under the guard's directory (browseserver.ts).
  browser: {
    server: (ctx) => {
      const status = browseStatus();
      if (!status.ok) throw new Error(`browsing is not set up: ${status.reason}`);
      return browserServer(status, ctx.guard!.outDir, undefined, { cdpPort: ctx.guard!.cdpPort!, proxyPort: ctx.guard!.proxyPort });
    },
  },
  intake: { server: (ctx) => createIntakeServer(ctx.tenant!) },
  // A friend's Google tools: her own server process, started by this process with her token (googlemcp.ts), forwarded to the run through a proxy that has no command line and no environment.
  google: {
    server: (ctx) => googleProxy(ctx.tenant!.id, (name) => ctx.offers(GOOGLE_PREFIX + name), undefined, GOOGLE_TOOLS),
    lifecycle: {
      start: () => {
        const n = sweepStaleCredentialDirs();
        if (n) console.log(`google: removed ${n} credentials folder(s) a stopped process left behind`);
      },
      stop: () => googleHub.closeAll(),
      drop: (id) => googleHub.drop(id),
    },
  },
  // A friend's Notion tools: Notion's hosted server, called by this process with her token (notionmcp.ts), through the same kind of proxy: no header for the CLI to carry.
  notionhosted: {
    server: (ctx) =>
      notionProxy(
        ctx.tenant!.id,
        (name) => ctx.offers(NOTION_FRIEND_PREFIX + name),
        NOTION_FRIEND_TOOLS.map((t) => t.slice(NOTION_FRIEND_PREFIX.length)),
      ),
    lifecycle: { stop: () => notionHub.closeAll(), drop: (id) => notionHub.drop(id) },
  },
  tenants: { server: () => createTenantAdminServer() },
};

// ---- what runs between runs ----

const lifecycles = (): ModuleLifecycle[] => Object.values(RUNTIME).flatMap((r) => (r.lifecycle ? [r.lifecycle] : []));
export const startAll = (): void => void lifecycles().forEach((l) => l.start?.());
export const stopAll = (): void => void lifecycles().forEach((l) => l.stop());
export const dropAll = (tenantId: string): void => void lifecycles().forEach((l) => l.drop(tenantId));

// The MCP servers of a run, by the name the run knows them under: every loaded module's in-process or external server for this conversation, in module order.
// The browse sub-run has only the servers marked `forBrowse` (the browser); every other run has all the others. A connector is not here: it comes with the login.
export function serversFor(ctx: RunContext): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const m of loaded()) {
    const c = m.connection;
    if ((c.kind !== "in-process" && c.kind !== "external") || !!c.forBrowse !== ctx.browsing || !c.when(ctx)) continue;
    const make = RUNTIME[m.name]?.server;
    if (!make) throw new Error(`module ${m.name}: no server is built for it in runtime.ts (RUNTIME.${m.name}.server)`);
    servers[c.name] = make(ctx);
  }
  return servers;
}

// ---- the mail providers ----

// `npm run restore <id>` for Mailbird: an archived conversation back in the inbox. The id is the one in the audit log (`npm run report` lists it), which is the id the archive
// call named; Mailbird may have given the conversation another id since, in which case the archive has to be searched by subject by hand. Returns the exit code.
async function restoreMailbird(id: string): Promise<number> {
  const client = new Mailbird();
  try {
    await client.connect();
    await client.call("move_conversation_to_inbox", { conversationId: id });
    console.log(`Restored to the inbox (conversation ${id}).`);
    return 0;
  } catch (e) {
    console.error(`Could not restore it (${(e as Error).message.slice(0, LIMITS.reason)}). Find it in Mailbird's archive by subject.`);
    return 1;
  } finally {
    await client.close().catch(() => {});
  }
}

// The doctor's Mailbird check. Reachable means the local server answers and lists its accounts.
export async function mailbirdCheck(line: DoctorLine, connect: () => Promise<number>): Promise<void> {
  try {
    line(true, "Mailbird MCP reachable", `${await connect()} account(s)`);
  } catch (e) {
    line(false, "Mailbird MCP reachable", (e as Error).message.slice(0, LIMITS.reason));
  }
}

// The Gmail checks (MAIL_PROVIDER=gmail): the owner's own address is set, the claude.ai connector was available in the last run.
// The connector comes with the Claude login; whether it is there is only known from a run's start-up message (connectors.ts), so before the first run it is a warning.
export function gmailChecks(line: DoctorLine, o: { self: string | undefined; connector: boolean | undefined; briefEmail: boolean }): void {
  line(!!o.self, "MAIL_SELF_ADDRESS set", o.self ? "" : "your own Gmail address, the only address the brief may be emailed to (.env.example)");
  line(o.connector === undefined ? "warn" : o.connector, "Gmail connector available", o.connector === undefined ? "no run yet: start the agent, then run doctor again" : o.connector ? "" : "not available in the last run: connect Gmail in your Claude account (Settings, Connectors)");
  line(o.briefEmail && !o.self ? false : true, "brief by email", o.briefEmail ? "on: emailed to MAIL_SELF_ADDRESS only, plus the chat summary" : "off (BRIEF_EMAIL=off): the brief goes to the chat only");
}

// By the name of the mail module (the value of MAIL_PROVIDER).
export const MAIL: Readonly<Record<string, MailRuntime>> = {
  mailbird: {
    restore: restoreMailbird,
    // The approval of any send shows the draft read back from Mailbird (get_message), over a connection of its own.
    start: () => {
      const client = new Mailbird();
      setDraftReader(async (id) => viewDraft(await client.call("get_message", { messageId: id })));
    },
    check: (line) =>
      mailbirdCheck(line, async () => {
        const client = new Mailbird();
        try {
          await client.connect();
          return (await client.call<unknown[]>("list_accounts")).length;
        } finally {
          await client.close().catch(() => {});
        }
      }),
  },
  gmail: {
    // Gmail: an archive is only the INBOX label removed, so undoing it is adding INBOX back to the thread (the audit id is the thread id).
    restore: async (id) => {
      await putBackInInbox(id);
      console.log(`Put back in the inbox (thread ${id}).`);
      return 0;
    },
    // The approval of a send reads the draft (or the message being replied to) back through the connector (gmail.ts).
    start: () => setGmailReaders(gmailReaders()),
    check: (line) => gmailChecks(line, { self: settings.mailSelfAddress, connector: connected(readConnectors(), "gmail"), briefEmail: settings.briefEmail }),
  },
};

// The loaded mail module's code, or undefined when there is no mail (MAIL_PROVIDER=none).
export const mailRuntime = (provider?: string): MailRuntime | undefined => {
  const m = mailModule(provider);
  return m && MAIL[m.name];
};
