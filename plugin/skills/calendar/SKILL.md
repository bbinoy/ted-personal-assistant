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

## Travel bookings -> calendar (the one automatic write)

Scan recent booking-confirmation emails (flights, trains, hotels,
buses) via `ted-personal-assistant:mailbird` `search_conversations`. For each **confirmed**
booking with a firm date/time that is **not already on the calendar**:

- `create_event` on the calendar the setup note names for bookings: clear title ("Flight
  ZRH -> BCN LX123", "Hotel: <name>, <city>", "Train <A> -> <B>"),
  correct start/end (booking's own timezone, else the owner's time zone),
  location, and confirmation number + one-line summary in the
  description.
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

Never invite other people or change an existing event without asking; the "one yes" covers only a new entry on the owner's own calendar.

## Guardrails

- May: `create_event` for travel bookings as above.
- May not: `update_event` or reschedule on its own, `delete_event`
  ever, create non-travel events, edit other people's events, send or
  respond to invites.
- The agent's policy (`src/policy.ts`) also asks the owner on the phone
  before any calendar write, whatever this skill says.

## In the briefing

- **Conflicts / reschedules** section - only if there is something;
  each as a suggestion.
- Created travel events -> "Changed by the assistant".
- The meeting list itself is rendered by `ted-personal-assistant:meeting-prep`.
