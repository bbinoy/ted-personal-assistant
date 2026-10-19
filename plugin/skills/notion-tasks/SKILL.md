---
name: notion-tasks
description: Use when reviewing, tidying, or updating the owner's Notion task list, keeping it in sync with email activity, or reporting on tasks - typically as part of the daily brief, or an ad-hoc "what's on my list / add a task / mark this done". Pairs with `ted-personal-assistant:mailbird` and `ted-personal-assistant:daily-brief`.
---

# Notion task list

## Setup (from the owner's notes)

The task page (URL, id, whether it is a page of Markdown tables or a database, and
its column and token names) is in the owner's `setup-tasks` note. Use exactly that.
This skill describes the default layout: a **page** with two Markdown tables,
`## 📅 Due` and `## 📋 Later`, columns Task / Due / Priority / Area, edited with
`notion-update-page` (`update_content` search-replace on the table rows). If the
note says the tasks are a database, use `notion-create-pages` and
`notion-update-page` on it and adapt the steps below.

**If the Notion tools (`notion-search`, `notion-fetch`) do not exist** (the connector is not connected in the owner's Claude account), say so plainly, never guess or invent tasks data, skip this part, and in an unattended run end the brief with one line: "🔌 <connector> isn't connected, so tasks was skipped." In chat, add how to fix it: connect it under Settings, Connectors in their Claude account, then message you again.

**If there is no `setup-tasks` note:**
- in chat, find it yourself and save it: load `ted-personal-assistant:setup` (it searches Notion
  for the task list, saves the note, and asks the owner only if it finds nothing or
  several candidates), then carry on with the owner's request;
- in an unattended run (nobody to ask, and you cannot save notes), you may search
  Notion read-only to see whether a clear task list exists, but **do not edit a page
  nobody has confirmed**. Skip the task edits and end the brief with one line:
  "Tasks are not set up yet. I found '<title>' (<url>); message me 'set up my tasks'
  to confirm it." (or "I couldn't find a task list" if there is none).

**Fetch it once.** One `notion-fetch` on the page at the start of the
tasks step; make all edits from that copy. Re-fetch at most once, only
to verify a complex multi-row rewrite. Never fetch it 2-3 times.

## Always do first (the page's own standing instructions)

The page carries an instruction block for AI assistants; follow it every run. If
it has none, use these defaults:

- Remove tasks that are done.
- Move a row from **Later** to **Due** once its date is today or past;
  move Due -> Later if its date was pushed to the future.
- Sort each table by date ascending, then priority.
- Prefix a task with `⚠️` if it is overdue (date < today).
- Fix any inconsistencies (missing sort, stale ⚠️, wrong section).

Priority and Area tokens (for example `🔴 High` `🟡 Medium` `🟢 Low`, `💼 Work` `🏠 Private`) are the ones in the setup note or already on the page. Keep them exact.

## Email <-> task sync

Only when the link is unambiguous:

- **Mark done / remove** when email activity clearly completes a task:
  task is "reply to / send X to <person>" and the owner has since sent that
  mail; task is "sign <doc>" and a signed / countersigned confirmation
  arrived. Remove the row (per the standing instruction to delete done
  tasks) and note it in the brief.
- **Add a task** when an incoming email creates a clear obligation with
  a deadline or promised deliverable and no matching row exists. Put a
  source hint in the task text, e.g. "(from <sender>, <date>)". Default
  Area from context, Priority 🟡 unless clearly urgent.
- **Nudge** when a task is "waiting on <person>" past its date and no
  reply has come: surface it in the brief with a draft follow-up (via
  `ted-personal-assistant:mailbird`), do not auto-send.

When the link is fuzzy, do **not** edit - list it in the brief as a
question ("looks like 'Foo' may be done - confirm?").

After you add, change or tick off a task, load `ted-personal-assistant:follow-through`: it asks what else the change implies (a done task may free a follow-up, a new one may belong with a calendar entry or a mail to archive).

## Guardrails

- May: add rows, edit a row's Task / Due / Priority / Area, move rows
  between the two tables, remove done rows, re-sort, fix ⚠️.
- May not: delete the page or a table, change the page structure.
- Never remove a task as "done" without concrete evidence. In doubt,
  keep it and ask in the brief.
- Preserve the owner's own wording in task titles; keep any edits minimal.

## Deadlines are tasks

Keep it simple: every deadline lives here as a task row. When
`ted-personal-assistant:mailbird` or `ted-personal-assistant:meeting-prep` surface a date-bound thing (payment
due, RSVP-by, sign-by, respond-by, application deadline, memo due, doc
to sign) and no matching row exists, add one with its Due date and a
short source hint. There is no separate deadline list - the Tasks
section of the brief, ordered by date, is the deadline view.

## In the briefing

A **Tasks** section: `⚠️ Overdue` first (with how many days), then
**Due today**, then **Due this week** (dated), then a one-line count of
everything later. Call out every row the run changed and why (moved /
added / removed / nudged).
