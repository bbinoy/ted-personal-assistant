import { rowsOf, type ToolModule } from "./types.ts";

// intake (intaketools.ts): a tenant's single-use link to the page where she types a secret herself, and what it stored as names and lengths. Tenant runs only
// (they are "group" runs), and only while her tool set has it.
// The consent tool (tenants.ts TENANT_CONSENT_TOOL, a test pins the name) is the same kind of onboarding plumbing: the one tool of her run until she has confirmed
// her age and region. It is listed so that it is free, but under the capability `admin`, which no isolated run ever has: it is never part of a capability set, only
// the pre-consent run is handed it by name.
export const intakeModule: ToolModule = {
  name: "intake",
  connection: { kind: "in-process", name: "intake", when: (ctx) => !!ctx.tenant && ctx.offers("mcp__intake__get_setup_link") },
  rows: [...rowsOf("mcp__intake__", "intake", "intake")("intake", "get_setup_link setup_status", { only: ["group"] }), ...rowsOf("mcp__tenant__", "intake", "admin")("consent", "record_consent", { only: ["group"] })],
  free: true,
};
