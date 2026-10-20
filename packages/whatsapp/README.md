# WhatsApp messenger: setup and design

Status: **not built yet.** This package is a skeleton. `createMessenger` throws "whatsapp messenger is not built yet" and `npm run doctor` says so. This file is the design to build it from later. Signal stays the default.

Contract: implement `Messenger` from `packages/messenger/src/index.ts` and export `createMessenger(config)` and `doctor(...)` from `src/messenger.ts` (entry `./messenger`).

## What to create on WhatsApp

The supported route is the **WhatsApp Business Platform (Cloud API)** from Meta.

1. A Meta developer account and a Meta app of type Business at developers.facebook.com, with the WhatsApp product added.
2. A WhatsApp Business account (WABA) and a phone number for the assistant. The test number Meta provides can message up to 5 verified recipient numbers (enough for the owner alone); a production number must not be registered on the ordinary WhatsApp app.
3. A permanent access token: create a System User in Business Settings, give it the app and the WABA, generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`. (The temporary token from the dashboard expires in 24 hours.)
4. A webhook: a public HTTPS URL that Meta calls for every incoming message. A home machine has none, so run a tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel) to a small local HTTP listener. Subscribe the app to the `messages` field. Meta verifies the URL with a GET carrying `hub.verify_token` and `hub.challenge`.
5. Approved message templates, for anything the assistant sends first (see 24 hour window).

## Secrets

- Access token (system user), app secret (to verify webhook signatures), webhook verify token (random, chosen by the owner), phone number id.
- Tokens and the app secret go in only through the local CLI (`npm run whatsapp -- setup`, hidden prompts) or a one-time link opened on the owner's machine, into the secret store or `.env`. **Never through chat.** Never log them. The phone number id and the WABA id are identifiers, not secrets.
- Verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret) on every webhook call; reject anything else. The listener must not be reachable for anything but the webhook path.

## Messenger interface -> Cloud API

| Messenger | WhatsApp Cloud API (`graph.facebook.com/<version>/<phone-number-id>`) |
|---|---|
| `start()` | start the local webhook listener, check the token (`GET /<phone-number-id>`), check the tunnel answers the verify handshake |
| `stop()` | close the listener |
| `onClose` | listener failure; token rejected (HTTP 401 / error code 190) |
| `onMessage` | webhook `messages`: `text`, `audio` (voice notes are OGG/Opus), `image`, `document`, `context.id` -> `quote`, `button` / `interactive` replies as text. Media arrives as an id, resolved later |
| `onReaction` | webhook message type `reaction` (`emoji`, `message_id`; an empty emoji means removed) |
| `onDeletion` | webhook message type `unsupported` / revoked messages are not reliably delivered: never fires, document it |
| `send(target, message)` | `POST /messages` with `type` text / image / document / audio (`voice: true` for a voice note), `context.message_id` for `quote`; outside the 24 h window only an approved template; returns the sent `wamid` mapped to a number |
| `react` | `POST /messages` type `reaction` |
| `typing` | `POST /messages` with `status: "read"` and `typing_indicator: {type: "text"}` (shows typing up to 25 s) |
| `markRead` | `POST /messages` with `status: "read"` and the incoming `message_id` |
| `groups()` | return `[]` in the first version (the Groups API is limited and not assumed) |
| `attachmentFile(ref)` | `GET /<media-id>` for a short-lived URL, then download with the bearer token into the attachments folder; media URLs expire in 5 minutes |
| `readLongText` | not needed; return `undefined` |
| `self` | the business phone number |

Targets: the owner's chat is `undefined`; other people are `directTarget(waId)` (the sender's `wa_id`, digits only). WhatsApp message ids are strings (`wamid...`): keep a map from the numeric timestamp the interface needs to the `wamid`, persisted under `state/`.

## 24 hour window and templates

The assistant may send free-form messages only within 24 hours after the contact's last message. After that, only a pre-approved **template** message is allowed (Meta reviews templates; categories are priced differently). Consequences for the build: the heartbeat, daily brief and reminders that start a conversation need a template (for example "Your daily brief is ready, reply to read it") and the real content follows once the owner replies. `send` must detect error code 131047 (re-engagement required) and fall back to the template, or fail clearly.

## Capability flags

```ts
{
  reactions: true,        // reaction messages
  typing: true,           // typing_indicator on the read call (verify against the current API version)
  readReceipts: true,     // mark as read
  groups: false,          // not assumed in the first version
  people: true,           // other numbers can write to the business number: the app decides who is allowed
  voice: true,            // audio message sent as a voice note
  quotes: true,           // context.message_id
  maxMessageBytes: 4096,  // text body limit is 4096 characters; 4096 bytes is the safe bound
  voiceFormat: "ogg-opus" // voice notes are OGG/Opus
}
```

Media limits: audio 16 MB, images 5 MB, documents 100 MB (check current docs); use the lower of these and the interface's `MAX_*_BYTES`.

## Owner identification and pairing

Only numbers that have messaged the business number can reach the assistant, but the number is public to anyone who knows it. Pair like Telegram: a one-time code (single use, expiring, hashed) shown by `npm run whatsapp -- pair` with a `https://wa.me/<number>?text=<code>` link and QR; the first sender of the right code becomes the owner and its `wa_id` is stored. Unknown senders get one fixed reply, with no model call. With the test number, only the verified recipients can write at all.

## Tests to write

A fake Graph API server in `src/testing.ts` (entry `./testing`), like `packages/signal/src/testing.ts`: answers `/messages`, `/<media-id>`, media downloads, can POST signed webhook payloads to the listener (and bad signatures), and can return error codes (131047, 190, 429). Cover: webhook verification handshake, signature check (good, bad, missing), parsing of each message type, media download and expiry, the wamid <-> number map across a restart, the 24 h window fallback to a template, message splitting at the size limit, pairing (right, wrong, reused, expired, unknown sender), tokens and the app secret never in logs or errors, and the shared messenger conformance tests if they exist.

## Doctor

The doctor names the active messenger, then reports: token valid, phone number id reachable, webhook reachable through the tunnel (verify handshake), app secret set, owner paired, last webhook seen, and the privacy note. Until it is built: one line, not built yet.

## Privacy

WhatsApp chats are end-to-end encrypted between people, but **not with the Cloud API**: messages to and from a business number pass through, and are processed by, Meta's servers. Treat it as readable by Meta. Note it in docs/SAFETY.md when built.

## Unofficial alternative (warned)

Libraries such as Baileys speak the WhatsApp Web protocol and let the assistant run as a linked device of a personal number with no business account, no webhook and no templates. **Do not use it for anything that matters:** it violates WhatsApp's terms, accounts get banned without warning, it breaks when the protocol changes, and it needs a runtime dependency plus a stored session that is as sensitive as the account itself. If anyone builds it anyway, it must be a separate package, never the default, with this warning in its README.
