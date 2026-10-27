import { settings } from "../../core/settings.ts";
import { rowsOf, type ToolModule } from "../types.ts";

// meetings (meetingtools.ts): note_upcoming_meetings, the heartbeat look's way of telling code which meetings are coming up, so that code can have one short prep message written shortly before each
// (heartbeat/preptick.ts claims them, the look says them). Only an UNATTENDED look has it (the owner's "background" run, or a friend's look when her set has a calendar); chat does not. It writes that conversation's own
// `meetings` table and nothing else, so it is free: nothing to judge, nothing to ask. Off (no tool, no server) while PREP_MINUTES is 0.
const rows = rowsOf("mcp__meetings__", "meetings", "calendar")("meeting-note", "note_upcoming_meetings", { attended: false });
export const meetingsModule: ToolModule = {
  name: "meetings",
  connection: {
    kind: "in-process",
    name: "meetings",
    // The owner's look is the "background" source; a friend's look is an isolated "group" run that has no chat memory (her chat has it). A group has no calendar capability, so it never has the row.
    when: (ctx) => settings.prepMinutes > 0 && ctx.offers("mcp__meetings__note_upcoming_meetings"),
  },
  rows,
  free: true,
};
