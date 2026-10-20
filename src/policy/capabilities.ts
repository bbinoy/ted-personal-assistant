import type { Conversation } from "../conversation/conversationmodel.ts";
import { baseUrlProblem, intakeToolsFor } from "../intake/intakelinks.ts";
import { googleReady, settings } from "../settings.ts";
import { skillsFor } from "../skills.ts";
import { CAPABILITIES, OWNER_ID, people, tenantById, tenantContext, type Capability } from "../tenants/tenants.ts";
import { isOwnerOnly, manifest } from "./toolmanifest.ts";

// ONE answer to "what may this conversation use now": capabilitiesOf(conv), a set of capabilities. Its tools and skills (toolsFor, skillsFor) and the loops that look in on
// it (wake-ups, the dream, the mail check, the gate's presets: allows) all read that one set, for the owner, a group and a friend alike.
// The tools come from the manifest (toolmanifest.ts: the rows of the loaded tool modules, each naming its capability and the sources it is for), the skills
// from skills.ts (the shared skills of the same modules), and policy.ts classify, the run's built-in tools, its MCP servers and its skills allowlist all read the same two
// results. The owner's tools are not derived (the owner's conversation has everything: the connectors, the whole plugin, and its rules are the manifest flags), but the
// owner's capability set comes from the same function and drives the loops.

// What a group has: no record, a fixed set. Nothing of the owner's (no mail, calendar, notion, profile, card), and no secrets to set up (no intake).
export const GROUP_CAPABILITIES: readonly Capability[] = ["chat", "browse", "voice", "heartbeat", "dream", "wake", "weather", "draw"];

// Capabilities that need the instance's own Claude login (its connectors, its card and saved details, the admin's powers, the owner's Google Drive and Docs connectors):
// only the owner's conversation is on the login, whatever else a record lists. Everybody else runs without connectors (strictMcpConfig), so there is nothing to give.
// (`drive` is the owner's connectors, a capability of its own: a friend's own Google, `google`, never carries it.)
const LOGIN_ONLY: readonly Capability[] = ["profile", "card", "admin", "drive"];

// What the instance switches off in .env for everybody (the owner included): a feature that is off has no tools, no skill and no loop.
const SWITCHES: ReadonlyArray<readonly [Capability, () => boolean]> = [
  ["browse", () => settings.browse],
  ["weather", () => settings.weather],
  ["draw", () => settings.draw],
  ["dream", () => settings.dream],
  ["wake", () => settings.wakeups],
];

type Who = Pick<Conversation, "kind" | "tenantId">;

// Her record: the owner's (seeded by ensureOwner, absent before that), a tenant's, none for a group.
const recordOf = (conv: Who) => (conv.kind === "owner" ? people().find((r) => r.id === OWNER_ID) : conv.tenantId ? tenantById(conv.tenantId) : undefined);

// The pure part: what was granted, less what the credential cannot give, what is not set up yet, what the instance has switched off and what the person turned off
// for herself. Every step only takes away. `login`: the owner's conversation, on the instance's own login.
export function resolveCapabilities(granted: readonly Capability[], o: { login?: boolean; own?: { browse?: boolean; voice?: boolean } } = {}): ReadonlySet<Capability> {
  const caps = new Set(granted);
  if (!intakeToolsFor(granted).length) caps.delete("intake"); // its tools need INTAKE_BASE_URL, a purpose and the capability for it (read before the login-only ones go)
  if (!o.login) {
    for (const c of LOGIN_ONLY) caps.delete(c);
    // Mail and calendar of a person on the instance key are her own Google (modules/google.ts): only with the `google` capability and an OAuth client set up.
    // (The owner's are her connectors, which need no OAuth client.)
    if (!caps.has("google") || !googleReady()) for (const c of ["google", "mail", "calendar"] as const) caps.delete(c);
    // Notion of a person on the instance key is her own, through the hosted Notion server (modules/notionhosted.ts): only with the `notion` capability and a page to sign in
    // on (INTAKE_BASE_URL). The owner's Notion is the connector, which no isolated run ever has (ownerOnly: toolmanifest.ts isOwnerOnly).
    if (baseUrlProblem()) caps.delete("notion");
  }
  for (const [c, on] of SWITCHES) if (!on()) caps.delete(c);
  if (o.own?.browse === false) caps.delete("browse");
  if (o.own?.voice === false) caps.delete("voice");
  return caps;
}

// The set: a group has the fixed one; the owner and a tenant have their record's, and only while the person is active (not invited, suspended or removed); then the steps
// of resolveCapabilities (credential, readiness, instance switches, her own settings). The owner before her record is seeded has everything, as ever.
export function capabilitiesOf(conv: Who): ReadonlySet<Capability> {
  if (conv.kind === "group") return resolveCapabilities(GROUP_CAPABILITIES);
  const rec = recordOf(conv);
  if (!rec) return conv.kind === "owner" ? resolveCapabilities(CAPABILITIES, { login: true }) : new Set();
  if (rec.status !== "active") return new Set();
  return conv.kind === "owner" ? resolveCapabilities(rec.capabilities, { login: true }) : resolveCapabilities(rec.capabilities, { own: tenantContext(rec).config });
}

// May this conversation use a capability now?
export const allows = (conv: Who, capability: Capability): boolean => capabilitiesOf(conv).has(capability);

export const groupCapabilities = (): ReadonlySet<Capability> => capabilitiesOf({ kind: "group" });

// The tools of a run with these capabilities: every manifest row whose capability is in the set and that is not limited away from groups. Built-in tools
// (no "mcp__" prefix) are in the same set; the unknown tool is simply not in it. Skill is there only when there is a skill to load.
export function toolsFor(caps: ReadonlySet<Capability>): ReadonlySet<string> {
  const tools = new Set(manifest().filter((e) => caps.has(e.cap) && (!e.only || e.only.includes("group"))).map((e) => e.tool));
  if (!skillsFor(caps).length) tools.delete("Skill");
  for (const t of tools) if (isOwnerOnly(t)) tools.delete(t); // the owner's connectors and tools, the tenant administration, the browser's own tools, opening a page: a module says so (`ownerOnly`, or a connector)
  return tools;
}

export const groupTools = (): ReadonlySet<string> => toolsFor(groupCapabilities());
