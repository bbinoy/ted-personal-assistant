import { rowsOf, type ToolModule } from "./types.ts";

// intake (intaketools.ts): a tenant's single-use link to the page where she types a secret herself, and what it stored as names and lengths. Tenant runs only
// (they are "group" runs), and only while her tool set has it.
export const intakeModule: ToolModule = {
  name: "intake",
  connection: { kind: "in-process", name: "intake", when: (ctx) => !!ctx.tenant && ctx.offers("mcp__intake__get_setup_link") },
  rows: [...rowsOf("mcp__intake__", "intake", "intake")("intake", "get_setup_link setup_status", { only: ["group"] })],
  free: true,
};
