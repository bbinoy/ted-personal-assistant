import { settings } from "../settings.ts";
import { rowsOf, type ToolModule } from "./types.ts";

// The owner's tenant administration (tenanttools.ts), only while TENANTS=on: minting an invite and looking are free; stopping a tenant or deleting her and
// her data is never judged and always asks.
const tenants = rowsOf("mcp__tenants__", "tenants", "admin");
export const tenantsModule: ToolModule = {
  name: "tenants",
  connection: { kind: "in-process", name: "tenants", when: (ctx) => ctx.source === "chat" && settings.tenants },
  rows: [...tenants("tenants-read", "create_invite list_tenants resume_tenant", { only: ["chat"] }), ...tenants("tenants-stop", "suspend_tenant remove_tenant", { only: ["chat"] })],
  free: ["tenants-read"],
  floor: { judgeNever: ["tenants-stop"] },
};
