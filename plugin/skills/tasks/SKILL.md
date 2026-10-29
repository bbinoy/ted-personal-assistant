---
name: tasks
description: Use for anything about the owner's task list - reviewing it, adding a task or deadline, ticking something off, "what's on my list", syncing it with email activity. They live in the assistant itself (list_tasks, add_task and the other task tools). This skill says how to keep them tidy. Pairs with `ted-personal-assistant:mail` and `ted-personal-assistant:daily-brief`.
---

# The task list (it lives in the assistant, not in Notion)

The owner's tasks, the promises they made (`i_owe`) and what they wait on from others
(`owed_to_me`) are items in the assistant's own list (the task tools are described in the persona). **Never write a task to
Notion** (no page edit, no new page, no row for a task): after the
move the Notion table is an archive nobody updates. If the owner asks to bring tasks
over from Notion again, read Notion and use `add_task` for each, like any other request.

## Lists are not tasks

Something the owner collects (a book or film recommendation, a restaurant to try, a gift idea) goes on the list they keep for that kind of thing (a Notion page or database, say), with who recommended it and when, not on the task list. A task is only for something to do: a recommendation becomes one only if they ask to be reminded to act on it. Where each list lives is a `setup-lists` note (kind: location); if it has none for this kind, search Notion for the list and save it there, and if no list exists, ask once whether to start one or keep it as a note.

## Read before you add

Call `list_tasks` first (it also tells you today's date and time zone), so you never add a
duplicate.

## Finishing is ticking off, never deleting

Finishing a task is `complete_task` (the item stays, marked done, with the day; a repeating
one moves to its next date). An item that is no longer wanted is `drop_task` (it stays in
the history, dropped). Both are undone with `update_task` and `reopen: true`. Nothing is
ever deleted from the list, and you never remove a task because it is finished: only when
the owner says plainly to drop or remove that item.

## Who may change what

- **In chat** you may add, edit, finish, drop and snooze items when the owner asks, and
  finish one when concrete evidence says it is done (the owner sent the mail the task
  said to send). Say what you changed.
- **In an unattended run** (the daily brief, a heartbeat look, the mail handler) you have
  the same task tools. Your changes are attributed to "assistant (look)", the journal
  records each one, and every change is undone with `update_task` and `reopen: true`. At
  most 10 items a day can be added by looks. When evidence is concrete (the reply the task
  called for was sent, the signed document arrived), tick it off or snooze it and say so
  in one line; when it is not, leave it alone.

## Email and meeting sync

- **Add** (also when unattended, then say so in your message) when an incoming mail or a meeting creates a
  clear obligation with a deadline or a promised deliverable and nothing matching is on
  the list. Pass `source_kind` `mail` or `meeting` and a `source_ref` (the mail id) so the
  same mail never adds it twice. Keep the owner's own wording for the title.
- **A promise the owner made** in sent mail is an `i_owe` item with `person`; something
  they wait on is `owed_to_me`.
- **Nudge** an `owed_to_me` item that is past its date with no reply: surface it in the
  brief with a draft follow-up (via `ted-personal-assistant:mail`), never send.

Every deadline is a task; the list ordered by date is the deadline view. After you add,
change or finish a task in chat, load `ted-personal-assistant:follow-through`.

## Tasks that fit a place or a moment

Whenever you read the calendar, mail or chat, notice links between open tasks and where the person is or will be: the computer's location line where there is one, trips and events on the calendar, what they say. When a task fits (shopping when heading into town, flat errands when back home, things to buy before a trip, something to bring to a meeting), remind once, briefly, at a sensible moment before it matters. No standing section in every brief, no message when nothing fits, and never state a location as certain: it is a likely place, the calendar or the chat may say otherwise.

## A long overdue pile

When many tasks are long overdue (say ten or more, many of them weeks late: an import from another tool does this), the list is noise and the owner stops reading it. Snooze the long-overdue tail to a sensible date with `snooze_task` (reversible with `reopen`), in any run, and say so in one line ("Snoozed 14 old tasks to Monday; say 'reopen' for any you still want"). Keep the recent ones as they are.

## If the task tools are not there

Say so plainly and skip the tasks part; never invent task data.
