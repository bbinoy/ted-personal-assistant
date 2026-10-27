---
name: mailbird
description: Use when a task involves email/inbox/Mailbird - checking mail, drafting or sending replies, searching, archiving, or when the mailbird MCP server shows as disconnected/unauthorized and needs troubleshooting.
---

# Mailbird MCP

The owner's Mailbird Next app exposes a local MCP server (`mailbird`, user
scope, available in every session). Tool usage, argument shapes and
routing rules come from the server's own `initialize` instructions -
follow those, don't restate them here. If the connection is broken
(`claude mcp list` shows it failed, 401s, setup redo), use the
**`mailbird-troubleshooting`** skill.

## For every run that handles mail

- **The assistant's own briefs.** A mail the owner sent to themselves whose subject
  starts with "Daily brief", "Evening wrap" or "Weekly review" (with or without a
  `☀️` / `🌙` in front) is the assistant's own brief. Never read, reply to or count it
  as mail. Today's daily brief stays in the inbox; every older brief, wrap and review
  is archived.
- **The triage rules below apply to every look, not only the daily sweep.**

## Inbox sweep (the daily brief run)

Run this across every account (`list_accounts` -> each Inbox). The agent's
heartbeat run already works through new mail all day, so this sweep covers what is
still in the inbox, plus the owner-facing parts (waiting-on, commitments,
radar).

1. **List the whole inbox, once a day.** The daily brief's sweep does not depend on
   what the heartbeat has already looked at (it does not use `seen_mail`: the
   heartbeat's memory hides everything it kept once, and the backlog from before
   it started). Per account (`list_accounts`), list the Inbox itself with
   `list_conversations` (`limit` high enough for all of it, 200 or the most the
   tool allows, oldest included; page or batch by date when it is bigger) and
   classify every row, read or unread, new or years old. `summarize_all_inboxes`
   may add previews for the newest. Work through a big inbox in batches of
   about 50 rows, all `archive_conversation` calls of a batch in one turn. A run
   may archive only so many mails (the tool refuses past the cap): when it does,
   stop archiving, say nothing about it, and the next day's sweep continues.
   **Keep only today's brief email** (see "For every run that handles mail").

**Decide per mail whether the row is enough, and read when it is not.**
Reading is a plain read: free, not judged, with no cap. Where the row (sender,
subject, preview) makes the call certain, classify and archive from the row
without opening it, **for automated senders only**: newsletters, promos, job-board
digests, social nudges, receipts, security/login alerts, shipping and
portal-document notices, and a batch of near-identical rows that is obviously one
category. **Mail from a person is opened before it is archived.** **Whenever you are
not confident, open the full mail (`get_message`) before deciding:** an unknown
sender, a subject that could be personal, anything that might need the owner, a
date, an amount or an ask you must read to judge, a real-person thread you cannot
tell is concluded, and every mail you will draft a reply to. **Never keep a mail
just because you did not read it:** read it, then decide. The cost of one read
is small next to a mail left in the inbox for weeks. Keep the quote chain out of
your head: take what decides the case and move on.

**Batch the calls.** Per-account `list_folders` / `list_conversations`
go in one turn; fire all the `archive_conversation` calls for a sweep
in one turn, not one per turn.

2. **Triage: archive unless the mail needs the owner.** The default is
   *archive*. Everything the owner does not have to act on goes, and goes
   whether it is unread, new or old.
   - *Needs the owner* (keep): a reply or a decision is expected from them; a
     payment is open or a document waits for their signature; an event or
     deadline falls in the next 7 days; or **a real conversation**: a thread in
     which the owner and a person write to each other personally (the owner has
     written to them, or they write to the owner about something the owner is part
     of: their notes, contacts, earlier threads, sent mail, the calendar tell you).
     A real conversation stays, read or unread, however old, until it has clearly
     closed (a thanks or a sign-off, nothing open on either side) **and** is older
     than about 14 days. **The owner's own mails stay too**: a thread the owner
     started or a mail they sent to themselves (a note, a link, a forward), unless
     it is one of the assistant's own briefs.
   - **Cold outreach is noise even when a named person wrote it**: sales,
     recruiting, fundraising, agency and vendor pitches, "quick question" mails,
     follow-up sequences, generic personalisation, a stranger name-dropping the
     owner's company. Judge the relationship, not whether a human typed it: no
     earlier exchange, no shared context, and a pitch is outreach. It is archived
     like a newsletter, whatever the provider's "important" flag says, unless the
     owner's notes say they want that kind. **When the sender is unknown to the
     owner, open the mail (`get_message`, cheap) before deciding;** never judge an
     unknown sender by the subject alone.
   - **Official and open matters stay until something shows they are done**:
     invoices still to pay, bills, tax and accounting mail, lawyers and notaries,
     insurance, official letters, and requests to sign or verify (DocuSign and the
     like). They are handled once a later mail, the calendar or a task shows it:
     a payment confirmation, "all parties have signed", a closed case.
   - **Something ahead goes on the calendar before its mail is archived.** A
     confirmation for something with a date still ahead (a ticket, an event or class
     order, a booking or reservation, an appointment, travel) is not handled until it
     is on the calendar: open it, check the calendar around that date
     (`list_events` / `search_events`), and if it is missing create it on the owner's
     own calendar as the calendar skill's "Bookings -> calendar" says (title, time,
     place, reference; no guests). Then archive, and say in your message what you
     added. No firm date or time: keep the mail and mention it.
   - **A completed task closes its mail.** When a task in the list is done and a mail
     belongs to it (the task's source mail, the same thread, or plainly the same
     matter by sender and subject), that mail is handled.
   - **A series keeps only its newest mail.** Several mails that are the same reminder
     or update (a signature reminder sent three times, payment or renewal reminders,
     repeated status updates on one matter): keep the newest while it is still open,
     archive the older ones.
   - *Handled, archive from the row:* receipts and payment confirmations, order
     updates (shipped, dispatched, delivered), booking updates for something already
     on the calendar or already past, a receipt for a booking already confirmed, verification and confirmation codes, account and
     security notices (once a day old, unless suspicious: a login the owner did
     not make stays), past events and finished trips, calendar invitations /
     updates / accepted / declined notices (judge the event on the calendar),
     Notion and Google Docs notifications, e-signature *completion* notices (a
     request to sign is an open matter, above), app/OAuth notices, CI and
     tool mails (build failures, deploy notices), "RE: Reservation" style booking
     notifications, review requests, read and concluded threads, and a mail that
     is now a task (the task holds it).
   - *Noise, archive from the row:* newsletters, promotions, cold outreach, job-board
     digests, social nudges, expired invites and event blasts.
   - **For automated mail, unread is not a reason to keep.** Neither is "I have not
     looked at it": decide by what the mail is. **Read** is a signal for the other
     side: an automated mail the owner has opened, older than about 3 days, with
     nothing open for them, is handled. For a person's mail, read or unread does not
     decide: the real-conversation rule above does.
   - **In doubt between keep and archive for routine mail: archive.** It is
     reversible, journaled and listed in the brief. Doubt about a mail from a real
     person, money or an official deadline is different: keep that one.
   - **The owner's triage notes win.** Their learned preferences in memory
     (`triage-` notes: "mail from X is always urgent", "keep the school's mails")
     override every default in this list, in both directions.

   **Real conversations in the brief:** a real conversation that still waits for a
   reply from either side and has gone quiet is flagged in the brief ("dormant
   thread with <person> (<subject>, last activity <date>)"). It is not archived
   until it has clearly closed and is older than about 14 days (above).
3. **Tidy.** Archive the FYI + Noise buckets with `archive_conversation`
   (never trash or delete). Track what was archived and the reason.
4. **Propose actions with drafts ready.** For each "Needs the owner" item
   that wants a reply, draft it now **in-thread**: `select_conversation`
   first, then `reply_to_conversation` (or `reply_all_to_conversation`
   for multi-recipient threads) with `showInUi: true` and no
   `forceNewWindow`, so it lands as the inline Quick Reply. Match the
   thread's language and tone. Never `create_draft` for a reply. Never
   send. Present each as: what it is, the suggested action, the draft text.
5. **Report** as a short briefing: Needs-the-owner items first (sender, one
   line of why, suggested next step + draft), then one line summarising
   what was archived.

**Cold outreach is always Noise. Archive it - no reply, no action, and
do not put it in the briefing as something for the owner to handle.**
This covers sales pitches, agency / recruiter / SEO / "quick call?"
emails, partnership feelers, and investor or vendor cold intros from
people the owner has no relationship with. A message from a real contact,
or a genuine warm intro (someone they know put them in touch), is not cold
outreach and is handled normally.

### Newsletter radar (skim a few before archiving)

Newsletters are still archived, but a **small, selective** number are
skimmed first to feed the brief's **Radar** section (`ted-personal-assistant:daily-brief`).
This is the one case where a newsletter is read before it is archived.

- **Which:** newsletters whose sender/subject plausibly covers the topics
  in the owner's **Brief notes** (see the memory block in your system
  prompt; with none, skip the radar entirely). Skip retail promos,
  job-board digests, and anything already covered.
- **How many:** open at most **4** per daily brief run. Pick the most
  relevant by sender+subject; archive the rest from the row. Open with
  `get_message`, extract, then archive as usual.
- **Extract concrete items, not summaries:** announcements, launches,
  funding rounds, regulatory or policy changes, notable hires/partnerships,
  and **events** (date, venue, deadline to register). Prefer things that
  *happened or are coming* over explainers and opinion.
- **Dedupe:** skip anything the previous brief's Radar already listed.
- Nothing concrete found -> contribute nothing (never pad).

### Waiting-on list

Scan **Sent** across accounts. Where the owner sent the last message in a
real thread **4+ working days ago** and there's been no reply, list it
in the brief (recipient, subject, days waiting) and draft an in-thread
nudge. Skip cold outreach they sent, newsletters, and threads where a
reply isn't expected.

### Commitment capture

Scan the owner's **Sent** mail from the last few days for promises they made:
"I'll send you X", "by <day>", "next week I'll...", "let me get back to
you on...". If there's no matching item on the task list (`list_tasks`), add one with `add_task`
(kind `i_owe`, the recipient as `person`, what was promised + any date; unattended it is
added straight onto the list, and told), and note it in the brief. Don't create duplicates for things already tracked.

### Email-borne deadlines

While triaging, pull any explicit date-bound ask - payment due, RSVP
by, sign by, respond by, application deadline - and add it with
`add_task` (`source_kind` mail, `source_ref` the mail id) as a task with that due date (if no matching
item exists; unattended it is added and told; see `ted-personal-assistant:notion-tasks`). Every deadline is a task; there is no separate list.

### Automated runs

This skill is run unattended by the agent, in two ways:

- **Heartbeat run, about every 30 min (in the day; the model chooses the next look):** one
  run looks at the chat, the new mail and the calendar. It archives clear noise, drafts routine
  replies, and tells the owner on their phone only what is worth interrupting for. Everything
  that sends, shares or spends still asks the owner.
- **Daily brief, once per day**, delegated by the heartbeat run at the usual time:
  the `ted-personal-assistant:daily-brief` skill sweeps what is left, then delivers one brief by
  email and Signal.

Operate the agent with `npm run doctor` (health), `npm run report` (what it
did) and `npm run restore <id>` (un-archive). Mailbird must be running with
"Allow write actions" on.

## The owner's voice (from the owner's notes)

How the owner writes is in their `voice-writing` note (length, greetings and
sign-offs per language, tone, habits). Draft in that voice. Match the
correspondent's language and the thread's register first; the voice note is the
default within that. Wording rules (for example "no em dashes") are in the
owner's `style-` notes; follow those too.

**If there is no `voice-writing` note:** still draft (short, plain, polite, in the
thread's language, signed with the owner's first name), and:
- in chat, offer once to learn their voice from their sent mail: load
  `ted-personal-assistant:setup`;
- in an unattended run, add one line at the end of the brief: "I don't know how
  you write yet. Message me 'set up my writing' and I'll learn it from your sent mail."

**Scheduling.** When a draft is about finding a time, offer the owner's booking
link if there is a `setup-booking-link` note (phrase it naturally), or name 2-3
concrete slots from their real free time. When the other side has proposed times,
check them against the calendar and confirm one rather than sending the link back.

When a mail asks about availability or proposes a time, follow "Scheduling emails: think a step ahead" in the calendar skill: check the calendar, draft the confirmation or slots, and ask once; the owner's yes sends it and adds the calendar entry.

## Guardrails (do not skip these for convenience)

- **Sending needs the owner's explicit approval.** Draft with `create_draft` /
  `reply_to_conversation` / `reply_all_to_conversation` /
  `forward_conversation` freely, but never call `send_message_now` until
  the owner has seen the draft's actual text and said to send it.
  `confirm: true` is not a substitute for that - it's Mailbird's own
  safety check, not the owner's approval. (The agent's policy also asks on
  the phone before any send.)
- **Addresses: look before you ask.** When a new mail goes to someone by name ("write to Sam"), call `find_person` first (the people notes, then Google contacts where there are any). One match: use that address and say whose it is. Several: show the candidates and ask which. None: say so and ask for the address. A found address is only a suggestion: the send still asks the owner, with the recipients shown from the call itself.
- **Never delete. Archive instead.** Do not call `delete_conversation_permanently`,
  and do not call `trash_conversation` either - use `archive_conversation`
  for anything the owner wants out of the inbox, even if they say "delete"
  or "trash" it. (The agent's policy blocks both anyway.)
- **Match the thread's tone and language when drafting.** Read the
  existing messages in the conversation (`get_message`) and mirror their
  register and language, rather than defaulting to a generic reply style.
- **Replies stay in their thread, as the inline Quick Reply.** Draft
  any reply with `reply_to_conversation` / `reply_all_to_conversation`
  so it is attached to the conversation and quotes the original. To get
  the inline Quick Reply rather than a pop-out compose window, call
  `select_conversation` on that conversationId FIRST, then the reply
  tool with `showInUi: true`. Never pass `forceNewWindow`. Use
  `create_draft` only to start a brand-new email with no existing thread.
- Write actions (archive, send, etc.) require "Allow write actions" to be
  toggled on in Mailbird's Wingman AI settings tab. If a write call errors
  because of this, tell the owner rather than retrying.
- Mailbird's own setup article:
  [Mailbird support article](https://nextsupport.getmailbird.com/hc/en-us/articles/40033560742167-Connect-Claude-ChatGPT-and-OpenClaw-to-Mailbird-Next-MCP-Server-Setup).
