import { rowsOf, type ToolModule } from "../types.ts";

// status (statusnote.ts): the heartbeat run's and its experts' one note write, for status-<name> notes (the daily brief's record of whether it went out). // owner run has it (an unattended owner run: the look; its expert makes the same calls through the same canUseTool); chat has the SDK's file tools for notes, a group or
// a friend neither. It writes in the owner's notes folder and nowhere else, and the name is a pattern, so it cannot touch any other note.
const status = rowsOf("mcp__status__", "status", "chat");
export const statusModule: ToolModule = {
  name: "status",
  connection: { kind: "in-process", name: "status", when: (ctx) => ctx.offers("mcp__status__write_status_note") },
  rows: status("status-note", "write_status_note", { attended: false, who: ["owner"] }),
  free: true, // the assistant's own record in its own folder: nothing for the owner to approve
};
