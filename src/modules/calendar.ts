import { namesPeople, notifyLine } from "../policy/guests.ts";
import { DELETE_CONFIRM } from "../policy/neverallowed.ts";
import { rowsOf, type ModuleFloor, type ToolModule } from "./types.ts";

// The owner's calendar goes with the mail client (types.ts `withMail`): Mailbird's own calendar with Mailbird (mailbird/calendar.ts), and with Gmail or no mail
// the owner's Google Calendar through the claude.ai connector, below (it reaches the one Google account the connector is signed in to). Both say the same about their
// rows (`calendarFloor`) and are recorded as the connection "calendar".

// The floor for events: a calendar write that names attendees, guests, invitees or recipients (whatever the field is called: attendees, attendeeEmails,
// addedAttendees, addedAttendeeEmails, ...; guests.ts namesPeople) is judged like a mail send: in a run that read untrusted mail or pages, a guest the person's
// words do not name is asked (permissions.ts). A delete that names guests or asks to notify them (notifyAttendees) would email a cancellation: never judged. An EXISTING
// event may have guests who would be emailed by an update even when the call names nobody, which is why the judge is told so in the Notifies line.
const notifies = (input: Record<string, unknown>): boolean => namesPeople(input) || input.notifyAttendees === true || input.notifyAttendees === "true";
export const calendarFloor = (create: string): ModuleFloor => ({
  judgeVeto: { [DELETE_CONFIRM]: (input) => !notifies(input) }, // a delete that emails guests a cancellation: the owner's call
  creates: (name) => name === create, // (its result's event id names it in a later question and the journal)
  noFix: ["calendar-respond"], // answering an invite is the owner's call, not a matter of wrong arguments
  judgeNote: { "calendar-write": notifyLine, [DELETE_CONFIRM]: notifyLine },
  editable: ["calendar-write"], // "yes, but make it 16:00" may edit an event
});

// Google Calendar, through the owner's claude.ai connector (every MAIL_PROVIDER but mailbird).
const CAL = "mcp__claude_ai_Google_Calendar__";
const cal = rowsOf(CAL, "calendar", "calendar");

export const googleCalendarModule: ToolModule = {
  name: "calendar",
  withMail: ["gmail", "none"],
  connection: { kind: "connector", key: "calendar", label: "Google Calendar", skipped: "the calendar review and the meeting list", server: /google calendar/i, prefix: CAL },
  rows: [
    ...cal("read", "list_calendars list_events get_event search_events suggest_time"),
    ...cal("calendar-write", "create_event update_event"), // the guest floor is calendarFloor
    ...cal("calendar-respond", "respond_to_event"),
    ...cal(DELETE_CONFIRM, "delete_event"), // a destructive action the judge handles with care (neverallowed.ts DELETE_CONFIRM)
  ],
  free: ["read"],
  titles: {
    [`${CAL}create_event`]: { icon: "📅", title: "Create calendar event" },
    [`${CAL}update_event`]: { icon: "📅", title: "Change calendar event" },
    [`${CAL}respond_to_event`]: { icon: "📅", title: "Respond to invite" },
    [`${CAL}delete_event`]: { icon: "🗑️", title: "Delete calendar event", labels: { eventId: "Event", calendarId: "Calendar" } },
  },
  floor: calendarFloor("create_event"),
  skills: [{ name: "calendar", required: true }],
  setup: [{ file: "setup/calendars.md", label: "calendars (which to check, time zone)", needs: "calendar" }],
  hide: { prefix: CAL, visible: "list_calendars list_events get_event search_events suggest_time create_event update_event respond_to_event delete_event".split(" "), valid: /^[a-z_]+$/, hint: "a Google Calendar tool name like list_events" }, // (the whole connector is hidden while MAIL_PROVIDER is mailbird)
};
