import type { Conversation } from "../conversation/conversationmodel.ts";
import { skillsFor } from "../modules/skills.ts";
import { capabilitiesOfRecord, resolveCapabilities } from "../tenants/capabilityset.ts";
import { CAPABILITIES, OWNER_ID, people, tenantById, type Capability } from "../tenants/tenants.ts";
import { isOwnerOnly, manifest } from "./toolmanifest.ts";

// ONE answer to "what may this conversation use now": capabilitiesOf(conv), a set of capabilities. Its tools and skills (toolsFor, skillsFor) and the loops that look in on
// it (wake-ups, the dream, the mail check, the gate's presets: allows) all read that one set, for the owner, a group and a friend alike.
// The tools come from the manifest (toolmanifest.ts: the rows of the loaded tool modules, each naming its capability and the sources it is for), the skills
// from skills.ts (the shared skills of the same modules), and policy.ts classify, the run's built-in tools, its MCP servers and its skills allowlist all read the same two
// results. The owner's tools are not derived (the owner's conversation has everything: the connectors, the whole plugin, and its rules are the manifest flags), but the
// owner's capability set comes from the same function and drives the loops.

export { capabilitiesOfRecord, resolveCapabilities }; // (the derivation lives in tenants/capabilityset.ts: the admin's list and the intake page need it too and sit below policy/)

// What a group has: no record, a fixed set. Nothing of the owner's (no mail, calendar, notion, profile, card), and no secrets to set up (no intake).
export const GROUP_CAPABILITIES: readonly Capability[] = ["chat", "browse", "voice", "heartbeat", "dream", "wake", "weather", "draw"];

type Who = Pick<Conversation, "kind" | "tenantId">;

// Her record: the owner's (seeded by ensureOwner, absent before that), a tenant's, none for a group.
const recordOf = (conv: Who) => (conv.kind === "owner" ? people().find((r) => r.id === OWNER_ID) : conv.tenantId ? tenantById(conv.tenantId) : undefined);

// The set: a group has the fixed one; the owner and a tenant have their person's (capabilitiesOfRecord), and only while she is active (not suspended or removed). The owner
// before her record is seeded has everything, as ever.
export function capabilitiesOf(conv: Who): ReadonlySet<Capability> {
  if (conv.kind === "group") return resolveCapabilities(GROUP_CAPABILITIES);
  const rec = recordOf(conv);
  if (!rec) return conv.kind === "owner" ? resolveCapabilities(CAPABILITIES, { login: true }) : new Set();
  return rec.status === "active" ? capabilitiesOfRecord(rec) : new Set();
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
