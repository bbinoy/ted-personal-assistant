import { DELETE_CONFIRM } from "../../policy/neverallowed.ts";
import { calendarFloor } from "../calendar.ts";
import { rowsOf, type ToolModule } from "../types.ts";

// The calendar of Mailbird (MAIL_PROVIDER=mailbird), served by the same local MCP server as the mail, over every calendar account the owner has. A module of its own
// because the connection is recorded as "calendar" (the calendar review, meeting prep and setup ask for it), while the mail is "mail"; which tools the model sees is
// the mailbird module's `hide`. Its floor is the one of every calendar (calendarFloor): guests are emailed only with notifyAttendees AND confirm, and the floor reads both.
const MB = "mcp__mailbird__";
const cal = rowsOf(MB, "mailbird", "calendar");

// Left out of the rows on purpose: create_calendar, update_calendar and delete_calendar. Ted has no need to manage calendar containers (delete_calendar removes a calendar
// and every event in it, no undo), so they have no row and are not visible (the mailbird module's `hide`); delete_calendar is also denied by its name (neverallowed.ts).
export const mailbirdCalendarModule: ToolModule = {
  name: "mailbird-calendar",
  withMail: ["mailbird"],
  connection: { kind: "connector", key: "calendar", label: "Mailbird calendar", skipped: "the calendar review and the meeting list", server: /^mailbird$/i, prefix: MB },
  rows: [
    ...cal("read", "list_calendars list_calendar_events"),
    ...cal("calendar-write", "create_calendar_event update_calendar_event"),
    ...cal("calendar-respond", "respond_to_calendar_event"), // emails the organizer: confirm true, after the approval
    ...cal(DELETE_CONFIRM, "delete_calendar_event"), // no undo
  ],
  free: ["read"],
  titles: {
    [`${MB}create_calendar_event`]: { icon: "📅", title: "Create calendar event" },
    [`${MB}update_calendar_event`]: { icon: "📅", title: "Change calendar event" },
    [`${MB}respond_to_calendar_event`]: { icon: "📅", title: "Respond to invite", labels: { eventId: "Event" } },
    [`${MB}delete_calendar_event`]: { icon: "🗑️", title: "Delete calendar event", labels: { eventId: "Event" } },
  },
  floor: calendarFloor("create_calendar_event"),
  skills: [{ name: "calendar", required: true }],
  setup: [{ file: "setup/calendars.md", label: "calendars (which to check, time zone)", needs: "calendar" }],
};
