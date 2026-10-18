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
  from the row**, and open a thread only when you will reply to it or the snippet cannot tell you what
  it needs. Open with `get_thread` and `messageFormat: "PLAIN_TEXT"` (never `RAW`).
- **Attachments**: never read or open their content. Their name, type and size are enough; if the
  owner needs the content, tell them to open it in Gmail.
- The owner's own briefing mails (subject starting with the sun or moon emoji) are never touched.

## Triage (the daily brief's inbox pass)

Same buckets and rules as the Mailbird skill: Needs the owner (people waiting, deadlines, invoices,
official letters, anything unsure: keep), FYI (receipts, status notices, calendar notices: archive from
the row), Noise (newsletters, promos, cold outreach: archive from the row). Real-person threads are
never auto-archived; flag dormant ones in the brief. Skim at most 4 relevant newsletters for the brief's
Radar before archiving. Scan sent mail (`in:sent newer_than:7d`) for waiting-on threads and for promises
to turn into tasks, as `ted-personal-assistant:notion-tasks` describes.

## Archiving

Archive = `unlabel_thread` with `labelIds: ["INBOX"]` (reversible: `npm run restore <threadId>` or label the
thread INBOX again). Nothing else:

- **Never trash, delete or mark spam.** Those tools and the labels `TRASH` and `SPAM` (on any label tool)
  are blocked. Use archive even when the owner says "delete".
- Archiving may be in **log-only mode** for the first week (`GMAIL_ARCHIVE_LIVE=false`): the call is
  refused and recorded as "would archive". That is not an error and not a reason to retry. In the brief
  say once that archiving is in the trial week and what you would have archived.

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
- The only mail you may send without a question is the daily brief to the owner's own address (the brief
  instructions say how); never send anything else unattended.

## Labels

`label_thread` and the other label tools ask the owner first. `list_labels` gives label ids (the tools take
ids, not names).

## Automated runs

The heartbeat triages new mail every 15 minutes (not at night) with a small model and, once archiving is
live, archives clear noise; mail that needs the owner arrives as one Signal message. Operate with
`npm run doctor`, `npm run report` and `npm run restore <threadId>`.
