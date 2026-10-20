import type { ToolModule } from "./types.ts";

// Interactive Brokers (trading), the owner's claude.ai connector. Never allowed, for everyone, whatever anyone says: a chat message must never be able to touch
// trading. `never` marks every tool under the connector's prefix, listed or not (new tools included, whatever the connector calls itself: neverallowed.ts,
// toolmanifest.ts neverAllowedTool), so the module needs no rows. The connector is also hidden from the model by default (HIDDEN_CONNECTORS).
export const ibkrModule: ToolModule = {
  name: "ibkr",
  connection: { kind: "connector", server: /interactive brokers|ibkr/i, prefix: "mcp__claude_ai_Interactive_Brokers" },
  rows: [],
  never: true,
};
