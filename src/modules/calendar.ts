import { rowsOf, type ToolModule } from "./types.ts";

// Google Calendar, through the owner's claude.ai connector.
const CAL = "mcp__claude_ai_Google_Calendar__";

// The floor for events: a calendar write that names attendees, guests, invitees or recipients is never judged (it would email people), and an EXISTING event
// may have guests who would be emailed by an update even when the call names nobody, which is why the judge is told so in the Notifies line.
const PEOPLE_FIELD = /^(attendees?|guests?|invitees?|recipients?)$/i;
export const namesNobody = (v: unknown): boolean => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

// Pure: for a calendar write, one line for the judge (not the owner) saying whether this call names guests or asks for notifications. It only
// reads the call's own arguments; whether an existing event has guests is not known here.
const NOTIFY_FIELD = /^(notificationLevel|sendUpdates|send_updates|sendNotifications|notifyAttendees)$/i;
export function notifyLine(input: Record<string, unknown>): string {
  const people = Object.entries(input).filter(([k, v]) => PEOPLE_FIELD.test(k) && !namesNobody(v)).length;
  const notify = Object.entries(input).filter(([k]) => NOTIFY_FIELD.test(k)).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
  return `\nNotifies: ${people ? "this call names guests" : "this call names no guests"}${notify.length ? `; ${notify.join(", ")}` : "; this call asks for no notifications"} (guests already on an existing event are not shown here)`;
}

const cal = rowsOf(CAL, "calendar", "calendar");
// A calendar write that names no guest (the owner's connector, and a friend's Google server: modules/google.ts).
export const namesNoGuests = (input: Record<string, unknown>): boolean => Object.entries(input).every(([k, v]) => !PEOPLE_FIELD.test(k) || namesNobody(v));

export const calendarModule: ToolModule = {
  name: "calendar",
  connection: { kind: "connector", key: "calendar", server: /google calendar/i, prefix: CAL },
  rows: [
    ...cal("read", "list_calendars list_events get_event search_events suggest_time"),
    ...cal("calendar-write", "create_event update_event"), // the guest floor is below
    ...cal("calendar-respond", "respond_to_event"),
  ],
  free: ["read"],
  titles: {
    [`${CAL}create_event`]: { icon: "📅", title: "Create calendar event" },
    [`${CAL}update_event`]: { icon: "📅", title: "Change calendar event" },
    [`${CAL}respond_to_event`]: { icon: "📅", title: "Respond to invite" },
  },
  floor: {
    judgeVeto: { "calendar-write": namesNoGuests },
    noFix: ["calendar-respond"], // answering an invite is the owner's call, not a matter of wrong arguments
    judgeNote: { "calendar-write": notifyLine },
    editable: ["calendar-write"], // "yes, but make it 16:00" may edit an event
  },
  skills: [{ name: "calendar", required: true }],
  setup: [{ file: "setup-calendars.md", label: "calendars (which to check, time zone)", needs: "calendar" }],
};
