---
name: gmail
description: Gmail connector tools and quirks (MAIL_PROVIDER=gmail) - searching, reading, archiving, drafting and sending with `mcp__claude_ai_Gmail__*`. Load with `ted-personal-assistant:mail`, which holds the rules.
---

# Gmail (claude.ai connector)

Gmail comes through the owner's Claude account like Notion does: tools named
`mcp__claude_ai_Gmail__*`. If they are missing, the connector is not connected:
say so and tell the owner to connect Gmail in their Claude account (Settings,
Connectors); do not try anything else. The mail rules (triage, drafting, sending) are
in `ted-personal-assistant:mail`; this file holds what is particular to Gmail.

The tools you have: `search_threads`, `get_thread`, `get_message`, `get_draft`,
`list_drafts`, `list_labels`, `create_draft`, `update_draft`, `reply`, `forward`,
`send_message`, `unlabel_thread`, `label_thread`. Ids are strings. Arguments are camelCase
(`threadId`, `messageId`, `labelIds`, `messageFormat`).

- **Listing and reading.** `search_threads` with Gmail search syntax: `in:inbox`,
  `is:unread`, `newer_than:2d`, `from:`, `subject:`. The sweep lists the whole inbox
  (`in:inbox`, paging with the page token until it ends, oldest included). Sent mail:
  `in:sent newer_than:7d`. Rows carry sender, subject, snippet and date. Open with
  `get_thread` and `messageFormat: "PLAIN_TEXT"` (never `RAW`).
- **Attachments**: never read or open their content; if the owner needs it, tell them
  to open it in Gmail.
- **Archive** = `unlabel_thread` with `labelIds: ["INBOX"]` (reversible: `npm run restore
  <threadId>` or label the thread INBOX again). Never trash, delete or mark spam: those
  tools and the labels `TRASH` and `SPAM` (on any label tool) are blocked.
- **Drafts**: `create_draft` (for a reply pass `replyToMessageId` so it stays in the
  thread) and `update_draft`. Plain text in `body`, no Markdown; one blank line between paragraphs, and read the saved draft back before any send. Show it in chat as the mail skill says.
- **Sends**: `send_message` (a new mail, or a draft by `draftId`), `reply` and `forward`
  ask on the owner's phone or are judged against what they just told you. In `reply`,
  give the text and the `messageId` of the latest message in the thread.
- **Labels**: `label_thread` and the other label tools are routine upkeep, done without
  asking. `list_labels` gives label ids (the tools take ids, not names).
