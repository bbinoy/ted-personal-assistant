---
name: notion-tasks
description: Use for anything about the owner's task list - reviewing it, adding a task or deadline, ticking something off, "what's on my list", syncing it with email activity. Tasks no longer live in Notion: they live in the assistant itself (list_tasks, add_task and the other task tools). This skill says how to keep them tidy; moving an old Notion task table over is `ted-personal-assistant:task-import`. Pairs with `ted-personal-assistant:mailbird` and `ted-personal-assistant:daily-brief`.
---

# The task list (it lives in the assistant, not in Notion)

The owner's tasks, the promises they made (`i_owe`) and what they wait on from others
(`owed_to_me`) are items in the assistant's own list. Use the task tools: `list_tasks`
(read), `add_task`, and in chat `update_task`, `complete_task`, `drop_task`,
`snooze_task`, `confirm_suggestion`, `reject_suggestion`. **Never write a task to
Notion** (no page edit, no new page, no row for a task): after the
one-time import the Notion table is an archive nobody updates. If the owner still
has tasks in a Notion table and none are in the list yet, offer
`ted-personal-assistant:task-import`.

## Read before you add

Call `list_tasks` first (it also tells you today's date and time zone), so you never add a
duplicate. Dates are the owner's local time; work out "friday" or "in two days" yourself
from the date in the reply and pass explicit ISO.

## Who may change what

- **In chat** you may add, edit, finish, drop and snooze items when the owner asks, and
  finish one when concrete evidence says it is done (the owner sent the mail the task
  said to send). Say what you changed. In doubt, ask.
- **In an unattended run** (the daily brief, a heartbeat look, the mail handler) you can
  only `list_tasks` and `add_task`, and what you add is a **suggestion** for the owner to
  confirm or reject: you cannot finish, change or drop anything. So "this looks done"
  and "this task is waiting on a reply that has come" are lines in the brief
  ("looks like 'Foo' may be done - confirm?"), not edits.

## Email and meeting sync

- **Add** (a suggestion when unattended) when an incoming mail or a meeting creates a
  clear obligation with a deadline or a promised deliverable and nothing matching is on
  the list. Pass `source_kind` `mail` or `meeting` and a `source_ref` (the mail id) so the
  same mail never adds it twice. Keep the owner's own wording for the title.
- **A promise the owner made** in sent mail is an `i_owe` item with `person`; something
  they wait on is `owed_to_me`.
- **Nudge** an `owed_to_me` item that is past its date with no reply: surface it in the
  brief with a draft follow-up (via `ted-personal-assistant:mailbird`), never send.

Every deadline is a task; the list ordered by date is the deadline view. After you add,
change or finish a task in chat, load `ted-personal-assistant:follow-through`.

## If the task tools are not there

Say so plainly and skip the tasks part; never invent task data.
