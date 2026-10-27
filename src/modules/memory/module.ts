import { rowsOf, type ToolModule } from "../types.ts";

// memory (memory-tools.ts): forget a note, search the logs, read the journal of what was done, undo the dream. Scoped to the conversation by its server (where there are notes); undoing a dream
// goes with the dream.
const memory = rowsOf("mcp__memory__", "memory", "chat");
export const memoryModule: ToolModule = {
  name: "memory",
  connection: { kind: "in-process", name: "memory", when: (ctx) => !!ctx.memory },
  rows: [...memory("memory", "forget_note search_logs journal", { attended: true }), ...memory("memory", "undo_dream", { attended: true, cap: "dream" })],
  free: true,
};

// notes (notestools.ts): the unattended runs' access to their own notes. Their prompt holds the index only; read_note reads one, write_note saves an inferred one quietly (audited); memory_changes_since_brief (the OWNER's own look only: a friend or a group has no brief) hands the daily brief the code-written "learned overnight" list. Any heartbeat run of any conversation has them, scoped to that conversation's notes folder and categories. They are free: a save is marked and logged, not asked or announced; reading
// shows nothing a third party wrote, so it does not taint the run.
const notes = rowsOf("mcp__notes__", "notes", "heartbeat");
export const notesModule: ToolModule = {
  name: "notes",
  connection: { kind: "in-process", name: "notes", when: (ctx) => !!ctx.notesRead && ctx.offers("mcp__notes__read_note") },
  rows: [...notes("memory-read", "read_note journal", { attended: false }), ...notes("memory-told", "memory_changes_since_brief", { attended: false, who: ["owner"] }), ...notes("memory-write", "write_note", { attended: false })],
  free: true,
  trusted: true,
};
