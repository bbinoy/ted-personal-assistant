---
name: calendar
description: Use for reviewing the owner's Google Calendar - listing the day's / week's events, flagging conflicts and overlaps, proposing reschedule slots, and creating calendar events from travel bookings. Part of the daily brief; also for ad-hoc "what's my day / find me a slot / is X on my calendar". Pairs with `ted-personal-assistant:mailbird`, `ted-personal-assistant:meeting-prep`, `ted-personal-assistant:daily-brief`.
---

# Calendar review

## Setup (from the owner's notes)

Which calendars to check, the time zone and which calendar travel bookings go on
are in the owner's `setup-calendars` note (the `setup` notes in your memory block
or `MEMORY.md`). Use exactly those; do not guess calendar ids.

**If the calendar tools (`list_calendars`, `list_events`) do not exist** (the connector is not connected in the owner's Claude account), say so plainly, never guess or invent calendar data, skip this part, and in an unattended run end the brief with one line: "🔌 <connector> isn't connected, so calendar was skipped." In chat, add how to fix it: connect it under Settings, Connectors in their Claude account, then message you again.

**If there is no `setup-calendars` note:**
- in chat, load `ted-personal-assistant:setup` and set it up with the owner now;
- in an unattended run (nobody to ask), skip the calendar parts, and end the brief
  with one line: "Calendar is not set up yet. Message me 'set up my calendar'."

Google Calendar via MCP. Call `list_events` with an explicit start/end range and
the owner's time zone, for **all of the listed calendars in the same turn** (they
are independent). The note may list calendars that are **not** connected (a work
account that cannot be added, say): those are invisible, so never assume the list
is complete, and if a workday looks empty, say so.

## Window

- **Daily brief run:** today + tomorrow (forward), and back to the previous
  brief's send time (for the post-meeting pass handoff to `ted-personal-assistant:meeting-prep`).

- **Heartbeat look:** the next 36 hours. Any run (a look or a chat turn) that reads the calendar for the next hours also tells code which meetings are coming with the `note_upcoming_meetings` tool (its instruction says how); code then sends the short prep shortly before each meeting that has other people on it. Pass the facts as the calendar gives them (id, start and end with the UTC offset, everyone on the invite, the video link, the owner's own response, private or not); do not decide yourself which meetings deserve prep.

Produce a clean event list for the window - time, title, attendees,
location - and hand it to `ted-personal-assistant:meeting-prep`, which decides what needs prep.

## Conflicts and hygiene (flag in the brief, never fix)

- Overlapping events.
- Back-to-back meetings with no gap, especially across locations.
- A meeting that collides with travel, or with a task due that day.
- An external meeting with no agenda / no video link.
- A day that is wall-to-wall with no break.

## Reschedules (suggest only, never execute)

If an email asks to move a meeting, or two things clash, propose 2-3
concrete alternative slots from the owner's actual free time in the brief.
Do **not** call `update_event` on your own - the owner decides, then asks.

## Bookings -> calendar (the automatic write)

Any **confirmed** booking with a firm date and time that is **not already on the
calendar** goes on the owner's own calendar, whichever run finds it (a look handling
new mail, the daily brief's sweep, a chat): event and class tickets, orders for an
event, restaurant and venue reservations, appointments, flights, trains, hotels,
buses. The daily brief also scans recent booking confirmations via
`ted-personal-assistant:mailbird` `search_conversations`. For each one:

- `create_event` on the calendar the setup note names for bookings (else the primary
  one), with no guests: clear title ("Startup Nights 2026", "Flight ZRH -> BCN LX123",
  "Hotel: <name>, <city>", "Train <A> -> <B>", "Dinner at <place>"),
  correct start/end, location, and confirmation number + one-line summary in the
  description. Times: write each of `startTime` and `endTime` as a full ISO time with
  the UTC offset of the place it happens in (a flight ZRH 10:30 -> LHR 11:20 local on
  21 Oct is `2026-10-21T10:30:00+02:00` to `2026-10-21T11:20:00+01:00`; a train
  within one time zone uses that zone's offset). Do NOT set `timeZone` (it overrides
  the offsets), and never send two local times without offsets: the two ends of a
  flight are in different time zones, and an event with mixed times is held back for
  the owner's approval. Use the booking's own times, else the owner's time zone.
  The offset differs by DATE as well as place (daylight saving): the UK clocks change
  on the last Sunday of October, so on 31 Oct 2026 London is `+00:00` while Zurich is
  `+01:00`, whereas on 21 Oct both are on summer time (London `+01:00`, Zurich
  `+02:00`). Work out each offset for the actual date and place.
- Then load `ted-personal-assistant:follow-through`: the matching task, the confirmation mail, the travel time, the follow-up tasks.
- Note each created event in the brief under "Changed by the assistant".
- Ambiguous booking (no firm time, possible duplicate): do not create -
  list it as "booking found, no calendar entry - add it?".

## Scheduling emails: think a step ahead (in chat, when the owner talks to you)

When an email asks about availability, proposes a time, or answers a time the owner suggested, do not just report it and ask what to do. Do the
whole job and ask once:

1. Check the owner's calendar yourself (`list_events`, the calendars in the setup note), including the travel time between the neighbouring events.
2. Draft the reply: if the proposed time is free, confirm it; if not, propose two or three concrete free slots. Write it in the owner's voice
   and language, ready to send.
3. Tell the owner in one short message what the mail says, what the calendar shows, the draft, and one thing worth knowing (a clash, a tight
   journey). End with one question: send it?
4. When the owner says yes, send, and add the matching event to their own calendar in the same step, without a second question. Say that you
   added it, so they can ask you to remove it. The one yes covers what you announced. Announce the calendar entry in the message from step 3.

Never invite other people or change an event that has guests without asking; the "one yes" covers only a new entry on the owner's own calendar.

## The owner's own events, nobody else on them (in chat)

"Put the visit to Uschi in my calendar on Saturday" is a plain request: create it at once on the owner's own
calendar, with no guests and no notifications, and do not ask first. When the day or the time is open, pick the most
likely reading yourself (the coming Saturday; a sensible time for that kind of thing, or an all-day event when no
time fits) and SAY in your reply which date and time you chose ("Saturday 25 Oct, 10:00-13:30; tell me if it's
another time"), so the owner can correct it with one word. Moving or editing one of the owner's own events that has
no guests works the same way. This is never a question to the owner: a wrong guess is fixed in a second. Inviting or
notifying anyone, another person's or a shared calendar, and deleting stay as below.

To invite someone by name ("invite Sam"), call `find_person` first (the people notes, then Google contacts where there are any) and ask for an address only when it finds none. One match: use it and say whose address it is. Several: show the candidates and ask which. A found address is only a suggestion: the invite still asks, with the guests shown.

## Cancelling, declining and deleting (in chat)

Before you act on an event, look it up by day and title (`list_events` for that day, or `get_event`), so you know what it is and who organises it. Name it by title and time in anything you say ("the Embassy reception, Fri 21 Nov 18:00"), never by id.

- "Cancel it" or "I can't make it" for an event **someone else organises**: respond to the invitation as declined (`respond_to_event`), with a short note in the owner's voice when it helps ("Sorry, I can't make it tonight."). The organiser is notified by that. Do not delete it: a delete tells the organiser nothing.
- Delete only an event the owner organises, or one that is the owner's own entry (nobody else on it).
- Deleting an event the owner organises that has guests: notify the guests (they would otherwise find out by themselves). It touches other people, so the owner is asked first; that is right.

## Guardrails

- May: `create_event` for travel bookings as above.
- May not (in an unattended run): `update_event` or reschedule on its own, `delete_event`
  ever, create non-travel events, edit other people's events, send or
  respond to invites. In chat, the owner's own no-guest events are created, moved and
  edited on request as above.
- The agent's policy (`src/policy/policy.ts`) judges every calendar write: an event on the
  owner's own calendar with nobody invited is routine; one that invites or notifies people
  asks the owner, whatever this skill says.

## In the briefing

- **Conflicts / reschedules** section - only if there is something;
  each as a suggestion.
- Created travel events -> "Changed by the assistant".
- The meeting list itself is rendered by `ted-personal-assistant:meeting-prep`.
