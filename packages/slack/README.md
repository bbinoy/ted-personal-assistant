# Slack messenger: setup and design

Status: **not built yet.** This package is a skeleton. `createMessenger` throws "slack messenger is not built yet" and `npm run doctor` says so. This file is the design to build it from later. Signal stays the default.

Contract: implement `Messenger` from `packages/messenger/src/index.ts` and export `createMessenger(config)` and `doctor(...)` from `src/messenger.ts` (entry `./messenger`).

## What to create on Slack

Use **Socket Mode**: the app opens an outbound WebSocket to Slack, so no public URL, tunnel or webhook is needed (the right fit for a home machine).

1. Create a Slack app at api.slack.com/apps ("From scratch", in the owner's workspace; a free workspace is enough).
2. Settings -> Socket Mode -> enable.
3. Basic Information -> App-Level Tokens -> generate one with scope `connections:write` (this is the **app token**, `xapp-...`).
4. OAuth & Permissions -> Bot Token Scopes: `chat:write`, `app_mentions:read`, `im:history`, `im:read`, `im:write`, `channels:history`, `groups:history`, `channels:read`, `groups:read`, `reactions:read`, `reactions:write`, `files:read`, `files:write`, `users:read`. Add `mpim:history` if group DMs are wanted.
5. Event Subscriptions -> enable, subscribe the bot to `message.im`, `app_mention`, `message.channels`, `message.groups`, `reaction_added`, `reaction_removed`, `message_changed` / `message_deleted` arrive as `message` subtypes.
6. App Home -> allow messages from the Messages tab.
7. Install to workspace; copy the **bot token** (`xoxb-...`).
8. Invite the bot to the channels it should answer in (`/invite @Ted`).

## Secrets

- Two secrets: the bot token (`xoxb-`) and the app token (`xapp-`).
- Both go in only through the local CLI (`npm run slack -- setup`, hidden prompts) or a one-time link on the owner's machine, into the secret store or `.env`. **Never through chat**, and never in logs or errors. Slack will revoke tokens it sees posted publicly; if one leaks, rotate it in the app settings.

## Messenger interface -> Slack API

| Messenger | Slack |
|---|---|
| `start()` | `auth.test` (bot user id, team), then `apps.connections.open` with the app token and a WebSocket to the returned URL; acknowledge every envelope by its `envelope_id` within 3 s |
| `stop()` | close the socket |
| `onClose` | socket closed past the reconnect budget (Slack asks clients to reconnect regularly: handle `disconnect` envelopes by reconnecting before reporting a close); `invalid_auth` |
| `onMessage` | `message` events in DMs (`channel_type: im`) -> `direct`; in channels / private channels / group DMs -> `group`; `app_mention` and `<@bot>` in text, or a reply in a thread the bot started -> `addressedToMe`; `<@U123>` rewritten to `@name`; `thread_ts` -> `quote`; `files` -> `audio` / `image` / `file`; subtype `message_changed` -> `edited` |
| `onReaction` | `reaction_added` / `reaction_removed` (emoji names, converted to emoji) |
| `onDeletion` | `message` subtype `message_deleted` (`deleted_ts`) |
| `send(target, message)` | `chat.postMessage` (`channel`, `text` with Slack mrkdwn from `styles`, `thread_ts` for `quote`); files via `files.getUploadURLExternal` + `files.completeUploadExternal`; returns the message `ts` as the timestamp |
| `react` | `reactions.add` (emoji name, not the character: map; replacing means `reactions.remove` the earlier one) |
| `typing` | no typing indicator for bots over Socket Mode: no-op (best effort, never throws) |
| `markRead` | not supported: no-op |
| `groups()` | `users.conversations` (types `public_channel,private_channel,mpim`) the bot is in, members via `conversations.members` |
| `attachmentFile(ref)` | download `url_private_download` with the bot token (bearer) into the attachments folder, with a size cap |
| `readLongText` | not needed; return `undefined` |
| `self` | the bot user id from `auth.test` |

Targets: the owner's chat is `undefined` (the IM channel with the owner, found with `conversations.open`); a channel or group DM is its channel id (`C...`, `G...`); another person's DM is `directTarget(userId)` (`U...`). Slack's message `ts` is a string like `1700000000.000200`; the interface needs a number, so use it as a number (microsecond-unique per channel) and format it back to the same six decimals.

Threads: a reply to a thread is `quote`; the assistant's answer to a channel message goes into that message's thread (`thread_ts`) to keep the channel readable.

## Capability flags

```ts
{
  reactions: true,        // reactions.add
  typing: false,          // no typing indicator for bots here
  readReceipts: false,    // none
  groups: true,           // channels, private channels, group DMs; mention or thread reply to address
  people: true,           // any workspace member can DM the bot: the app decides who is allowed
  voice: false,           // no voice notes; audio is a file upload (clips from users arrive as audio files)
  quotes: true,           // threads
  maxMessageBytes: 4000,  // 40,000 characters is the hard cap, but long blocks are truncated in display; split at 4000
  voiceFormat: "m4a"      // unused while voice is false
}
```

## Owner identification and pairing

Slack gives a stable member id (`U...`) per workspace and the workspace controls who can DM the bot. Still pair explicitly: setup prints a one-time code (single use, expiring, hashed); the first member who DMs the bot the right code becomes the owner and the id is stored. Unknown senders get one fixed reply with no model call. Also check `team_id` on every event so another workspace (Slack Connect) cannot reach the assistant.

## Tests to write

A fake Slack in `src/testing.ts` (entry `./testing`), like `packages/signal/src/testing.ts`: a local HTTP server for the Web API methods above and a local WebSocket (Node 24 has a global `WebSocket` client; the server side needs a tiny hand-written upgrade handler to stay dependency-free) that pushes Socket Mode envelopes, expects acknowledgements, sends `disconnect`, and misbehaves (drop, 429 with `Retry-After`, `invalid_auth`). Cover: envelope acknowledgement, event parsing (DM, channel, mention, thread, files, edit, delete, reactions), mention rewriting, `team_id` filtering, reconnect, message splitting at the limit, thread targets, pairing (right, wrong, reused, expired, unknown sender), tokens never in logs or errors, and the shared conformance tests if they exist.

## Doctor

The doctor names the active messenger, then reports: bot token valid (`auth.test`), app token valid (`apps.connections.open`), socket connected, required scopes present (`X-OAuth-Scopes` response header), owner paired, and the privacy note. Until it is built: one line, not built yet.

## Privacy

Slack is **not end-to-end encrypted**: Slack stores messages on its servers, and workspace admins (and, depending on the plan, compliance exports) can read them, including everything said to the assistant. Use a workspace the owner controls alone, and note it in docs/SAFETY.md when built.
