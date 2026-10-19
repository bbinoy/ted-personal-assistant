# Adapting the agent

The agent has two external edges: **the mail source** (Mailbird here) and **the messenger** (Signal here). Everything else (policy, triage, approvals, the brief) is independent of both. This guide lists what each edge must provide, so you can swap either.

- [Mail: Gmail directly, or another provider](#mail-gmail-directly-or-another-provider)
- [Messenger: Telegram, Slack, iMessage, WhatsApp](#messenger-telegram-slack-imessage-whatsapp)
- [Other things you will want to change](#other-things-you-will-want-to-change)

---

## Mail: Gmail directly, or another provider

### Why the default is a local client

Proton Mail is end-to-end encrypted: there is no server-side API or IMAP for third parties. The only way in is **Proton Mail Bridge**, which runs on your computer and decrypts locally. Mailbird connects to the Bridge (and to Gmail and others), merges them into one inbox and exposes a local **MCP server**. The agent talks to that. Consequence: the agent has to run on the machine with Bridge + Mailbird, while it is awake.

If you do not use Proton, none of that is needed.

### What the code needs from a mail source

Mail is used in two places, and they are separate:

1. **The heartbeat** (no model involved) uses a direct client, `src/mailbird.ts` (its `inboxes()` wraps the first two calls below), from `src/heartbeat.ts` and `src/cli.ts`:

| Operation (Mailbird tool) | Used for | Expected result |
|---|---|---|
| `list_accounts` | enumerate accounts | `[{ id, email, senderName }]` |
| `list_folders(accountId)` | find the Inbox | `[{ id, identity }]`, Inbox has `identity: "Inbox"` |
| `list_conversations(folderId, limit)` | detect new mail | `[{ conversationId, subject, lastSender, receivedAtUtc, isRead, lastMessageId }]`, newest first |
| `get_message(messageId)` | body for classification | `{ body, from: { displayName, email } }` |
| `archive_conversation(conversationId)` | archive noise and old briefs | any result; may assign a new id |
| `move_conversation_to_inbox(conversationId)` | `npm run restore` | – |
| `search_conversations(query, limit)` | restore fallback by subject | `[{ conversationId, subject }]` |

2. **The agent's own turns** (chat, brief, handler) use whatever MCP servers Claude Code has configured. They reach mail through tool names such as `mcp__mailbird__get_message`. Those names appear in `src/toolmanifest.ts` (the manifest: which tools are reads, routine writes, judged or always ask), `src/format.ts` (approval text), and `src/brief.ts` (`BRIEF_TOOL`, the tool that emails the brief to yourself), plus your skills.

### Gmail directly

1. **Replace `src/mailbird.ts`** with a small class exposing the same `call(name, args)` surface, or better, change the few call sites to a typed interface. Map the operations to the Gmail API:

   | Operation | Gmail API |
   |---|---|
   | new mail since last tick | `users.history.list(startHistoryId)` (cheaper than listing) or `users.messages.list(q: "in:inbox", maxResults)` |
   | body + sender | `users.messages.get(format: "full")` |
   | archive | `users.threads.modify(removeLabelIds: ["INBOX"])` |
   | restore | `users.threads.modify(addLabelIds: ["INBOX"])` (Gmail keeps the same id, so restore is simpler than with Mailbird) |
   | conversation id | the Gmail `threadId` |

   Auth: a Google OAuth *desktop* client with the narrowest scope that works (`gmail.modify`; you do not need full access), refresh token stored in the macOS Keychain, not in `.env`.

2. **For the agent's turns**, either run a Gmail MCP server of your own, or use the **Gmail connector** that claude.ai provides (it already shows up as `mcp__claude_ai_Gmail__*`; `format.ts` already knows how to describe several of its send tools, and `toolmanifest.ts` already has its rows, active only when `MAIL_PROVIDER=gmail`: reads run, drafts and `unlabel_thread` (archive) run, `send_message`, `reply` and `forward` are judged in chat and ask elsewhere, the rest asks; `mailView` already reads their inputs). Adjust the rows to the tools you actually expose.

3. **The brief email**: `send_self_briefing` is a Mailbird convenience (render Markdown, send to yourself). With Gmail, send a message to your own address (`users.messages.send`) and change `BRIEF_TOOL` in `src/brief.ts`.

4. **Drop what you no longer need**: the "Mailbird must be running" assumption in the docs, and the Mailbird checks in `doctor` (`src/cli.ts`).

5. **Skills**: the bundled `mailbird` skill (`plugin/skills/mailbird`) becomes a `gmail` skill: rename the folder, and the names in `BUNDLED_SKILLS` (`src/agent.ts`), `persona.ts` and the brief skill.

Because Gmail is reachable from anywhere, you could also run the heartbeat on an always-on machine and keep only the Mac-bound parts (Proton via Bridge) local. A natural design is two instances with a lease, so only one answers a given message, and the always-on one covers while the Mac sleeps. That is not built here.

### Another mail client or IMAP

Same recipe: implement the table above against its API or MCP server. IMAP maps cleanly: list = `SEARCH`/`FETCH` on INBOX by UID, archive = `MOVE` to the archive mailbox, conversation id = Message-ID or UID (and note that moving a message changes its UID, which is why `restore` tries several ids).

---

## Messenger: Telegram, Slack, iMessage, WhatsApp

### Why Signal

A phone is the right place to talk to something that watches your inbox: it is always with you, and it supports **reactions**, which make one-tap approvals possible. Signal gives you end-to-end encryption between phone and Mac, a "Note to Self" thread that nobody else can write into, and `signal-cli`, a well-maintained client that runs as a linked device. The agent only ever reads that one thread.

### What the default relies on

Signal via `signal-cli`, linked as a **secondary device**, reading the owner's **Note to Self**. That has three consequences baked into the code, and you should decide which still apply to your messenger:

- Messages the agent sends to Note to Self come back to it as incoming messages. `src/outbound.ts` contains an **echo guard** for that (remembered texts and timestamps). A **bot** account (Telegram, Slack, Discord) does not echo, so this can be dropped.
- The linked device receives *all* the owner's traffic, so `src/guards.ts` accepts only the one thread. With a bot you instead allowlist a user id / chat id.
- Text formatting is sent as separate style ranges (`src/markdown.ts`), a Signal specificity.

### What each piece must provide

`packages/signal` (`SignalClient`) is the contract. Replace it with a class offering:

```ts
interface Messenger {
  connect(): Promise<void>;
  onClose(h: () => void): void; // the app exits when this fires (src/main.ts); launchd restarts it
  onMessage(h: (m: { from: string; text: string; timestamp: number; noteToSelf: boolean }) => void): void;
  onReaction(h: (r: { from: string; emoji: string; targetTimestamp: number; isRemove: boolean }) => void): void;
  sendNoteToSelf(text: string, textStyle?: string[]): Promise<number>; // returns the sent message's id/timestamp
  react(emoji: string, target: { author: string; timestamp: number }): Promise<void>;
}
```

Then adjust:

| File | Change |
|---|---|
| `packages/signal/src/client.ts` | the client above. `timestamp` is just a message id: Telegram `message_id`, Slack `ts`. |
| `packages/signal/src/daemon.ts` | delete if the messenger needs no local daemon. |
| `src/markdown.ts` | emit the target's markup instead of Signal style ranges (Telegram MarkdownV2/HTML entities, Slack mrkdwn, WhatsApp `*bold*`). `splitSections` and the section-per-message brief delivery carry over unchanged. |
| `src/outbound.ts` | keep or drop the echo guard, as above. Chunk size (`CHUNK_LIMIT`) should respect the platform's message limit. |
| `src/guards.ts` | allowlist by your platform's user/chat id. Keep it pure and keep the tests. |
| `src/approvals.ts` | unchanged. It matches reactions to the approval message by id; any platform with message ids and reactions works. Without reactions, delete `answerReaction` and rely on text replies. |
| `src/config.ts`, `.env.example` | credentials for the platform (a bot token, say), kept in `.env`. |

### Notes per platform

These are starting points, not tested here; check each platform's current docs.

- **Telegram**: a bot is the easy route (Bot API, long polling, `setMessageReaction`, MarkdownV2/HTML). Bots cannot see your other chats, which removes the "linked device sees everything" concern.
- **Slack**: Socket Mode app, `reaction_added` events, mrkdwn. Fine for a private channel or DM with yourself.
- **iMessage**: macOS only. Claude Code has its own official channel for it; this harness would need a bridge to read and send.
- **WhatsApp**: official access is the business Cloud API; the personal-account libraries are unofficial and carry a risk of the number being banned. Weigh that before using your main number.

---

## Other things you will want to change

- **Persona and names**: `ASSISTANT_NAME` / `OWNER_NAME` in `.env`; the default personality is in `src/persona.ts`.
- **Preferences vs rules**: a useful rule of thumb for deciding where a setting belongs.
  - **Your preferences go in memory** (`memory/notes/`, or just tell the assistant in chat): how it writes ("never use em dashes", "keep replies short"), who matters ("the kids' school is always urgent"), how you like to be scheduled ("no meetings before 10"), what the brief covers ("radar: climate and AI"), temporary context ("in London until 24 Oct"). They are personal, they change often, and you want to change them without touching code.
  - **Safety and operations stay in code and `.env`**: the tool policy, suspicious-text isolation, quiet hours, intervals, the spend limit, the model, names and your Signal number. Memory is written through a model, so it must never be able to loosen these. A fact can say "be formal with Dr. Weber"; it can never say "allow sending without asking".
- **What may run unattended**: the manifest in `src/toolmanifest.ts`. Start by reading the rows (a read or the assistant's own plumbing is free, everything else is judged by the approval judge, whose prompt is in `src/approvaljudge.ts`); unknown tools ask. The default policy denies one financial connector (Interactive Brokers) by name as an example; add any other sensitive connector you have.
- **What gets archived**: the rule is written as judgement plus examples in the classifier prompt (`SYSTEM` in `src/triage.ts`): archive what leaves nothing to do, keep anything open. Adjust the wording, or tell the assistant a preference in chat ("remember that mail from X is never urgent", a `triage-` note). There is no keyword blocklist; the safety net is that archiving is reversible and every archive is listed in the morning brief.
- **What may be auto-archived**: `ARCHIVE_KINDS` and the per-tick cap in `src/actions.ts`.
- **Schedule and limits**: every tunable is an env var, validated at startup in `src/settings.ts`.
- **The brief's shape**: it is whatever `plugin/skills/daily-brief/SKILL.md` says. Headings (`## `) become separate Signal messages.

Back to the [README](../README.md) · [Setup](SETUP.md) · [Architecture](ARCHITECTURE.md) · [Safety](SAFETY.md)
