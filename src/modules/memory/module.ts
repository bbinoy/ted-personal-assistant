import { rowsOf, type ToolModule } from "../types.ts";

// memory (memory-tools.ts): forget a note, search the logs, undo the dream. Scoped to the conversation by its server (where there are notes); undoing a dream
// goes with the dream.
const memory = rowsOf("mcp__memory__", "memory", "chat");
export const memoryModule: ToolModule = {
  name: "memory",
  connection: { kind: "in-process", name: "memory", when: (ctx) => !!ctx.memory },
  rows: [...memory("memory", "forget_note search_logs", { only: ["chat", "group"] }), ...memory("memory", "undo_dream", { only: ["chat", "group"], cap: "dream" })],
  free: true,
};

// notes (notestools.ts): the unattended runs' access to their own notes. Their prompt holds the index only; read_note reads one, write_note saves an inferred one and tells the
// owner. Any heartbeat run of any conversation has them, scoped to that conversation's notes folder and categories. They are free: a save is announced and marked, not asked; reading
// shows nothing a third party wrote, so it does not taint the run.
const notes = rowsOf("mcp__notes__", "notes", "heartbeat");
export const notesModule: ToolModule = {
  name: "notes",
  connection: { kind: "in-process", name: "notes", when: (ctx) => !!ctx.notesRead && !ctx.browsing },
  rows: [...notes("memory-read", "read_note", { only: ["background", "group"] }), ...notes("memory-write", "write_note", { only: ["background", "group"] })],
  free: true,
  trusted: true,
};
