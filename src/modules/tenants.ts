import { settings } from "../core/settings.ts";
import { rowsOf, type ToolModule } from "./types.ts";

// The owner's tenant administration (tenanttools.ts), only while TENANTS=on: looking is free; stopping a tenant or deleting her and
// her data is never judged and always asks.
const tenants = rowsOf("mcp__tenants__", "tenants", "admin");
export const tenantsModule: ToolModule = {
  name: "tenants",
  connection: { kind: "in-process", name: "tenants", when: (ctx) => ctx.source === "chat" && settings.tenants },
  rows: [...tenants("tenants-read", "list_tenants resume_tenant", { only: ["chat"] }), ...tenants("tenants-stop", "suspend_tenant remove_tenant", { only: ["chat"] })],
  free: ["tenants-read"],
  ownerOnly: true,
  floor: { judgeNever: ["tenants-stop"] },
};
