---
name: meeting-prep
description: Use when deciding which upcoming meetings need preparation, creating and drafting a prep page in the owner's Notion "Meetings" database, and running the post-meeting follow-up pass. Part of the daily brief. Gets the event list from `ted-personal-assistant:calendar`; pairs with `ted-personal-assistant:mailbird`, `ted-personal-assistant:notion-tasks`, `ted-personal-assistant:daily-brief`.
delegate: sonnet
---

# Meeting prep

`ted-personal-assistant:calendar` produces the reviewed event list for the window. This skill
decides what needs prep, drafts it, and follows up after meetings happen.

## Which meetings need prep

**Needs prep** - a substantive external or high-stakes meeting: an
intro / pitch / customer or investor call, an interview, a presentation,
a decision meeting, anything with an agenda or pre-read.

**No prep** - 1:1 personal catch-ups, standups / recurring team syncs,
socials, blocked focus time, travel, all-day markers.

If unsure, treat it as needs-prep but keep the draft short.

## Where prep pages live (from the owner's notes)

The owner's `setup-meetings` note says where meeting pages go: a **database**
(with its URL, data source id, property names, default template and an "all
meetings" view) or a **parent page** whose sub-pages are the prep pages. Use
exactly that; do not guess a location.

**If the Notion tools (`notion-search`, `notion-fetch`) do not exist** (the connector is not connected in the owner's Claude account), say so plainly, never guess or invent meeting prep data, skip this part, and in an unattended run end the brief with one line: "🔌 <connector> isn't connected, so meeting prep was skipped." In chat, add how to fix it: connect it under Settings, Connectors in their Claude account, then message you again.

**If there is no `setup-meetings` note:**
- in chat, find it yourself and save it: load `ted-personal-assistant:setup` (it searches Notion
  for the meetings database or page, saves the note, and asks the owner only if it
  finds nothing or several candidates), then carry on with the owner's request;
- in an unattended run (nobody to ask, and you cannot save notes), still decide
  which meetings need prep and list them with a one-line reason, but **create no
  pages** in a location nobody has confirmed. You may search Notion read-only, and
  end the brief with one line: "Meeting notes are not set up yet. I found '<title>'
  (<url>); message me 'set up my meetings' to confirm it." (or "I couldn't find a
  meetings database" if there is none).

Reading what exists: for a database, **one** `notion-fetch` on its "all meetings"
view URL (or the database URL); do not fetch it again and do not also fetch the
`collection://` data source. For a parent page, one `notion-fetch` of the page.
(The agent only sees four Notion tools, see `NOTION_TOOLS` in `.env.example`; a
database query tool is not among them.)

## Per meeting that needs prep

Do the deep build **only** when: the meeting is in the window, it needs
prep, and there is **no existing row with real prep content**. If a row
already has a decent prep body, just link it and move on - do not
rebuild or re-research.

1. **Look for an existing row** - match on meeting name / attendee and a
   `Date` within a day of the event.
2. **If none, create one** (`create-pages`): in a database, with the data
   source id as parent, the default template if the note names one, and the
   title, date (`is_datetime` 1, real start time) and best-guess category
   properties from the note; under a parent page, as a sub-page titled with
   the meeting name and date.
3. **Draft the prep in the body** from a *bounded* look:
   - at most the **2 most recent** prior pages or rows with the same
     person / company (their `Summary` first; open a body only if the
     Summary is thin);
   - at most the **2 most recent** email threads with the attendee -
     one `ted-personal-assistant:mailbird` `search_conversations`, skim the result, open at
     most those two;
   - any single doc the invite directly links.
   Structure: **Context** (who they are, how the owner knows them, last
   contact), **Goal**, **Talking points / questions** (3-6), **Open
   threads / asks**, **Prep to do** (if any - also add it to
   `ted-personal-assistant:notion-tasks`).
4. Put a short version + the Notion link in the briefing.

## Post-meeting follow-up (every run)

For meetings that already happened in the look-back window:

1. Find the Meetings DB row (by name / attendee / date).
2. **If it has real notes / a Summary:** read them, pull out follow-ups
   (a promise the owner made, a next step, a doc to send). For each, add a
   task to `ted-personal-assistant:notion-tasks` if none exists and list it in the brief;
   draft any follow-up email in-thread via `ted-personal-assistant:mailbird`.
3. **If there are no notes:** in the brief, ask "add notes from your
   <meeting> with <person>?" and, if the meeting type usually needs a
   follow-up, suggest a placeholder task.

## Guardrails

- May: create meeting rows, set their properties, write / update prep
  body content, add a matching task via `ted-personal-assistant:notion-tasks`.
- May not: delete meeting rows, touch the calendar (that is `ted-personal-assistant:calendar`),
  send invites, change other people's notes.
- Draft only - never email an attendee or share prep without the owner.

## In the briefing

- **Meetings** section: today and tomorrow, each one
  line - time, title, attendee, and "prep ready -> <link>" or "no prep
  needed". The daily brief carries the full short pre-meeting packet
  for each of the day's meetings that need prep. Flag same-day
  deadlines (memo due, doc to sign) at the top.
- **Follow-ups** section: from the post-meeting pass - notes to add,
  follow-up tasks created, drafts waiting.
