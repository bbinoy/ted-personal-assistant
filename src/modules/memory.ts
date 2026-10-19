import { rowsOf, type ToolModule } from "./types.ts";

// memory (memory-tools.ts): forget a note, search the logs, undo the dream. Scoped to the conversation by its server (where there are notes); undoing a dream
// goes with the dream.
const memory = rowsOf("mcp__memory__", "memory", "chat");
export const memoryModule: ToolModule = {
  name: "memory",
  connection: { kind: "in-process", name: "memory", when: (ctx) => !!ctx.memory },
  rows: [...memory("memory", "forget_note search_logs", { only: ["chat", "group"] }), ...memory("memory", "undo_dream", { only: ["chat", "group"], cap: "dream" })],
  free: true,
};
