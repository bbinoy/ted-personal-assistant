---
name: calendar
description: Use for reviewing the owner's calendar - listing the day's / week's events, flagging conflicts and overlaps, proposing reschedule slots, and creating calendar events from travel bookings. Part of the daily brief; also for ad-hoc "what's my day / find me a slot / is X on my calendar". Pairs with `ted-personal-assistant:mail`, `ted-personal-assistant:meeting-prep`, `ted-personal-assistant:daily-brief`.
---

# Calendar review

## Setup (from the owner's notes)

Which calendars to check, the time zone and which calendar travel bookings go on
are in the owner's `setup/calendars` note (the `setup` notes in your memory block
or `MEMORY.md`). Use exactly those; do not guess calendar ids.

**If the calendar tools (`list_calendars`, `list_calendar_events`) do not exist** (Mailbird is not running, or its MCP server is off), say so plainly, never guess or invent calendar data, skip this part, and in an unattended run end the brief with one line: "🔌 <connector> isn't connected, so calendar was skipped." In chat, add how to fix it: open Mailbird and check its MCP setting (the `ted-personal-assistant:mailbird` skill), then message you again.

**If there is no `setup/calendars` note:**
- in chat, load `ted-personal-assistant:setup` and set it up with the owner now;
- in an unattended run, call `list_calendars` and save the `setup/calendars` note yourself, as the setup skill says, then carry on and say so in one line.

A work calendar shared into one of the owner's accounts is one more listed calendar, handled like the private one with the same rules. A meeting with colleagues or about work goes on the work calendar (`calendarId`), a private event on the private one; which is which follows the mail skill's "Work and private accounts".

## The tools (Mailbird's calendar, over every calendar account the owner has)

- `list_calendars` first: it gives each calendar's `id` (the `calendarId` of the other tools), name, account, time zone and whether it is read-only.
- `list_calendar_events` takes `startUtc` and `endUtc` (UTC, ISO-8601 with a `Z`, e.g. `2026-05-03T00:00:00Z`) and optionally a `calendarId`; recurring events come expanded. Call it for **all of the listed calendars in the same turn** (they are independent). The note may list calendars that are **not** connected (a work account that cannot be added, say): those are invisible, so never assume the list is complete, and if a workday looks empty, say so.
- **Time zones.** Each event row has `startUtc`/`endUtc` (what the write tools take back, with `instanceStartUtc` for one occurrence) and, added for you, `start`/`end` in the owner's zone (a plain date for an all-day event): read those and say them as they are. To ask for a local day, convert its midnight and the next midnight to UTC (a day is not 24 hours across a clock change).
- `create_calendar_event` (`subject`, `startUtc`, `endUtc`, optionally `calendarId`, `timeZone`, `location`, `description`, `attendees`, `isAllDay`), `update_calendar_event` (`eventId` and only what changes; for one occurrence of a repeating event also `instanceStartUtc` and `scope`), `respond_to_calendar_event`, `delete_calendar_event` (no undo). There is no get-one-event tool: find an event by listing its day.
- **Guests are emailed only with `notifyAttendees: true` AND `confirm: true`.** The two are required arguments of the writes: pass both `false` for anything with nobody to notify (bookings, holds, the owner's own plans), and `true` only when the owner asked for the invitation (or the change or cancellation) to go out. Guests named without both true are only saved on the event, nobody is emailed.

With the Google Calendar connector instead of Mailbird (a Gmail setup), the tools are `list_calendars`, `list_events`, `get_event`, `create_event`, `update_event`, `respond_to_event` and `delete_event`: give `list_events` an explicit start/end range and the owner's time zone, event times in results are already in the owner's zone (read them as shown, never convert), and write `startTime`/`endTime` as full ISO times with the UTC offset of the place (no `timeZone`).

## Window

- **Daily brief run:** today + tomorrow (forward), and back to the previous
  brief's send time (for the post-meeting pass handoff to `ted-personal-assistant:meeting-prep`).

- **Heartbeat look:** the next 36 hours. Any run (a look or a chat turn) that reads the calendar for the next hours also tells code which meetings are coming with the `note_upcoming_meetings` tool (its instruction says how: the facts as the calendar gives them, you do not decide which deserve prep); code then sends the short prep shortly before each meeting with other people on it.

Produce a clean event list for the window - time, title, attendees,
location - and hand it to `ted-personal-assistant:meeting-prep`, which decides what needs prep.

## Conflicts and hygiene (flag in the brief; fix only the owner's own guest-less events, see Reschedules)

- Overlapping events.
- Back-to-back meetings with no gap, especially across locations.
- A meeting that collides with travel, or with a task due that day.
- An external meeting with no agenda / no video link.
- A day that is wall-to-wall with no break.

## Reschedules

If an email asks to move a meeting, or two things clash, propose 2-3
concrete alternative slots from the owner's actual free time (following the
owner's meeting preferences in their pages) in the brief. For an event with guests or other
people, do **not** call `update_calendar_event` on your own - the owner decides, then asks.
A clash among the owner's own guest-less events or placeholders is fixed
with `update_calendar_event`, in any run; say so in one line.

## Bookings -> calendar (the automatic write)

Any **confirmed** booking with a firm date and time that is **not already on the
calendar** goes on the owner's own calendar, whichever run finds it (a look handling
new mail, the daily brief's sweep, a chat): event and class tickets, orders for an
event, restaurant and venue reservations, appointments, flights, trains, hotels,
buses. The daily brief also scans recent booking confirmations via
`ted-personal-assistant:mail` `search_conversations`. For each one:

- "I booked X": find the mail in the newest inbox rows (`list_conversations`) as well as by keyword; the sender rarely uses the owner's words.
- If the date or time is only in the mail's attachment (a ticket, a confirmation PDF), open it first (`ted-personal-assistant:mail`) and never ask the owner for it.
- `create_calendar_event` on the calendar the setup note names for bookings (else the primary
  one; a work trip on the work calendar), with no guests: clear title ("Startup Nights 2026", "Flight ZRH -> BCN LX123",
  "Hotel: <name>, <city>", "Train <A> -> <B>", "Dinner at <place>"),
  correct start/end, location, and confirmation number + one-line summary in the
  description. Times: `startUtc` and `endUtc` are the real instants in UTC, worked out from the
  local time and the UTC offset of the place it happens in (a flight ZRH 10:30 -> LHR 11:20 local on
  3 May is `2026-05-03T08:30:00Z` to `2026-05-03T10:20:00Z`; a train
  within one time zone uses that zone's offset), and `timeZone` is the IANA zone the event is
  shown in (where it starts). Never copy a local time into `startUtc`: the two ends of a
  flight are in different time zones. Use the booking's own times, else the owner's time zone.
  The offset differs by DATE as well as place (daylight saving): the UK clocks change
  on the last Sunday of October, so on 31 Oct 2026 London is `+00:00` while Zurich is
  `+01:00`, whereas on 3 May both are on summer time (London `+01:00`, Zurich
  `+02:00`). Work out each offset for the actual date and place.
- Then load `ted-personal-assistant:follow-through`: the matching task, the confirmation mail, the travel time, the follow-up tasks.
- Note each created event in the brief under "Changed by the assistant".
- No firm date or time, or a likely duplicate: do not create. Keep the mail and mention it.

## Scheduling emails: think a step ahead (in chat, when the owner talks to you)

When an email asks about availability, proposes a time, or answers a time the owner suggested, do not just report it and ask what to do. Do the
whole job and ask once:

1. Check the owner's calendar yourself (`list_calendar_events`, the calendars in the setup note), including the travel time between the neighbouring events.
2. Draft the reply: if the proposed time is free, confirm it; if not, propose two or three concrete free slots. Write it in the owner's voice
   and language, ready to send.
3. Tell the owner in one short message what the mail says, what the calendar shows, the draft, and one thing worth knowing (a clash, a tight
   journey). End with one question: send it?
4. When the owner says yes, send, and add the matching event to their own calendar in the same step, without a second question. Say that you
   added it, so they can ask you to remove it. The one yes covers what you announced. Announce the calendar entry in the message from step 3.

Never invite other people or change an event that has guests without asking; the "one yes" covers only a new entry on the owner's own calendar.

**In a background run** (a look, the brief) nobody is asked: do steps 1 and 2, save the reply as an in-thread draft, put a tentative hold on the owner's own calendar (no guests, "Hold: <title>"), and `add_task` "send the reply to <name>" so it reaches the brief's "Focus today". The owner's later "send" is the only question.

## The owner's own events, nobody else on them (in chat)

"Put the visit to Rosa in my calendar on Saturday" is a plain request: create it at once on the owner's own
calendar, with no guests and no notifications, and do not ask first. When the day or the time is open, pick the most
likely reading yourself (the coming Saturday; a sensible time for that kind of thing, or an all-day event when no
time fits) and SAY in your reply which date and time you chose ("Saturday 9 May, 10:00-13:30; tell me if it's
another time"), so the owner can correct it with one word. Moving or editing one of the owner's own events that has
no guests works the same way. This is never a question to the owner: a wrong guess is fixed in a second. Inviting or
notifying anyone, another person's or a shared calendar, and deleting stay as below.

To invite someone by name ("invite Sam"), look for the address with `find_person` and `search_contacts` first, as your rules say; the invite still asks, with the guests shown, and goes out only with `notifyAttendees: true` and `confirm: true` once the owner has said yes.

## Cancelling, declining and deleting (in chat)

Before you act on an event, look it up by day and title (`list_calendar_events` for that day), so you know what it is and who organises it. Name it by title and time in anything you say ("the Embassy reception, Fri 15 May 18:00"), never by id.

- "Cancel it" or "I can't make it" for an event **someone else organises**: respond to the invitation as declined (`respond_to_calendar_event` with `response: "declined"`; it emails the organiser, so it asks the owner first and goes out with `confirm: true` only after that yes), with a short note in the owner's voice when it helps ("Sorry, I can't make it tonight."). Do not delete it: a delete tells the organiser nothing.
- Delete only an event the owner organises, or one that is the owner's own entry (nobody else on it); there is no undo.
- Deleting an event the owner organises that has guests: notify the guests (`notifyAttendees: true`, `confirm: true`; they would otherwise find out by themselves). It touches other people, so the owner is asked first; that is right.

## Guardrails

- May, in any run: create, move or edit an event on the owner's own calendar with nobody invited and no notifications (bookings, holds, own plans), and mention it.
- Stays a draft, task or suggestion: anything with guests or notifications, other people's events, invites and responses. Deleting stays a question (and `delete_calendar_event` is never unattended).
- Whole calendars (creating, renaming or deleting one) are not yours to manage: those tools are not offered.
- The agent's policy (`src/policy/policy.ts`) judges every calendar write: an event on the
  owner's own calendar with nobody invited is routine; one that invites or notifies people
  asks the owner, whatever this skill says.

## In the briefing

- **Conflicts / reschedules** section - only if there is something;
  each as a suggestion.
- Created travel events -> "Changed by the assistant".
- The meeting list itself is rendered by `ted-personal-assistant:meeting-prep`.
