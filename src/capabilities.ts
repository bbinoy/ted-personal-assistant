import { baseUrlProblem, intakeToolsFor } from "./intakelinks.ts";
import { settings } from "./settings.ts";
import { skillsFor } from "./skills.ts";
import { type Capability, type TenantContext } from "./tenants.ts";
import { manifest } from "./toolmanifest.ts";

// ONE mechanism for the tools and skills of every isolated conversation (a group, a tenant): a set of capabilities in, its tools and its skills out.
// The tools come from the manifest (toolmanifest.ts: the rows of the loaded tool modules, each naming its capability and the sources it is for), the skills
// from skills.ts (the shared skills of the same modules), and policy.ts
// classify, the run's built-in tools, its MCP servers and its skills allowlist all read the same two results. The owner is not derived: the owner's
// conversation has everything (the connectors, the whole plugin), and its rules are the manifest flags.

// What a group has: no record, a fixed set. Nothing of the owner's (no mail, calendar, notion, profile, card), and no secrets to set up (no intake).
export const GROUP_CAPABILITIES: readonly Capability[] = ["chat", "browse", "voice", "heartbeat", "dream", "wake", "weather", "draw"];

// Capabilities an isolated run can never have, whatever a record lists: they need the instance's own login (its card and saved details) or the admin's powers. A run on the instance key has no connectors (strictMcpConfig), so there is nothing to give.
const LOGIN_ONLY: readonly Capability[] = ["profile", "card", "admin"];

// Never a tool of a group or a tenant, whatever the table says: the owner's connectors and tools, the browser's own tools, opening a page, payment and the
// saved profile. Listed so a test can check that nothing here is reachable, and so that a row added to the manifest cannot slip one in unnoticed.
export const NEVER_FOR_ISOLATED: readonly RegExp[] = [/^mcp__mailbird__/, /^mcp__claude_ai_/, /^mcp__tenants__/, /^mcp__browser__/, /^WebFetch$/, /^Bash/, /card|payment|profile/i];

// The capabilities a run of an isolated conversation has: what was granted, less what its instance cannot give (no login, a feature switched off in .env,
// the person's own settings, the intake page not set up). Settings can only take away.
export function runCapabilities(granted: readonly Capability[], own: { browse?: boolean; voice?: boolean } = {}): ReadonlySet<Capability> {
  const caps = new Set(granted);
  if (!intakeToolsFor(granted).length) caps.delete("intake"); // its tools need INTAKE_BASE_URL, a purpose and the capability for it (read before the login-only ones go)
  for (const c of LOGIN_ONLY) caps.delete(c);
  // Mail and calendar of a person on the instance key are her own Google (modules/google.ts): only with the `google` capability and an OAuth client set up.
  if (!caps.has("google") || !settings.google.clientId || !settings.google.clientSecret) for (const c of ["google", "mail", "calendar"] as const) caps.delete(c);
  // Notion of a person on the instance key is her own, through the hosted Notion server (modules/notionhosted.ts): only with the `notion` capability and a page to sign in
  // on (INTAKE_BASE_URL). The owner's Notion is the connector, which no isolated run ever has (NEVER_FOR_ISOLATED).
  if (baseUrlProblem()) caps.delete("notion");
  if (!settings.browse || own.browse === false) caps.delete("browse");
  if (own.voice === false) caps.delete("voice");
  if (!settings.weather) caps.delete("weather");
  if (!settings.draw) caps.delete("draw");
  return caps;
}

export const groupCapabilities = (): ReadonlySet<Capability> => runCapabilities(GROUP_CAPABILITIES);
export const tenantCapabilities = (ctx: Pick<TenantContext, "config" | "capabilities">): ReadonlySet<Capability> => runCapabilities(ctx.capabilities, ctx.config);

// The tools of a run with these capabilities: every manifest row whose capability is in the set and that is not limited away from groups. Built-in tools
// (no "mcp__" prefix) are in the same set; the unknown tool is simply not in it. Skill is there only when there is a skill to load.
export function toolsFor(caps: ReadonlySet<Capability>): ReadonlySet<string> {
  const tools = new Set(manifest().filter((e) => caps.has(e.cap) && (!e.only || e.only.includes("group"))).map((e) => e.tool));
  if (!skillsFor(caps).length) tools.delete("Skill");
  for (const t of tools) if (NEVER_FOR_ISOLATED.some((re) => re.test(t))) tools.delete(t);
  return tools;
}

export const groupTools = (): ReadonlySet<string> => toolsFor(groupCapabilities());
export const tenantTools = (ctx: Pick<TenantContext, "config" | "capabilities">): ReadonlySet<string> => toolsFor(tenantCapabilities(ctx));
