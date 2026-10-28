import { settings } from "../core/settings.ts";
import { rowsOf, type ToolModule } from "./types.ts";

// The owner's tenant administration (tenanttools.ts), only while TENANTS=on: looking is free; writing the first hello to a person, stopping a tenant or deleting her and
// her data is never judged and always asks.
const tenants = rowsOf("mcp__tenants__", "tenants", "admin");
export const tenantsModule: ToolModule = {
  name: "tenants",
  connection: { kind: "in-process", name: "tenants", when: (ctx) => settings.tenants && ctx.offers("mcp__tenants__list_tenants") },
  rows: [...tenants("tenants-read", "list_tenants resume_tenant", { attended: true }), ...tenants("tenants-invite", "invite_person", { attended: true }), ...tenants("tenants-stop", "suspend_tenant remove_tenant", { attended: true })],
  free: ["tenants-read"],
  floor: { judgeNever: ["tenants-invite", "tenants-stop"] },
};
