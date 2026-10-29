import { namesNoGuests, namesPeople } from "../policy/guests.ts";
import { DELETE_CONFIRM } from "../policy/neverallowed.ts";
import { rowsOf, type ToolModule } from "./types.ts";

// Google Calendar, through the owner's claude.ai connector.
const CAL = "mcp__claude_ai_Google_Calendar__";

// The floor for events: a calendar write that names attendees, guests, invitees or recipients (whatever the field is called: attendees, attendeeEmails,
// addedAttendees, addedAttendeeEmails, ...; guests.ts namesPeople) is never judged, since it would email people. An EXISTING event may have guests who would be
// emailed by an update even when the call names nobody, which is why the judge is told so in the Notifies line.
;

// Pure: for a calendar write, one line for the judge (not the owner) saying whether this call names guests or asks for notifications. It only
// reads the call's own arguments; whether an existing event has guests is not known here.
const NOTIFY_FIELD = /^(notificationLevel|sendUpdates|send_updates|sendNotifications|notifyAttendees)$/i;
export function notifyLine(input: Record<string, unknown>): string {
  const notify = Object.entries(input).filter(([k]) => NOTIFY_FIELD.test(k)).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
  return `\nNotifies: ${namesPeople(input) ? "this call names guests" : "this call names no guests"}${notify.length ? `; ${notify.join(", ")}` : "; this call asks for no notifications"} (guests already on an existing event are not shown here)`;
}

const cal = rowsOf(CAL, "calendar", "calendar");

export const calendarModule: ToolModule = {
  name: "calendar",
  connection: { kind: "connector", key: "calendar", label: "Google Calendar", skipped: "the calendar review and the meeting list", server: /google calendar/i, prefix: CAL },
  rows: [
    ...cal("read", "list_calendars list_events get_event search_events suggest_time"),
    ...cal("calendar-write", "create_event update_event"), // the guest floor is below
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
  floor: {
    judgeVeto: { "calendar-write": namesNoGuests, [DELETE_CONFIRM]: namesNoGuests }, // a delete that names guests would email a cancellation: the owner's call
    creates: (name) => name === "create_event", // (its result's event id is "created by the assistant", for the judge's care with a delete)
    noFix: ["calendar-respond"], // answering an invite is the owner's call, not a matter of wrong arguments
    judgeNote: { "calendar-write": notifyLine, [DELETE_CONFIRM]: notifyLine },
    editable: ["calendar-write"], // "yes, but make it 16:00" may edit an event
  },
  skills: [{ name: "calendar", required: true }],
  setup: [{ file: "setup-calendars.md", label: "calendars (which to check, time zone)", needs: "calendar" }],
};
