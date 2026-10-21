import { registered } from "../modules/index.ts";
import { kvGet, kvSet } from "../core/instancedb.ts";

// Tool names runs have seen, so policy.hiddenTools() can hide the unused ones by name.
// Seeded with the connectors' current tools (each tool module's `known`: Notion, Mailbird, Gmail), so even the very first run is trimmed.
const TOOLS_SEEN = "tools-seen"; // (the kv row of instance.db)
const seed = (): string[] => registered().flatMap((m) => m.known ?? []);
export const toolsSeen = () => kvGet<string[]>(TOOLS_SEEN, seed());
export function recordToolsSeen(tools: readonly string[]) {
  const known = toolsSeen();
  const added = tools.filter((t) => t.startsWith("mcp__") && !known.includes(t));
  if (added.length) kvSet(TOOLS_SEEN, [...known, ...added]);
}
