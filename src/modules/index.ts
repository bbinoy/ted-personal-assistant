import { settings } from "../settings.ts";
import { browseModule, browserModule } from "./browse.ts";
import { builtinModule } from "./builtin.ts";
import { calendarModule } from "./calendar.ts";
import { claudeDocsModule, docsModule, driveModule } from "./drive.ts";
import { drawModule } from "./draw.ts";
import { gmailModule } from "./gmail.ts";
import { ibkrModule } from "./ibkr.ts";
import { googleModule } from "./google.ts";
import { notionHostedModule } from "./notionhosted.ts";
import { intakeModule } from "./intake.ts";
import { mailbirdModule } from "./mailbird.ts";
import { memoryModule } from "./memory.ts";
import { notionModule } from "./notion.ts";
import { sendModule } from "./send.ts";
import { tenantsModule } from "./tenants.ts";
import type { Connection, MailSlot, RunContext, ToolModule } from "./types.ts";
import { voiceModule } from "./voice.ts";
import { weatherModule } from "./weather.ts";

// THE LIST OF TOOL MODULES. Adding a tool is a file in this folder and a line here; nothing else in the code names its tools. The order is the order the
// run's MCP servers are listed in (send, weather, draw, voice, memory, browse, intake, tenants) and the order setup questions and known tools are listed in.
//
// A function and not a constant on purpose: files that this list's own imports lead back to (the manifest, policy, skills) read it, so it is built on first use,
// when every module has been evaluated.
let all: readonly ToolModule[] | undefined;
export const registered = (): readonly ToolModule[] =>
  (all ??= [sendModule, weatherModule, drawModule, voiceModule, memoryModule, browseModule, browserModule, intakeModule, tenantsModule, builtinModule, calendarModule, notionModule, driveModule, docsModule, claudeDocsModule, ibkrModule, googleModule, notionHostedModule, mailbirdModule, gmailModule]);

// LOADED: every module without a slot, and in the `mail` slot the one MAIL_PROVIDER names (none: no mail module). A module that is not loaded has no rows,
// no skills and no connection; only its floor data (registered() below) keeps restricting, because a floor rule can only take away.
export const loaded = (mail: string = settings.mailProvider): readonly ToolModule[] => registered().filter((m) => !m.slot || m.name === mail);

export const mailProviders = (): string[] => registered().filter((m) => m.slot === "mail").map((m) => m.name);
export const mailModule = (mail: string = settings.mailProvider): (ToolModule & { mail: MailSlot }) | undefined => loaded(mail).find((m): m is ToolModule & { mail: MailSlot } => m.slot === "mail" && !!m.mail);
export const mailSlot = (mail?: string): MailSlot | undefined => mailModule(mail)?.mail;

// The connection a module uses for this run: its own, unless it picks another for this conversation (connectionFor). The servers themselves are built in
// runtime.ts (serversFor).
export const connectionOf = (m: ToolModule, ctx: RunContext): Connection => m.connectionFor?.(ctx) ?? m.connection;
