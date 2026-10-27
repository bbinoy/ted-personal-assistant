---
name: notion-tasks
description: Use for anything about the owner's task list - reviewing it, adding a task or deadline, ticking something off, "what's on my list", syncing it with email activity. Tasks no longer live in Notion: they live in the assistant itself (list_tasks, add_task and the other task tools). This skill says how to keep them tidy. Pairs with `ted-personal-assistant:mailbird` and `ted-personal-assistant:daily-brief`.
---

# The task list (it lives in the assistant, not in Notion)

The owner's tasks, the promises they made (`i_owe`) and what they wait on from others
(`owed_to_me`) are items in the assistant's own list. Use the task tools: `list_tasks`
(read), `add_task`, and in chat `update_task`, `complete_task`, `drop_task`,
`snooze_task`. **Never write a task to
Notion** (no page edit, no new page, no row for a task): after the
move the Notion table is an archive nobody updates. If the owner asks to bring tasks
over from Notion again, read Notion and use `add_task` for each, like any other request.

## Read before you add

Call `list_tasks` first (it also tells you today's date and time zone), so you never add a
duplicate. Dates are the owner's local time; work out "friday" or "in two days" yourself
from the date in the reply and pass explicit ISO.

## Finishing is ticking off, never deleting

Finishing a task is `complete_task` (the item stays, marked done, with the day; a repeating
one moves to its next date). An item that is no longer wanted is `drop_task` (it stays in
the history, dropped). Both are undone with `update_task` and `reopen: true`. Nothing is
ever deleted from the list, and you never remove a task because it is finished: only when
the owner says plainly to drop or remove that item.

## Who may change what

- **In chat** you may add, edit, finish, drop and snooze items when the owner asks, and
  finish one when concrete evidence says it is done (the owner sent the mail the task
  said to send). Say what you changed. In doubt, ask.
- **In an unattended run** (the daily brief, a heartbeat look, the mail handler) you can
  only `list_tasks` and `add_task`: what you add goes straight onto the list (marked as
  added by you) and you tell the owner in your message; you cannot finish, change or drop anything. So "this looks done"
  and "this task is waiting on a reply that has come" are lines in the brief
  ("looks like 'Foo' may be done - confirm?"), not edits.

## Email and meeting sync

- **Add** (also when unattended, then say so in your message) when an incoming mail or a meeting creates a
  clear obligation with a deadline or a promised deliverable and nothing matching is on
  the list. Pass `source_kind` `mail` or `meeting` and a `source_ref` (the mail id) so the
  same mail never adds it twice. Keep the owner's own wording for the title.
- **A promise the owner made** in sent mail is an `i_owe` item with `person`; something
  they wait on is `owed_to_me`.
- **Nudge** an `owed_to_me` item that is past its date with no reply: surface it in the
  brief with a draft follow-up (via `ted-personal-assistant:mailbird`), never send.

Every deadline is a task; the list ordered by date is the deadline view. After you add,
change or finish a task in chat, load `ted-personal-assistant:follow-through`.

## A long overdue pile

When many tasks are long overdue (say ten or more, many of them weeks late: an import from another tool does this), the list is noise and the owner stops reading it. Offer a clean-up **once**, in your own words and in one or two lines: reschedule, drop or keep, offering to go through them in chat in a few quick rounds. Remember that you offered with a short note (`overdue-cleanup`, with the date; the brief uses `status-overdue-offer`, written with `days` 30), and never offer again unless the owner asks or the pile grows well past what it was. When they say yes, go through the oldest first in small batches, each task one line with a suggestion ("drop", "move to Friday", "keep"), act on the answers with `update_task`, `snooze_task` or `drop_task`, and mention the result in one line. Nothing is dropped without their word. An unattended run (the daily brief) can only make the offer: it cannot change tasks.

## If the task tools are not there

Say so plainly and skip the tasks part; never invent task data.
