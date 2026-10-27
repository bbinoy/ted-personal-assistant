import { settings } from "../../core/settings.ts";
import { rowsOf, type ToolModule } from "../types.ts";

// meetings (meetingtools.ts): note_upcoming_meetings, the heartbeat look's way of telling code which meetings are coming up, so that code can have one short prep message written shortly before each
// (heartbeat/preptick.ts claims them, the look says them). Every run whose capability set has the calendar has it (a chat turn that reads the next hours too: only a model run can read the calendar, so
// whichever run does, records). It writes that conversation's own
// `meetings` table and nothing else, so it is free: nothing to judge, nothing to ask. Off (no tool, no server) while PREP_MINUTES is 0.
const rows = rowsOf("mcp__meetings__", "meetings", "calendar")("meeting-note", "note_upcoming_meetings");
export const meetingsModule: ToolModule = {
  name: "meetings",
  connection: {
    kind: "in-process",
    name: "meetings",
    // The capability gates it (a group has no calendar, so it never has the row), not whether the run is attended.
    when: (ctx) => settings.prepMinutes > 0 && ctx.offers("mcp__meetings__note_upcoming_meetings"),
  },
  rows,
  free: true,
};
