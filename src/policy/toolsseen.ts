import { registered } from "../modules/index.ts";
import { readJson, writeJson } from "../core/state.ts";

// Tool names runs have seen, so policy.hiddenTools() can hide the unused ones by name.
// Seeded with the connectors' current tools (each tool module's `known`: Notion, Mailbird, Gmail), so even the very first run is trimmed.
const TOOLS_SEEN = "state/tools-seen.json";
const seed = (): string[] => registered().flatMap((m) => m.known ?? []);
export const toolsSeen = () => readJson<string[]>(TOOLS_SEEN, seed());
export function recordToolsSeen(tools: readonly string[]) {
  const known = toolsSeen();
  const added = tools.filter((t) => t.startsWith("mcp__") && !known.includes(t));
  if (added.length) writeJson(TOOLS_SEEN, [...known, ...added]);
}
