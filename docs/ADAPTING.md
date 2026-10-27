# Adapting the agent

The agent has two external edges: **the mail source** (Mailbird or the Gmail connector here) and **the messenger** (Signal here). Everything else (policy, the heartbeat run, approvals, the brief) is independent of both. This guide lists what each edge must provide, so you can swap either, and how to add a tool (a **module**) or a different assistant (a **preset**).

- [Mail: Gmail, or another provider](#mail-gmail-or-another-provider)
- [Add a tool: a module](#add-a-tool-a-module)
- [Add an assistant: a preset](#add-an-assistant-a-preset)
- [Messenger: Telegram, Slack, iMessage, WhatsApp](#messenger-telegram-slack-imessage-whatsapp)
- [Other things you will want to change](#other-things-you-will-want-to-change)

---

## Mail: Gmail, or another provider

### Why the default is a local client

Proton Mail is end-to-end encrypted: there is no server-side API or IMAP for third parties. The only way in is **Proton Mail Bridge**, which runs on your computer and decrypts locally. Mailbird connects to the Bridge (and to Gmail and others), merges them into one inbox and exposes a local **MCP server**. The agent talks to that. Consequence: the agent has to run on the machine with Bridge + Mailbird, while it is awake.

If you do not use Proton, none of that is needed.

### Gmail: MAIL_PROVIDER=gmail

Gmail is built in. Set `MAIL_PROVIDER=gmail` (and `MAIL_SELF_ADDRESS` if the brief may be emailed to you, `BRIEF_EMAIL=on`) and the Gmail module `src/modules/gmail/module.ts` is loaded instead of the Mailbird one: the mail check and the agent's turns use claude.ai's own Gmail connector (`mcp__claude_ai_Gmail__*`, inherited from your Claude login), the rows say what each tool is (reads and drafts run, `unlabel_thread` is the archive, `send_message`, `reply` and `forward` are judged and asked about with the real recipients, the rest asks), `src/modules/gmail/gmailrules.ts` adds the rules a row cannot say (TRASH and SPAM labels, attachment content, the brief to oneself), and the `gmail` skill replaces the `mailbird` one. [SETUP.md](SETUP.md) walks through it; Nothing in `src/` needs replacing.

### A different mail client or IMAP: a module in the `mail` slot

A mail provider is one tool module with `slot: "mail"` (`src/modules/mailbird/module.ts` and `gmail.ts` are the two examples). What it must provide:

1. **Rows** for its tools (see "Add a tool" below), with the actions the policy knows (`read`, `draft`, `reply-draft`, `send`, `reply`, `forward`, `archive`, `restore`, `label`, `select`, `send-self`...) and a `view` on the tools that send, so that an approval can show the real recipients.
2. **The `mail` slot** (`MailSlot` in `src/modules/types.ts`): how the brief is delivered and which tool call is the brief, the brief's instructions, the chat prompt's note about drafts, and how a send is read back (`readBack`, `views`).
3. **The code behind it**, in `src/modules/runtime.ts` bound by the module's name (`MailRuntime`): the client the heartbeat uses (`source()`), `restore`, what to start with the app, and the doctor's check. The heartbeat's client needs these operations (here the Mailbird names):

| Operation (Mailbird tool) | Used for | Expected result |
|---|---|---|
| `list_accounts` | enumerate accounts | `[{ id, email, senderName }]` |
| `list_folders(accountId)` | find the Inbox | `[{ id, identity }]`, Inbox has `identity: "Inbox"` |
| `list_conversations(folderId, limit)` | detect new mail | `[{ conversationId, subject, lastSender, receivedAtUtc, isRead, lastMessageId }]`, newest first |
| `get_message(messageId)` | body for classification | `{ body, from: { displayName, email } }` |
| `archive_conversation(conversationId)` | archive noise and old briefs | any result; may assign a new id |
| `move_conversation_to_inbox(conversationId)` | `npm run restore` | – |
| `search_conversations(query, limit)` | restore fallback by subject | `[{ conversationId, subject }]` |

4. **Hide what the model does not need**: `hide: { prefix, visible, valid, hint }` names the connector's tools the model is shown (every tool schema is sent on every model call); `<MODULE>_TOOLS` in `.env` replaces the list.
5. **A skill** for the provider in `plugin/skills/<name>/` (`skills: [{ name: "mail", required: true }, { name, required: true }]`): the provider-neutral rules are the one `mail` skill, so the provider skill holds only its tool names and quirks, and the provider name added to `MAIL_PROVIDER`'s accepted values in `src/core/settings.ts`.

IMAP maps cleanly onto the table: list = `SEARCH`/`FETCH` on INBOX by UID, archive = `MOVE` to the archive mailbox, conversation id = Message-ID or UID (and note that moving a message changes its UID, which is why `restore` tries several ids). `test/modules.test.ts` and `test/manifestrows.test.ts` check the shape of a new module and pin its rows.

Because Gmail is reachable from anywhere, you could also run the heartbeat on an always-on machine and keep only the Mac-bound parts (Proton via Bridge) local. A natural design is two instances with a lease, so only one answers a given message, and the always-on one covers while the Mac sleeps. That is not built here.

---

## Add a tool: a module

Everything the harness knows about a tool lives in one declaration: `src/modules/<name>.ts` for a tool with no code of its own, or `src/modules/<name>/module.ts` in a folder `src/modules/<name>/` that also holds the code it wraps (server, guard, rules, store; see `src/modules/draw/`). It is a plain `ToolModule` object (`src/modules/types.ts` explains each field). Nothing else in the code names the tool's name. To add one:

1. **Write the module.** Rows say what each tool IS, not whether it may run: `rowsOf(prefix, provider, capability)(action, "tool_a tool_b")` gives one row per tool with an action (`read`, `draft`, `send`, ...) and the capability a conversation needs to be offered it (`cap`; a new capability goes in `CAPABILITIES` in `src/tenants/tenants.ts`: every friend has it by itself, unless it is the owner's alone and goes in `OWNER_ONLY` too; and, if a switch can turn it off, in `SWITCHES` in `src/tenants/capabilityset.ts`). `free: true` (or a list of actions) marks what runs without the approval judge, such as a plain read; everything else is judged, then asked. `untrusted` / `trusted` say whether reading the tool shows text a third party wrote. `connection` says how it is served: `connector` (the owner's claude.ai connector), `in-process` (an MCP server this process builds) or `external` (a separate process or URL), with a `when(ctx)` that decides per run whether the server exists. `floor` can only restrict (a `verdict`, a `judgeNever` list); it can never grant. `titles`, `skills` and `setup` carry the approval titles, the skill the tool brings (`plugin/skills/<skill>/SKILL.md`, `shared` capabilities for a skill friends and groups may load) and the setup questions.
2. **List it** in `src/modules/index.ts` (one line in `registered()`; the order is the order of the run's MCP servers).
3. **Build its server** if it starts one: add an entry under the module's `name` in `RUNTIME` in `src/modules/runtime.ts` (`server`, and a `lifecycle` if the server outlives a run). A connector with `key`, `label` and `skipped` in its `connection` is reported to the prompts, the brief and the doctor when it is down, with no other edit. A tool no module lists is unknown: it asks and is never judged.
4. **Test it.** `test/modules.test.ts` checks the shape (unique names, every row's capability exists, every server is built under the name the module gives it), and `test/manifestrows.test.ts` pins every row, so adding a tool means updating the pinned rows on purpose (`SNAPSHOT_WRITE=1 npm test` regenerates the fixtures, then read the diff).

What a module may not do: decide policy. Whether a call is allowed, asked or denied, the never-allowed set, the capability sets, the approval judge, payments, the address checks and tenant isolation stay central.

---

## Add an assistant: a preset

What makes the harness "Ted" is data in a folder, `assistants/<name>/` (`ASSISTANT_PRESET=<name or folder path>` picks it; default `ted`). To make a different assistant, copy the folder or start a new one that extends it:

1. `assistants/<name>/preset.json` with `"extends": "ted"` and only the keys you change: the **rhythm** (heartbeat interval and quiet hours, the brief's skill and hours, the heartbeat run's day interval, the dream), the **note categories**, the **profile table** (turns, budget and notes of each unattended run) and the assistant's own **skills** (`core`, with the ones the doctor requires, and the `order` of the owner's list). The environment variables of the rhythm still override their defaults.
2. `assistants/<name>/persona/<prompt>.md` for any prompt whose words you change (the personality, the chat, other people's chats, the brief, the gates' default rules...). A text is a template: `{{name}}`, `{{#flag}}...{{/flag}}`, `{{^flag}}...{{/flag}}`; the names each text may use are listed in `PROMPTS` in `src/core/preset.ts`. A text that uses another name, a missing file or an out-of-range number stops the start with a message naming the file.
3. Skills it brings are folders in `plugin/skills/`; a preset lists them as core skills and, for a skill that belongs to a tool, the module brings it instead.
4. `ASSISTANT_NAME`, `OWNER_NAME` in `.env` set the names.

What a preset cannot change: policy, the approval path, isolation, payments, the capability table and the rules block every run gets. It changes how the assistant talks and when it wakes up, never what it may do (`test/preset.test.ts` loads, checks and breaks a preset on purpose).

---

## Messenger: Telegram, Slack, iMessage, WhatsApp

### Why Signal

A phone is the right place to talk to something that watches your inbox: it is always with you, and it supports **reactions**, which make one-tap approvals possible. Signal gives you end-to-end encryption between phone and Mac, a "Note to Self" thread that nobody else can write into, and `signal-cli`, a well-maintained client that runs as a linked device. The agent only ever reads that one thread.

### What the default relies on

Signal via `signal-cli`, linked as a **secondary device**, reading the owner's **Note to Self**. That has three consequences baked into the code, and you should decide which still apply to your messenger:

- Messages the agent sends to Note to Self come back to it as incoming messages. `src/conversation/outbound.ts` contains an **echo guard** for that (remembered texts and timestamps). A **bot** account (Telegram, Slack, Discord) does not echo, so this can be dropped.
- The linked device receives *all* the owner's traffic, so `src/conversation/guards.ts` accepts only the one thread. With a bot you instead allowlist a user id / chat id.
- Text formatting is sent as separate style ranges (`src/conversation/markdown.ts`), a Signal specificity.

### What each piece must provide

The contract is the `Messenger` interface in `packages/messenger/src/index.ts`; Signal is the first implementation (`packages/signal/src/messenger.ts`) and `FakeMessenger` (`@ted-assistant/messenger/testing`) is the one the app's tests run on. A new platform is a package `@ted-assistant/<name>` with an entry point `/messenger` exporting `createMessenger(config)` and `doctor(config)`; `MESSENGER=<name>` loads it by name. The design notes for the platforms nobody has built yet are at the end of this section. It must:

- report what comes in neutrally (`onMessage`, `onReaction`, `onDeletion`, `onClose`) and send (`send`, `react`, `typing`, `markRead`, `groups`, `attachmentFile`, `readLongText`), with a target that is opaque to the app (undefined: the owner's chat; a group id; `directTarget(accountId)` for one other person);
- declare what the platform cannot do (`capabilities`) instead of faking it: no reactions means no status icons, no typing means working / done icons, and so on;
- take its settings as `options` (`unknown` to the interface): export their type, as Signal exports `SignalOptions`, and check them in `createMessenger` with a sentence that names the option;
- **pass the contract suite**: `messengerContract(name, make)` from `@ted-assistant/messenger/contract` is one test suite for every adapter (send and refusal, the best-effort calls that never throw, neutral incoming messages, one handler per kind, groups, attachments, `onClose` once). Give it a rig over your platform's fake server, as `packages/signal/test/contract.test.ts` does over the fake signal-cli daemon.

Then adjust the app-side pieces that carry platform conventions:

| File | Change |
|---|---|
| `src/conversation/markdown.ts` | emit the target's markup instead of Signal style ranges (Telegram MarkdownV2/HTML entities, Slack mrkdwn, WhatsApp `*bold*`). `splitSections` and the section-per-message brief delivery carry over unchanged. |
| `src/conversation/outbound.ts` | keep or drop the echo guard, as above. The platform's message limit is `capabilities.maxMessageBytes`. |
| `src/conversation/guards.ts` | allowlist by your platform's user/chat id. Keep it pure and keep the tests. |
| `src/approvals/approvals.ts` | unchanged. It matches reactions to the approval message by id; any platform with message ids and reactions works. Without reactions, the approval is a text reply. |
| `src/core/settings.ts`, `.env.example` | the platform's settings (a bot token, say), kept in `.env`. |

### Design notes per platform (none of these is built)

Starting points, not tested here; check each platform's current docs. All of them: the bot token or app secret goes in only through the local CLI or a one-time link, never through the chat, and never into a log or an error (the Telegram Bot API puts the token in the URL, so redact it). The owner is paired with a single-use, expiring, hashed code on first contact, and every unknown sender gets one fixed reply with no model call (as `src/tenants/tenantroute.ts` does). Tests run against a small fake server in the package's `src/testing.ts`, as `packages/signal/src/testing.ts` does, through the contract suite.

- **Telegram**: create a bot with @BotFather (`/newbot`; keep privacy mode on, so in groups the bot sees only commands, mentions and replies to it, which is what `addressedToMe` needs; `/setjoingroups` off if strangers must not add it). Long-poll `getUpdates` with the offset persisted (never a webhook at the same time; 401 means a revoked token, 409 a second poller), `sendMessage` / `sendVoice` (OGG/Opus) / `setMessageReaction` (a fixed emoji list) / `sendChatAction`. Message ids are per chat, so use `message_id` as the timestamp. The Bot API cannot list a bot's groups (remember the chats seen), offers no read receipts and no deletion events. Limits: 4096 characters, 20 MB download, 50 MB upload. Pairing by the deep link `https://t.me/<bot>?start=<code>`. Bot chats are not end-to-end encrypted: say so in docs/SAFETY.md. Bots cannot see your other chats, which removes the "linked device sees everything" concern. Signal stays the default; making Telegram the default is a separate owner decision.
- **Slack**: a Socket Mode app (an outbound WebSocket, so no public URL): an app-level token (`xapp-`, scope `connections:write`) and a bot token (`xoxb-`) with scopes for chat, history, reactions, files and users, and events `message.im`, `app_mention`, `message.channels`, `message.groups`, `reaction_added` / `reaction_removed`. Acknowledge every envelope within 3 s and reconnect on `disconnect`. Send with `chat.postMessage` (mrkdwn; answer a channel message in its thread), add reactions by emoji name, no typing indicator and no read receipts for bots. The message `ts` string (`1700000000.000200`) doubles as the timestamp. Check `team_id` on every event so a Slack Connect workspace cannot reach the assistant. Slack is not end-to-end encrypted and workspace admins can read everything: use a workspace the owner controls alone.
- **iMessage**: macOS only. Claude Code has its own official channel for it; this harness would need a bridge to read and send.
- **WhatsApp**: the supported route is the Business Cloud API (a Meta app and a business number, a permanent system-user token, and a public HTTPS webhook, so a tunnel from a home machine; verify `X-Hub-Signature-256` on every call). Free-form messages are allowed only within 24 hours of the contact's last message; anything the assistant starts (the brief, reminders) needs an approved template, so handle error 131047. Message ids are strings (`wamid...`): keep a persisted map to the numeric timestamp. Messages pass through Meta's servers, so they are not end-to-end encrypted. Libraries that speak the WhatsApp Web protocol (Baileys) run as a linked device of a personal number but break the terms, get numbers banned and keep a session as sensitive as the account: never the default, and only as a separate package with that warning.

---

## Other things you will want to change

- **Persona and names**: `ASSISTANT_NAME` / `OWNER_NAME` in `.env`; the personality, the wording of every prompt, the schedule defaults, the note categories and the run limits are one folder, `assistants/ted/` (see "The preset" under "The run model" in ARCHITECTURE.md): copy it or start a new one with `"extends": "ted"`, and set `ASSISTANT_PRESET`. Code is not touched.
- **Preferences vs rules**: a useful rule of thumb for deciding where a setting belongs.
  - **Your preferences go in memory** (`conversations/owner/notes/`, or just tell the assistant in chat): how it writes ("never use em dashes", "keep replies short"), who matters ("the kids' school is always urgent"), how you like to be scheduled ("no meetings before 10"), what the brief covers ("radar: climate and AI"), temporary context ("in London until 24 Oct"). They are personal, they change often, and you want to change them without touching code.
  - **Safety and operations stay in code and `.env`**: the tool policy, suspicious-text isolation, quiet hours, intervals, the spend limit, the model, names and your Signal number. Memory is written through a model, so it must never be able to loosen these. A fact can say "be formal with Dr. Weber"; it can never say "allow sending without asking".
- **What may run unattended**: the rows of the tool modules in `src/modules` (the manifest, `src/policy/toolmanifest.ts`, is their union). Start by reading them (a read or the assistant's own plumbing is free, everything else is judged by the approval judge, whose prompt is in `src/approvals/approvaljudge.ts`); unknown tools ask. The default policy denies one financial connector (Interactive Brokers) by name as an example; add any other sensitive connector you have.
- **What gets archived**: the heartbeat run decides from the sender, subject and headers, by the judgement and examples in `assistants/<name>/persona/heartbeat.md` (the "New mail" paragraph): archive unless the mail needs you (a reply or decision expected, a payment or signature open, an event or deadline within 7 days, unread personal mail from someone you know; cold outreach is archived), open a mail only when unsure. The daily brief also sweeps the whole inbox once a day (`plugin/skills/daily-brief/SKILL.md`). Adjust the wording, or tell the assistant a preference in chat ("remember that mail from X is never urgent", a `triage-` note). There is no keyword blocklist; the safety net is that archiving is judged, audited with the mail's id and reversible (`npm run restore`).
- **What may be auto-archived**: `ARCHIVE_KINDS` and the per-tick cap in `src/actions.ts`.
- **Schedule and limits**: every tunable is an env var, validated at startup in `src/core/settings.ts`.
- **The brief's shape**: it is whatever `plugin/skills/daily-brief/SKILL.md` says. Headings (`## `) become separate Signal messages.

Back to the [README](../README.md) · [Setup](SETUP.md) · [Architecture](ARCHITECTURE.md) · [Safety](SAFETY.md)
