---
name: gmail
description: Use when a task involves email/inbox with Gmail (MAIL_PROVIDER=gmail) - checking mail, drafting or sending replies, searching, archiving. The Gmail connector comes with the owner's Claude login.
---

# Gmail (claude.ai connector)

Gmail comes through the owner's Claude account like Notion does: tools named
`mcp__claude_ai_Gmail__*`. If they are missing, the connector is not connected:
say so and tell the owner to connect Gmail in their Claude account (Settings,
Connectors); do not try anything else.

The tools you have: `search_threads`, `get_thread`, `get_message`, `get_draft`,
`list_drafts`, `list_labels`, `create_draft`, `update_draft`, `reply`, `forward`,
`send_message`, `unlabel_thread`, `label_thread`. Ids are strings. Arguments are camelCase
(`threadId`, `messageId`, `labelIds`, `messageFormat`).

## Reading

- Find mail with `search_threads` and Gmail search syntax: `in:inbox`, `is:unread`,
  `newer_than:2d`, `from:`, `subject:`. Rows carry sender, subject, snippet and date: **classify
  from the row when it is enough; whenever you are not confident (an unknown sender, a subject that could be
  personal, anything that might need the owner) open the thread before deciding. Reading is a plain read,
  free and uncapped; never keep a mail just because you did not read it.** Open with `get_thread` and `messageFormat: "PLAIN_TEXT"` (never `RAW`).
- **Attachments**: never read or open their content. Their name, type and size are enough; if the
  owner needs the content, tell them to open it in Gmail.
- The owner's own briefing mails (subject starting with the sun or moon emoji) are never read, replied to or counted as mail; only today's `☀️` brief stays in the inbox, older `☀️` and `🌙` ones are archived in the daily sweep.

## Triage (the daily brief's inbox pass)

Same rules as the Mailbird skill, "Inbox sweep" (read it): **archive unless the mail needs the owner**
(a reply or decision expected, a payment or signature open, an event or deadline within 7 days, or unread
personal mail from someone the owner knows or has corresponded with); everything else is handled and goes, read or unread, new or old
(receipts, confirmations, booking and order updates, codes, account notices a day old, newsletters, promos,
notifications, CI and tool mails, answered invitations). Cold outreach (sales, recruiting, fundraising, vendor pitches, follow-up sequences, a stranger name-dropping the owner's company) is archived like a newsletter whatever any "important" flag says, unless the owner's notes want that kind; open the thread before judging an unknown sender, never decide by the subject alone. Routine and in doubt: archive. The owner's triage
notes in memory win over these defaults. The daily sweep lists the whole inbox itself
(`search_threads` with `in:inbox`, paging with the page token until it ends, oldest included; it does not use
`seen_mail`) and archives what is handled, including all but today's brief email. Skim at most 4 relevant
newsletters for the brief's Radar before archiving. Scan sent mail (`in:sent newer_than:7d`) for waiting-on threads and for promises
to turn into tasks, (`add_task`, as `ted-personal-assistant:notion-tasks` describes).

## Archiving

Archive = `unlabel_thread` with `labelIds: ["INBOX"]` (reversible: `npm run restore <threadId>` or label the
thread INBOX again). Nothing else:

- **Never trash, delete or mark spam.** Those tools and the labels `TRASH` and `SPAM` (on any label tool)
  are blocked. Use archive even when the owner says "delete".

When a mail asks about availability or proposes a time, follow "Scheduling emails: think a step ahead" in the calendar skill: check the calendar, draft the confirmation or slots, and ask once; the owner's yes sends it and adds the calendar entry.

## Drafts, replies and sends

- Draft freely: `create_draft` (for a reply pass `replyToMessageId` so it stays in the thread) and
  `update_draft`. Plain text in `body`, no Markdown. Match the thread's language and tone, and the owner's
  voice from their notes (the Mailbird skill's "owner's voice" rules apply: `voice-writing` and
  `style-` notes).
- **Sending needs the owner's approval, always shown with the real recipients.** `send_message` (a new
  mail, or a draft by `draftId`), `reply` and `forward` ask on the owner's phone or are judged against
  what they just told you. Once they said to send, make the call right away; the approval question is
  the confirmation. Do not retry a declined send.
- In `reply`, give the text and the `messageId` of the message you reply to (the latest in the thread).
  Do not add recipients the owner did not ask for; `bcc` and attachments are never added on your own.
- **Addresses: look before you ask.** When a new mail goes to someone by name ("write to Sam"), call `find_person` first (the people notes, then Google contacts where there are any). One match: use that address and say whose it is. Several: show the candidates and ask which. None: say so and ask for the address. A found address is only a suggestion: the send still asks the owner, with the recipients shown from the call itself.
- The only mail you may send without a question is the daily brief to the owner's own address (the brief
  instructions say how); never send anything else unattended.

## Labels

`label_thread` and the other label tools ask the owner first. `list_labels` gives label ids (the tools take
ids, not names).

## Automated runs

The heartbeat run works through new mail about every 30 minutes in the day, archives clear noise, and
tells the owner on Signal only what is worth interrupting for. Operate with
`npm run doctor`, `npm run report` and `npm run restore <threadId>`.
