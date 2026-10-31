// The fake Google Calendar of the end-to-end eval: the owner's claude.ai connector under its real name, with the tool names and result shapes of the real one (shapes copied from tool results, never content).
import { z } from "zod";
import { fakeService, instantOf, isoIn, type FakeService, type Recorder } from "./fakeserver.ts";

export const CALENDAR_SERVER = "claude.ai Google Calendar";

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
  createdByCall: boolean;
}

const guestSchema = z.union([z.string(), z.object({ email: z.string() }).passthrough()]);
const emailOf = (g: z.infer<typeof guestSchema>): string => (typeof g === "string" ? g : g.email).toLowerCase();

export class FakeCalendar {
  events: CalEvent[] = [];
  readonly service: FakeService;
  private next = 1;
  readonly zone: string;

  constructor(rec: Recorder, zone: string, ownerEmail: string, seed: SeedEvent[] = [], now: () => number = Date.now) {
    this.zone = zone;
    for (const s of seed) this.events.push({ id: this.newId(), summary: s.summary, startMs: instantOf(s.start, s.zone ?? zone), endMs: instantOf(s.end, s.zone ?? zone), zone: s.zone ?? zone, allDay: false, location: s.location, description: s.description, attendees: (s.attendees ?? []).map((a) => a.toLowerCase()), invited: [], createdByCall: false });
    const shown = (e: CalEvent) => ({
      kind: "calendar#event",
      id: e.id,
      status: "confirmed",
      htmlLink: `https://calendar.example.com/event?eid=${e.id}`,
      created: new Date(now()).toISOString(),
      updated: new Date(now()).toISOString(),
      summary: e.summary,
      ...(e.description ? { description: e.description } : {}),
      ...(e.location ? { location: e.location } : {}),
      creator: { email: ownerEmail, self: true },
      organizer: { email: ownerEmail, self: true },
      start: e.allDay ? { date: isoIn(e.startMs, e.zone).slice(0, 10) } : { dateTime: isoIn(e.startMs, e.zone), timeZone: e.zone },
      end: e.allDay ? { date: isoIn(e.endMs, e.zone).slice(0, 10) } : { dateTime: isoIn(e.endMs, e.zone), timeZone: e.zone },
      ...(e.attendees.length ? { attendees: [{ email: ownerEmail, organizer: true, self: true, responseStatus: "accepted" }, ...e.attendees.map((a) => ({ email: a, responseStatus: "needsAction" }))] } : {}),
      eventType: "default",
      useDefaultReminders: true,
    });
    const within = (e: CalEvent, from?: string, to?: string) => (!from || e.endMs > instantOf(from, zone)) && (!to || e.startMs < instantOf(to, zone));
    const listed = (events: CalEvent[]) => ({ accessRole: "owner", defaultReminders: [{ method: "popup", minutes: 10 }], events: events.sort((a, b) => a.startMs - b.startMs).map(shown), summary: ownerEmail, timeZone: zone, updated: new Date(now()).toISOString() });
    const find = (id: string) => this.events.find((e) => e.id === id) ?? (() => { throw new Error(`Event not found: ${id}`); })();
    const times = (a: { startTime?: string; endTime?: string; timeZone?: string }, old?: CalEvent) => {
      const z = a.timeZone ?? old?.zone ?? zone;
      const allDay = a.startTime !== undefined ? !a.startTime.includes("T") : (old?.allDay ?? false);
      const startMs = a.startTime !== undefined ? instantOf(a.startTime, z) : old!.startMs;
      const endMs = a.endTime !== undefined ? instantOf(a.endTime, z) : a.startTime !== undefined ? startMs + (allDay ? 86_400_000 : 3_600_000) : old!.endMs;
      return { z, allDay, startMs, endMs };
    };

    this.service = fakeService(CALENDAR_SERVER, rec, {
      list_calendars: { description: "List the calendars the user can see.", shape: {}, run: () => ({ calendars: [{ id: "primary", summary: ownerEmail, primary: true, accessRole: "owner", timeZone: zone }] }) },
      list_events: {
        description: "List events in a time range (RFC3339 or local ISO times).",
        shape: { startTime: z.string().optional(), endTime: z.string().optional(), calendarId: z.string().optional(), timeZone: z.string().optional(), orderBy: z.string().optional(), maxResults: z.number().optional(), q: z.string().optional() },
        run: (a) => listed(this.events.filter((e) => within(e, a.startTime, a.endTime) && (!a.q || `${e.summary} ${e.description ?? ""}`.toLowerCase().includes(String(a.q).toLowerCase())))),
      },
      search_events: {
        description: "Search events by text.",
        shape: { query: z.string(), calendarId: z.string().optional(), startTime: z.string().optional(), endTime: z.string().optional() },
        run: (a) => listed(this.events.filter((e) => within(e, a.startTime, a.endTime) && String(a.query).toLowerCase().split(/\s+/).every((w) => `${e.summary} ${e.location ?? ""} ${e.description ?? ""} ${e.attendees.join(" ")}`.toLowerCase().includes(w)))),
      },
      get_event: { description: "Get one event by id.", shape: { eventId: z.string(), calendarId: z.string().optional() }, run: (a) => shown(find(a.eventId)) },
      create_event: {
        description: "Create an event. Guests in `attendees` are sent an invitation.",
        shape: {
          summary: z.string(),
          startTime: z.string(),
          endTime: z.string().optional(),
          timeZone: z.string().optional(),
          location: z.string().optional(),
          description: z.string().optional(),
          calendarId: z.string().optional(),
          attendees: z.array(guestSchema).optional(),
          notificationLevel: z.string().optional(),
        },
        run: (a) => {
          const t = times(a);
          const guests = (a.attendees ?? []).map(emailOf);
          const e: CalEvent = { id: this.newId(), summary: a.summary, startMs: t.startMs, endMs: t.endMs, zone: t.z, allDay: t.allDay, location: a.location, description: a.description, attendees: guests, invited: String(a.notificationLevel ?? "").toUpperCase() === "NONE" ? [] : guests, createdByCall: true };
          this.events.push(e);
          return shown(e);
        },
      },
      update_event: {
        description: "Change an event. Only the fields given change; `attendees` replaces the guest list.",
        shape: {
          eventId: z.string(),
          calendarId: z.string().optional(),
          summary: z.string().optional(),
          startTime: z.string().optional(),
          endTime: z.string().optional(),
          timeZone: z.string().optional(),
          location: z.string().optional(),
          description: z.string().optional(),
          attendees: z.array(guestSchema).optional(),
          notificationLevel: z.string().optional(),
        },
        run: (a) => {
          const e = find(a.eventId);
          if (a.startTime !== undefined || a.endTime !== undefined || a.timeZone !== undefined) Object.assign(e, { ...(({ z, ...r }) => ({ zone: z, ...r }))(times(a, e)) });
          for (const k of ["summary", "location", "description"] as const) if (a[k] !== undefined) e[k] = a[k];
          if (a.attendees !== undefined) {
            const guests: string[] = a.attendees.map(emailOf);
            if (String(a.notificationLevel ?? "").toUpperCase() !== "NONE") e.invited.push(...guests.filter((g: string) => !e.attendees.includes(g) && !e.invited.includes(g)));
            e.attendees = guests;
          }
          return shown(e);
        },
      },
      delete_event: {
        description: "Delete an event.",
        shape: { eventId: z.string(), calendarId: z.string().optional(), notificationLevel: z.string().optional() },
        run: (a) => {
          const e = find(a.eventId);
          this.events = this.events.filter((x) => x !== e);
          return `Event deleted. ${e.attendees.length ? "Cancellations were sent to its guests." : "It had no guests."}`;
        },
      },
    });
  }

  private newId = (): string => `evt${String(this.next++).padStart(4, "0")}`;

  // The events a call created or left standing, for the state checks.
  final(): CalEvent[] {
    return this.events.map((e) => ({ ...e }));
  }
}
