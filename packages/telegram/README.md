# Telegram messenger: setup and design

Status: **not built yet.** This package is a skeleton. `createMessenger` throws "telegram messenger is not built yet" and `npm run doctor` says so. This file is the design to build it from later. Signal stays the default and the supported route (`MESSENGER` unset means `signal`).

Contract: implement `Messenger` from `packages/messenger/src/index.ts` and export `createMessenger(config)` and `doctor(...)` from `src/messenger.ts` (entry `./messenger`). Read that interface first; it is the spec.

## What to create on Telegram

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, choose a display name and a username ending in `bot`. BotFather replies with the bot token (`123456:ABC...`). Creating the bot stays manual: no userbot, no login to the owner's Telegram account.
2. `/setprivacy` -> Disable only if the bot should read every message in groups. The default (enabled) is the safer one: in groups the bot sees only commands, @mentions of it and replies to its own messages, which is exactly what `addressedToMe` needs. Changing privacy mode only takes effect after the bot is removed from and re-added to a group.
3. `/setjoingroups` -> Disable if the bot should never be added to groups by strangers.
4. Optional: `/setuserpic`, `/setdescription`.

## Secrets

- One secret: the bot token. Anyone with it controls the bot.
- It goes in only through the local CLI (`npm run telegram -- setup`, a hidden prompt) into the secret store or `.env`, or through a one-time link the owner opens on her own machine. **Never paste it into the chat** (with the assistant, with Claude, anywhere) and never log it: the code must keep it out of logs, error messages, URLs in thrown errors (the Bot API puts the token in the URL path: redact it) and test output.
- If it leaks: `/revoke` in BotFather, then run setup again.

## Messenger interface -> Bot API

| Messenger | Telegram Bot API |
|---|---|
| `start()` | `getMe` (verify token, learn bot id and username), then long-poll loop `getUpdates` (timeout 30-50 s, `allowed_updates`: `message`, `edited_message`, `message_reaction`; offset persisted under `state/`). Never use webhooks together with polling (`deleteWebhook` first). |
| `stop()` | abort the in-flight poll, persist the offset |
| `onClose` | fires when polling fails past the retry budget or on `stop()`; HTTP 401 means the token is revoked; HTTP 409 means a second poller is running |
| `onMessage` | `message` updates: text, `voice` (OGG/Opus) -> `audio`, `photo` (largest size) -> `image`, `document` -> `file`, `reply_to_message` -> `quote` and `quotedAudio`, `entities` mentions -> `@name` text and `addressedToMe`; `edited_message` -> `edited` |
| `onReaction` | `message_reaction` updates (needs `allowed_updates`, and the bot must be a group admin to get them in groups) |
| `onDeletion` | not offered by the Bot API to bots (no deletion updates): never fires. Document it, do not fake it |
| `send(target, message)` | `sendMessage` (text, `entities` from `styles`, `reply_parameters` for `quote`), `sendPhoto`, `sendDocument`, `sendVoice` (OGG/Opus) for `voice` attachments; split text at the size limit; returns the sent `message_id` as the timestamp (see "Timestamps") |
| `react(target, message, emoji)` | `setMessageReaction` (bots may use only Telegram's allowed reaction emoji list; map or skip others; never throws) |
| `typing(target, on)` | `sendChatAction` `typing` (lasts ~5 s: repeat while on; `on = false` just stops repeating) |
| `markRead` | not supported (capability false) |
| `groups()` | the Bot API cannot list a bot's groups: keep the chats seen in updates (`my_chat_member` / messages) under `state/`, enrich with `getChat` and `getChatAdministrators` / `getChatMemberCount` |
| `attachmentFile(ref)` | `getFile` then download from `https://api.telegram.org/file/bot<token>/<file_path>` into the attachments folder (Bot API downloads are limited to 20 MB; uploads to 50 MB) |
| `readLongText` | not needed: Telegram delivers long text whole; return `undefined` |
| `self` | the bot's username from `getMe` |

Targets (opaque strings): the owner's own chat is `undefined`; a group is its chat id as a string (negative number, never starting with `to:`); another person's private chat is `directTarget(userId)` (the numeric user id; for private chats chat id equals user id). Sender id (`fromUuid`) is the numeric user id; `from` is `@username` when there is one, else empty.

Timestamps: Telegram message ids are per chat integers and `date` has one-second resolution. The interface needs a number unique within the conversation that doubles as the id: use `message_id` as the timestamp, and map back when replying or reacting.

## Capability flags

```ts
{
  reactions: true,        // setMessageReaction, restricted emoji set
  typing: true,           // sendChatAction
  readReceipts: false,    // the Bot API has no read marker; degrade quietly
  groups: true,           // groups, supergroups; privacy mode decides what the bot sees
  people: true,           // anyone can message the bot: the app decides who is allowed (pairing below)
  voice: true,            // sendVoice, shown as a voice note
  quotes: true,           // reply_parameters
  maxMessageBytes: 4096,  // 4096 characters per message; 4096 bytes is the safe bound
  voiceFormat: "ogg-opus" // sendVoice needs OGG/Opus
}
```

Other limits: 50 MB upload through the Bot API, 20 MB download. Use `MAX_AUDIO_BYTES`, `MAX_IMAGE_BYTES`, `MAX_FILE_BYTES` from the interface where they are lower.

## Owner identification and pairing

The bot is public by username: anyone can message it. So the owner must be paired, not guessed.

- Setup (or `npm run telegram -- pair`) prints a one-time pairing code (single use, expiring, stored hashed; this package will carry its own: the app no longer has a code store).
- Setup shows a deep link `https://t.me/<bot>?start=<code>` and a terminal QR code (only if small and dependency-free; else just the link). One tap, press Start, the code is sent for you, and Ted greets the owner in the same chat.
- The first account that sends `/start <code>` becomes the owner, nobody else. The numeric user id is stored. No phone number is needed or asked for (a bot cannot look one up, and the first message always comes from the user).
- Before pairing, and for every unknown sender afterwards, the reply is fixed text with no model call (same as `src/tenants/tenantroute.ts`).
- Friends use the app's open registration (a stranger is held and the owner is asked in her own chat, `src/tenants/registration.ts`), not codes.
- Group use: the bot answers only in groups the owner added it to. Messages relayed by the agent can never grant ownership.

## Setup flow to build

`npm run telegram -- setup`: explains the BotFather steps in a few lines, takes the token at a hidden prompt, verifies it with `getMe`, stores it, prints the pairing code and link. `MESSENGER=telegram` goes in `.env`. Install only on this choice: `npm install -w packages/telegram`. A real build adds a runtime entry (`.`) or scripts as needed; keep it dependency-free (plain `fetch`, a timeout and a size cap on every call).

## Tests to write

A fake Bot API server in `src/testing.ts` (entry `./testing`), like the fake daemon in `packages/signal/src/testing.ts`: a local HTTP server that answers `getMe`, `getUpdates` (long poll, offsets), `sendMessage`, `sendVoice`, `sendPhoto`, `sendDocument`, `setMessageReaction`, `sendChatAction`, `getFile` and file downloads, can push updates and misbehave (401, 409, 429 with `retry_after`, hang up, slow). Cover:

- update parsing: text, voice, photo, document, reply as quote, mentions, edits, reactions
- offsets: persisted, no update handled twice after a restart
- pairing: right code, wrong code, reuse, expiry, unknown sender gets the fixed reply and no model call
- message splitting at the size limit (also inside multi-byte characters and styled ranges)
- voice conversion to OGG/Opus
- reaction mapping to the allowed emoji list
- group mention and reply detection with privacy mode on
- the token never appearing in logs or errors
- shared messenger conformance tests, if `packages/messenger` provides them

Fake values only; no live token in tests. A live test needs the owner's bot token and stays a manual step.

## Doctor (`npm run doctor`)

The doctor names the active messenger, then this package reports: token present and valid (`getMe`), polling healthy (last successful `getUpdates`), webhook not set, owner paired, privacy mode note (`getMe` returns `can_read_all_group_messages`), and the encryption note below. Until it is built it reports one line: not built yet.

## Privacy

Telegram bot chats are **not end-to-end encrypted**: Telegram's servers can read everything said to the bot, unlike Signal. Note it in docs/SAFETY.md when this is built, and let the owner choose knowingly.

## Future decision (not made, do not act on it)

An earlier plan proposed making Telegram the default setup route: new installs lead with Telegram (fastest route: create the bot, paste the token, tap the link, press Start), `MESSENGER` unset would mean `telegram`, `.env.example` would show `MESSENGER=telegram`, and Signal would be the documented alternative with a short README section "Signal instead of Telegram" (benefit: Signal is end-to-end encrypted; Telegram gives the assistant its own contact with no second phone number). The owner has decided against it for now: **Signal stays the default and the owner's setup does not change.** If revisited, first put an explicit `MESSENGER=signal` in the owner's real `.env`, and verify with `npm run doctor` after the restart that the messenger is still Signal; update the default-settings test, docs/SETUP.md, the README, docs/SAFETY.md and the doctor messages together.
