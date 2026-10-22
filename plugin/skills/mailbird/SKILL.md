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

## Inbox sweep (the daily brief run)

Run this across every account (`list_accounts` -> each Inbox). The agent's
heartbeat run already works through new mail all day, so this sweep covers what is
still in the inbox, plus the owner-facing parts (waiting-on, commitments,
radar).

1. **Pull what's new - one cheap pass.** Start with
   `summarize_all_inboxes` (one call, every account, returns rows with
   sender + subject + a short preview + ids). Only fall back to
   `list_conversations` on a specific Inbox folder if you need more rows
   than it returned, and then cap it: `limit: 30`, and ignore anything
   older than the previous brief's timestamp / already covered by it
   (the status-brief note and the chat log in your brief say when it went
   out and what the assistant already handled).
   **Never touch a briefing email** - a self-sent message from the owner
   with a `☀️` / `🌙` subject is skipped entirely (no archive, no label,
   no reply, not counted). Old briefs are never archived by a run of this skill.

**Do NOT open every email.** `get_message` (full body + the entire
quote chain) is the most expensive thing this routine does. Classify
from **sender + subject + preview only**, and open a message *only*
when one of these is true:

- you're going to draft a reply to it, or
- it plausibly needs an action AND the preview doesn't make the
  decision clear (a date, an amount, an ask you must read to judge), or
- it's a real-person thread and you can't tell from the preview whether
  it's concluded.

Newsletters, promos, cold outreach, job-board digests, social nudges,
receipts, security/login alerts, shipping and portal-document notices:
classified and archived **from the row, unopened**. Prefer unread
conversations; a thread the owner has already read is rarely something
you need to act on. If a batch of near-identical rows is obviously one
category, treat them together.

**Batch the calls.** Per-account `list_folders` / `list_conversations`
go in one turn; fire all the `archive_conversation` calls for a sweep
in one turn, not one per turn.

2. **Triage into three buckets:**
   - *Needs the owner* - real people, threads awaiting their reply, and
     anything that might carry an action: a payment, a deadline, a
     decision, a document to review or dispute. **Invoices, bills,
     insurance policy changes, tax documents, official letters, and
     anything where money might be owed or a response might be needed
     stay here - do not archive them, even when the email is "just" a
     notice that the document is in a portal.** When unsure whether
     something needs an action, treat it as Needs the owner and keep it.
   - *FYI* - purely informational, nothing to do: payment-received /
     order-confirmed receipts, security and login alerts, shipping
     updates, past-trip travel, read-only account notices. Archive from
     the row; open only if sender+subject genuinely leave you unsure.
   - *Also FYI (archive from the row):* **calendar invitation / update /
     accepted / declined notices** (the event is already on the calendar
     - judge the event there, not the email), Notion comment / mention /
     "made updates" / invite notifications, Google Docs "shared with you"
     notices, e-signature "viewed" / "completed" status pings, and
     app/OAuth permission notices.
   - *Noise* - newsletters, promos, cold outreach of any kind,
     job-board digests, social nudges, expired invites and event
     blasts. Archive from the row.

   **Real-person threads are never auto-archived.** If a thread has a
   reply from an actual person (not a service / no-reply / automated
   sender) and is not clearly concluded, do not archive it even if it
   looks dormant. Instead flag it in the brief: "dormant thread with
   <person> (<subject>, last activity <date>) - reply or archive?" and
   let the owner decide. Only archive such a thread when the exchange has
   obviously wrapped up (a clear thanks / sign-off with nothing
   outstanding).
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
This is the one exception to "archive newsletters unopened".

- **Which:** newsletters whose sender/subject plausibly covers the topics
  in the owner's **Brief notes** (see the memory block in your system
  prompt; with none, skip the radar entirely). Skip retail promos,
  job-board digests, and anything already covered.
- **How many:** open at most **4** per daily brief run. Pick the most
  relevant by sender+subject; archive the rest unopened. Open with
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
you on...". If there's no matching task in `ted-personal-assistant:notion-tasks`, add one
(with the recipient + what was promised + any date), and note it in the
brief. Don't create duplicates for things already tracked.

### Email-borne deadlines

While triaging, pull any explicit date-bound ask - payment due, RSVP
by, sign by, respond by, application deadline - and hand it to
`ted-personal-assistant:notion-tasks` as a task with that Due date (if no matching row
exists). Every deadline is a task; there is no separate list.

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
