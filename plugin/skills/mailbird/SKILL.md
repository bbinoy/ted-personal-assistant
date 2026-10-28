---
name: mailbird
description: Mailbird tools and quirks - listing, reading, archiving and drafting with the `mailbird` MCP server, and fixing it when it shows as disconnected or unauthorized. Load with `ted-personal-assistant:mail`, which holds the rules.
---

# Mailbird MCP

The owner's Mailbird Next app exposes a local MCP server (`mailbird`, user scope).
The mail rules (triage, drafting, sending) are in `ted-personal-assistant:mail`; the
server's own `initialize` instructions give routing and argument shapes. This file
holds what is particular to Mailbird.

- **Listing.** Per account (`list_accounts`), list the Inbox itself with
  `list_conversations` (`limit` 200 or the most the tool allows; page or batch by
  date when it is bigger). `summarize_all_inboxes` may add previews for the newest.
  Fire the per-account list calls in one turn. Sent mail: the Sent folder
  (`list_folders`, then `list_conversations`).
- **Reading** is `get_message` with the row's `lastMessageId`. Rows carry only a
  short preview.
- **Archive** is `archive_conversation` (reversible: `npm run restore <id>`). Never
  `trash_conversation` or `delete_conversation_permanently`, never spam or block.
  A conversation id changes when it changes folder: re-list before acting on it.
- **Reply drafts stay in their thread and are saved quietly:** `reply_to_conversation`
  (or `reply_all_to_conversation` for several recipients), with no `select_conversation`,
  no `showInUi` and no `forceNewWindow` (a popup or window steals focus on the desktop).
  Give the draft's text in chat. `create_draft` only starts a brand-new mail with no
  thread. The body is HTML with one `<p>` per paragraph, greeting and sign-off included,
  because plain newlines are flattened when sent. Read the saved draft back before any send.
- **Sending.** Never `send_message_now` before the owner has seen the draft's text and
  said to send it. `confirm: true` is Mailbird's own safety check, not the owner's
  approval.
- **Write actions** need "Allow write actions" on in Mailbird's Wingman AI settings. If
  a write errors because of it, tell the owner; do not retry.
  [Mailbird's setup article](https://nextsupport.getmailbird.com/hc/en-us/articles/40033560742167-Connect-Claude-ChatGPT-and-OpenClaw-to-Mailbird-Next-MCP-Server-Setup).

## When the connection is broken

Only when `claude mcp list` shows `mailbird` failed or tools return 401 errors. The
server is `https://127.0.0.1:<port>/mcp` with a self-signed certificate, which the
`claude` binary will not trust, so it is registered as a stdio bridge
(`NODE_TLS_REJECT_UNAUTHORIZED` is set for that one child process only):

```
claude mcp add mailbird -s user -e NODE_TLS_REJECT_UNAUTHORIZED=0 -- \
  npx -y mcp-remote@latest https://127.0.0.1:<port>/mcp \
  --header "Authorization: Bearer <token>"
```

- `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `CONNECTION_CLOSED`: the wrapper or the env is
  missing; run the command again.
- `401` / "Missing or invalid Authorization header": the token is stale (Mailbird
  makes a new one whenever its MCP toggle is switched). Ask the owner to open
  Mailbird -> Settings -> **Wingman AI**, read the port off "Running on ...", click
  **Copy token** and give you the value; then `claude mcp remove mailbird -s user`
  and add it again with the fresh token and port.

Afterwards a new Claude Code session (or `/mcp` reconnect) is needed.
