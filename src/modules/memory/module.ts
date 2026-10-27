import { rowsOf, type ToolModule } from "../types.ts";

// memory (memory-tools.ts): forget a note, search the logs, read the journal of what was done, undo the dream, and (the owner's look only, `attended: false`: the brief's bookkeeping) the list of what the dream changed on its
// own since the last brief. One server for every run of a conversation, a message turn or a look: scoped to the conversation by its server (where there are notes); undoing a dream goes with the dream. Reading and writing the
// notes themselves is the SDK's file tools (builtin.ts), confined to the same folder.
const memory = rowsOf("mcp__memory__", "memory", "chat");
export const memoryModule: ToolModule = {
  name: "memory",
  connection: { kind: "in-process", name: "memory", when: (ctx) => !!ctx.memory && ctx.offers("mcp__memory__search_logs") },
  rows: [...memory("memory", "forget_note journal search_logs"), ...memory("memory", "undo_dream", { cap: "dream" })],
  free: true,
};
