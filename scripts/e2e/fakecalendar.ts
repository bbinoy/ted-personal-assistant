// The calendar and the contacts of the fake Mailbird of the end-to-end eval: Mailbird serves them from the same local MCP server as the mail (the `mailbird` server, fakemail.ts, which takes
// these tool definitions), with the real tool names and arguments (from the server's own tool list; the result shapes are written from its descriptions: events come back in UTC with the
// event's IANA zone, as list_calendar_events says).
import { z } from "zod";
import { instantOf, type Recorder, type ToolDef } from "./fakeserver.ts";

// An event of the world a case starts from. Times: a full ISO time with its offset, or a wall time in `zone` (default: the calendar's).
export interface SeedEvent {
  summary: string;
  start: string;
  end: string;
  zone?: string;
  location?: string;
  description?: string;
  attendees?: string[]; // email addresses
}

export interface CalEvent {
  id: string;
  summary: string;
  startMs: number;
  endMs: number;
  zone: string;
  allDay: boolean;
  location?: string;
  description?: string;
  attendees: string[];
  invited: string[]; // every address that was sent an invitation by a call (a seed event's guests were invited long ago and are not here)
  response?: string; // how the owner answered an invitation (respond_to_calendar_event)
  createdByCall: boolean;
}

interface Contact {
  id: string;
  firstName?: string;
  lastName?: string;
  emails: string[];
  phones: string[];
  organization?: string;
  jobTitle?: string;
  note?: string;
}

const guestSchema = z.union([z.string(), z.object({ email: z.string() }).passthrough()]);
const emailOf = (g: z.infer<typeof guestSchema>): string => (typeof g === "string" ? g : g.email).toLowerCase();
const utcOf = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

export class FakeCalendar {
  events: CalEvent[] = [];
  contacts: Contact[] = [];
  readonly defs: Record<string, ToolDef>;
  private next = 1;
  readonly zone: string;

  constructor(_rec: Recorder, zone: string, ownerEmail: string, seed: SeedEvent[] = [], _now: () => number = Date.now, readDelayMs = 0) {
    this.zone = zone;
    for (const s of seed) this.events.push({ id: this.newId(), summary: s.summary, startMs: instantOf(s.start, s.zone ?? zone), endMs: instantOf(s.end, s.zone ?? zone), zone: s.zone ?? zone, allDay: false, location: s.location, description: s.description, attendees: (s.attendees ?? []).map((a) => a.toLowerCase()), invited: [], createdByCall: false });
    const shown = (e: CalEvent) => ({
      id: e.id,
      calendarId: "cal-1",
      subject: e.summary,
      startUtc: utcOf(e.startMs),
      endUtc: utcOf(e.endMs),
      timeZone: e.zone,
      isAllDay: e.allDay,
      ...(e.description ? { description: e.description } : {}),
      ...(e.location ? { location: e.location } : {}),
      organizer: ownerEmail,
      ...(e.attendees.length ? { attendees: e.attendees.map((a) => ({ email: a })) } : {}),
      ...(e.response ? { responseStatus: e.response } : {}),
    });
    const find = (id: string) => this.events.find((e) => e.id === id) ?? (() => { throw new Error(`Event not found: ${id}`); })();
    const emailsGone = (a: { notifyAttendees?: boolean; confirm?: boolean }) => a.notifyAttendees === true && a.confirm === true; // guests are emailed only with both
    const times = (a: { startUtc?: string; endUtc?: string; timeZone?: string; isAllDay?: boolean }, old?: CalEvent) => {
      const startMs = a.startUtc !== undefined ? Date.parse(a.startUtc) : old!.startMs;
      const endMs = a.endUtc !== undefined ? Date.parse(a.endUtc) : a.startUtc !== undefined ? startMs + 3_600_000 : old!.endMs;
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new Error("startUtc and endUtc are UTC ISO-8601 times like 2026-11-01T10:00:00Z");
      return { zone: a.timeZone ?? old?.zone ?? zone, allDay: a.isAllDay ?? old?.allDay ?? false, startMs, endMs };
    };
    const notify = { notifyAttendees: z.boolean(), confirm: z.boolean() };

    this.defs = {
      list_calendars: { description: "List the user's calendars across every connected calendar account.", shape: {}, run: () => ({ calendars: [{ id: "cal-1", name: "Calendar", accountId: 1, account: ownerEmail, timeZone: zone, accessRole: "owner", isReadOnly: false }] }) },
      list_calendar_events: {
        delayMs: readDelayMs,
        description: "List calendar events in a UTC time window, optionally for one calendar.",
        shape: { startUtc: z.string(), endUtc: z.string(), calendarId: z.string().optional(), limit: z.number().optional() },
        run: (a) => {
          const from = Date.parse(a.startUtc);
          const to = Date.parse(a.endUtc);
          if (Number.isNaN(from) || Number.isNaN(to)) throw new Error("startUtc and endUtc are UTC ISO-8601 times like 2026-11-01T00:00:00Z");
          return { events: this.events.filter((e) => e.endMs > from && e.startMs < to).sort((x, y) => x.startMs - y.startMs).slice(0, a.limit ?? 200).map(shown) };
        },
      },
      create_calendar_event: {
        description: "Create a calendar event. Guests are emailed an invitation only with notifyAttendees: true AND confirm: true.",
        shape: {
          subject: z.string(),
          startUtc: z.string(),
          endUtc: z.string(),
          calendarId: z.string().optional(),
          isAllDay: z.boolean().optional(),
          timeZone: z.string().optional(),
          description: z.string().optional(),
          location: z.string().optional(),
          attendees: z.array(guestSchema).optional(),
          recurrence: z.string().optional(),
          ...notify,
        },
        run: (a) => {
          const t = times(a);
          const guests = (a.attendees ?? []).map(emailOf);
          const e: CalEvent = { id: this.newId(), summary: a.subject, ...t, location: a.location, description: a.description, attendees: guests, invited: emailsGone(a) ? guests : [], createdByCall: true };
          this.events.push(e);
          return shown(e);
        },
      },
      update_calendar_event: {
        description: "Change an existing calendar event: only the fields given change; `attendees` replaces the guest list. Guests are emailed only with notifyAttendees: true AND confirm: true.",
        shape: {
          eventId: z.string(),
          instanceStartUtc: z.string().optional(),
          scope: z.string().optional(),
          subject: z.string().optional(),
          description: z.string().optional(),
          location: z.string().optional(),
          startUtc: z.string().optional(),
          endUtc: z.string().optional(),
          isAllDay: z.boolean().optional(),
          timeZone: z.string().optional(),
          calendarId: z.string().optional(),
          attendees: z.array(guestSchema).optional(),
          recurrence: z.string().optional(),
          ...notify,
        },
        run: (a) => {
          const e = find(a.eventId);
          if (a.startUtc !== undefined || a.endUtc !== undefined || a.timeZone !== undefined || a.isAllDay !== undefined) Object.assign(e, times(a, e));
          if (a.subject !== undefined) e.summary = a.subject;
          for (const k of ["location", "description"] as const) if (a[k] !== undefined) e[k] = a[k];
          if (a.attendees !== undefined) {
            const guests: string[] = a.attendees.map(emailOf);
            if (emailsGone(a)) e.invited.push(...guests.filter((g: string) => !e.attendees.includes(g) && !e.invited.includes(g)));
            e.attendees = guests;
          }
          return shown(e);
        },
      },
      respond_to_calendar_event: {
        description: "Answer an invitation: accepted, declined or tentative. The answer is sent to the organizer, so it requires confirm: true.",
        shape: { eventId: z.string(), instanceStartUtc: z.string().optional(), response: z.enum(["accepted", "declined", "tentative"]), scope: z.string().optional(), confirm: z.boolean() },
        run: (a) => {
          if (a.confirm !== true) throw new Error("respond_to_calendar_event needs confirm: true");
          find(a.eventId).response = a.response;
          return { status: "sent", response: a.response };
        },
      },
      delete_calendar_event: {
        description: "Delete a calendar event. There is no undo. Guests are emailed a cancellation only with notifyAttendees: true AND confirm: true.",
        shape: { eventId: z.string(), instanceStartUtc: z.string().optional(), scope: z.string().optional(), ...notify },
        run: (a) => {
          const e = find(a.eventId);
          this.events = this.events.filter((x) => x !== e);
          return `Event deleted. ${e.attendees.length && emailsGone(a) ? "Cancellations were sent to its guests." : "No one was emailed."}`;
        },
      },
      search_contacts: {
        description: "Find someone in the user's synced address book by name or email.",
        shape: { query: z.string(), limit: z.number().optional() },
        run: (a) => ({ contacts: this.contacts.filter((c) => `${c.firstName ?? ""} ${c.lastName ?? ""} ${c.emails.join(" ")}`.toLowerCase().includes(String(a.query).toLowerCase())).slice(0, a.limit ?? 20) }),
      },
      create_contact: {
        description: "Add a new person to the user's address book.",
        shape: { firstName: z.string().optional(), lastName: z.string().optional(), emails: z.array(z.string()).optional(), phones: z.array(z.string()).optional(), organization: z.string().optional(), jobTitle: z.string().optional(), note: z.string().optional(), accountId: z.number().optional() },
        run: (a) => {
          const { accountId: _a, ...rest } = a;
          const c: Contact = { id: `ct${this.contacts.length + 1}`, ...rest, emails: a.emails ?? [], phones: a.phones ?? [] };
          this.contacts.push(c);
          return c;
        },
      },
      update_contact: {
        description: "Change a contact: only the values passed change; emails and phones replace the whole list.",
        shape: { contactId: z.string(), firstName: z.string().optional(), lastName: z.string().optional(), emails: z.array(z.string()).optional(), phones: z.array(z.string()).optional(), organization: z.string().optional(), jobTitle: z.string().optional(), note: z.string().optional() },
        run: (a) => {
          const { contactId, ...rest } = a;
          const c = this.contacts.find((x) => x.id === contactId) ?? (() => { throw new Error(`Contact not found: ${contactId}`); })();
          return Object.assign(c, rest);
        },
      },
      delete_contact: {
        description: "Delete a contact from the user's address book. There is no undo.",
        shape: { contactId: z.string() },
        run: (a) => {
          this.contacts = this.contacts.filter((c) => c.id !== a.contactId);
          return "Contact deleted.";
        },
      },
    };
  }

  private newId = (): string => `evt${String(this.next++).padStart(4, "0")}`;

  // The events a call created or left standing, for the state checks.
  final(): CalEvent[] {
    return this.events.map((e) => ({ ...e }));
  }
}
