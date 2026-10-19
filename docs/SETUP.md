# Setup

## Status and limits

This is a personal project that runs daily for its author. It works, its safety-critical logic is unit-tested, and it is opinionated. It is **macOS only**, built for **one user**, and it works only while your Mac is awake. Read the code before trusting it with your inbox, and check Anthropic's current terms for using your plan this way.

## Requirements

- **macOS** (launchd supervises the agent; Mailbird is the mail client). Linux would work for everything except those two.
- **Node 24+** (TypeScript runs directly, there is no build step).
- **[Claude Code](https://docs.claude.com/en/docs/claude-code/overview)** installed and logged in (`claude auth login`). The agent uses your stored login so it can reach your claude.ai connectors (Notion, Google Calendar, Gmail…). *Check Anthropic's current terms for using your plan for personal automation like this.* An API key or `claude setup-token` also work but cannot use those connectors (see `HARNESS_AUTH` in `.env.example`).
- **[signal-cli](https://github.com/AsamK/signal-cli)** (`brew install signal-cli`). Either linked to your own Signal account as a secondary device (Note to Self, the default), or, better, registered as the assistant's own account ([SIGNAL-ACCOUNT.md](SIGNAL-ACCOUNT.md)).
- **A mail client with an MCP server**, unless you run chat only (below). This repo uses [Mailbird](https://www.getmailbird.com/); see [Why a local mail client](ADAPTING.md#why-the-default-is-a-local-client). Gmail only: use the Gmail connector instead ([Gmail](#gmail-no-local-mail-client) below).
- Optional: Notion and Google Calendar connected under *claude.ai → Settings → Connectors*, for the task and calendar parts of the brief.

## Install

```bash
git clone https://github.com/bbinoy/ted-personal-assistant && cd ted-personal-assistant
npm install

# 1. Link Signal (scan the QR code in Signal → Settings → Linked devices)
signal-cli link -n "ted-personal-assistant"            # prints a sgnl:// link; turn it into a QR code, e.g.
                                      #   brew install qrencode && qrencode -t ANSIUTF8 '<link>'

# 2. Configure
cp .env.example .env && chmod 600 .env
$EDITOR .env                          # at least SIGNAL_OWNER_NUMBER; set OWNER_NAME / ASSISTANT_NAME

# 3. Mail: make sure `claude mcp list` shows your mailbird server as connected
#    (the agent reads its connection details from the same entry in ~/.claude.json)

# 5. Check everything, then run it for real
npm run doctor
npm run install:launchd               # installs a launchd job; the agent starts now and at login
```

Send yourself a message on Signal. The first heartbeat tick only records a **baseline** of your current inbox (it does not triage old mail). The first daily brief runs on the next tick at or after 07:00.

### Chat only (no mail)

Mail is optional. For the Signal chat, memory, wake-ups, the calendar radar and a daily brief without an inbox, you need only **Claude Code** (logged in) and **signal-cli**: skip the Mailbird step above and put this in `.env`:

```
MAIL_PROVIDER=none
```

What changes: no mail client is started or contacted anywhere; the heartbeat only keeps its liveness line (one log line at start, `mail: off (MAIL_PROVIDER=none)`, nothing per tick); the daily brief has no email step, so the brief the model writes is the deliverable, and you get its pep talk and focus on Signal (say "brief" for the rest, it is saved in `memory/last-brief.md`); the model is not offered the mail skills or the Mailbird tools and is told there is no mail; `npm run doctor` shows `mail: off` as OK and does not look for Mailbird; setup does not ask about your writing style or sent mail; `npm run restore` and `npm run triage-check` refuse to run. The default is `MAIL_PROVIDER=mailbird`, which behaves as described everywhere else in these docs.

### Gmail (no local mail client)

If your mail is in Gmail you can skip Mailbird: the assistant uses the Gmail connector of your Claude account, the same way it uses Notion and Google Calendar. Connect Gmail in your Claude account (Settings, Connectors), make sure `HARNESS_AUTH=login`, and set in `.env`:

```
MAIL_PROVIDER=gmail
MAIL_SELF_ADDRESS=you@example.com
```

`MAIL_SELF_ADDRESS` is your own address. It is the only address the daily brief may ever be emailed to (a hard check in code, not a request to the model).

What works:

- **Heartbeat triage.** Every few minutes a small model lists the inbox (`in:inbox newer_than:7d`) and classifies new threads, as with Mailbird. This costs one small model call per tick for the connector round trip, even when nothing is new.
- **Archiving is log-only for the first week.** An archive is removing the INBOX label (reversible). With the default `GMAIL_ARCHIVE_LIVE=false` the heartbeat and any archive the assistant tries are recorded as `would-archive` and nothing is archived; `npm run report` and the daily brief say so. When the classifications look right, set `GMAIL_ARCHIVE_LIVE=true`. `npm run restore <threadId>` puts an archived thread back in the inbox.
- **Drafts and sends.** Drafts (new or in-thread) are made freely. `send_message`, `reply` and `forward` always go through the approval flow, shown with the real recipients (including cc, bcc and attachments); a send of a draft is shown from the draft as read back from Gmail. In chat the approval judge may skip the question for a send you just asked for (`AUTO_APPROVE`); unattended runs always ask.
- **Never allowed**, whoever asks: trash, spam, delete, the labels `TRASH` and `SPAM` on any label tool, reading attachment content, deleting or renaming labels.
- **The brief** goes to Signal as before. `BRIEF_EMAIL=on` also emails the full brief to `MAIL_SELF_ADDRESS` (and only there).
- **Not built for Gmail**: the background reply handler and its "Reply ready" drafts (they use Mailbird's tools). Mail the classifier would hand to the handler stays in the inbox and is listed in the brief.

`npm run doctor` checks that `MAIL_SELF_ADDRESS` is set and that the Gmail connector was available in the last run (start the agent once first). The connector's results were written against its published tool descriptions and tested on recorded-shape fake output; watch the first days in `npm run report` and `logs/audit.jsonl`.

### Skills and first-time setup

The skills the agent works with ship in the repo, in `plugin/skills/`, and are loaded straight from there: there is nothing to install or copy. They hold no personal details. What they need to know about you (which calendars to check, where your Notion task list and meeting pages are, how you write) lives in your memory notes, and the agent sets those up with you in the chat.

**Recommended: give the assistant its own Signal account**, so you chat with a contact that has a name and a picture, and see "typing…", instead of with yourself in Note to Self. It takes about ten minutes: [SIGNAL-ACCOUNT.md](SIGNAL-ACCOUNT.md). Everything works in Note to Self without it, and you can switch at any time (set or remove `SIGNAL_ACCOUNT`).

After the agent is running, send it **"set up"** on Signal. It walks you through one item at a time, and you can skip any:

| Item | What it does | Saved as |
|---|---|---|
| Calendars | lists your Google calendars, you pick which count, plus your time zone | `setup-calendars.md` |
| Tasks | searches Notion for your task list and uses it (it asks only if it finds nothing or several, and can create one for you) | `setup-tasks.md` |
| Meeting notes | searches Notion for your meetings database the same way, or creates a page for prep notes | `setup-meetings.md` |
| How you write (mail only) | with your permission, reads up to 15 of your sent mails and describes your style for you to correct | `voice-writing.md` |
| Optional | booking link, topics for the brief's radar | `setup-booking-link.md`, `brief-radar-topics.md` |

**Notion and Google Calendar come through connectors in your Claude account** (Settings, then Connectors). If one is not connected, its tools do not exist, and the agent says so plainly ("Notion isn't connected") instead of asking you to type in what the connector would have told it, and skips that part: tasks and meeting prep without Notion, the calendar review without Google Calendar. Mail triage, chat and writing-style setup need neither. Connect it, message the agent again, and it carries on. `npm run doctor` shows the status of each connector as of the last run.

Until something is set up, the parts of the agent that need it skip it and say so (in chat, it offers to set it up; in the daily brief, a one-line "🛠 Setup" note at the end). `npm run doctor` shows what is missing. To change something later, say "set up my calendar" (or tasks, meetings, writing) again, or edit the note in `memory/notes/`.

The skills are `daily-brief` (the brief's structure), `mailbird` (triage and drafting rules), `calendar`, `notion-tasks`, `meeting-prep`, `mailbird-troubleshooting` and `setup`. To change how a domain is handled, edit the file in `plugin/skills/`. Your own skills in `~/.claude/skills/` are not offered to the agent.

**Keep the agent's view of tools in step with the skills.** To save cost and time the model only sees four Notion tools (search, fetch, create-pages, update-page), and the Gmail, Drive, Docs and trading connectors are hidden. If a skill you write needs another tool, add it to `NOTION_TOOLS` or remove the connector from `HIDDEN_CONNECTORS` in `.env`; otherwise that skill silently fails.

## Browser (forms and bookings)

On by default (`BROWSE=on`). `npm install` fetches the pinned `@playwright/mcp` and runs `npm run setup:browse`, which downloads a headless Chromium (about 100 MB) into `state/browse/browsers`, not anywhere global; delete that folder to remove it. If the download failed (offline, `BROWSE_SKIP_INSTALL=1`), run `npm run setup:browse` yourself; until then the browse tool answers "not set up" and `npm run doctor` says what is missing. The browser presents itself as the plain desktop Chrome of the same version (not "HeadlessChrome"), with the language `BROWSE_LOCALE` (default `en-GB`) and this machine's time zone; nothing else is disguised, and sites that block automated browsers (SNCF Connect, Rail Europe, bahn.de, Trainline's search) stay blocked. `BROWSE_BROWSER_PATH` points it at a Chromium or Chrome you already have. `BROWSE=off` removes the tool from every run. A real-world check that costs a few cents: `npm run browse:smoke` (example.com, the httpbin pizza form up to but not including its submit button; `-- submit` shows the approval text a commit step produces, declined; `-- big` a large page). See [SAFETY](SAFETY.md) for what it can and cannot do.

## The secret store (OpenBao)

Your saved details, the card and, later, tokens and API keys live in **OpenBao** (an open-source Vault fork) on this Mac, not in a file next to the code. It is a local service: it listens on `127.0.0.1` only, with TLS that Ted pins, keeps its data in `state/openbao/` (0700, not in git) and writes an audit log whose values are hashed. Ted reaches it with its own token (policy: only `tenants/owner/*`), which is kept in the macOS Keychain. See [SAFETY](SAFETY.md) for the whole picture.

**Install and first setup (once).** In a terminal on this Mac, not through the chat:

```
npm run openbao -- setup
```

This downloads the pinned OpenBao release (2.7.1, Apple silicon, from github.com, SHA-256 checked; `npm run openbao -- install` does only that step), makes the certificate and the config, starts the server and a keeper job as launchd user agents (`com.<you>.ted-openbao`, `...-keeper`; `OPENBAO_LAUNCHD_LABEL` changes the name), initialises it with Shamir 2 of 3, mounts the key-value store, writes the owner policy and token, and revokes the temporary root token. Then it shows **three recovery shares, once**, and asks you to type the end of share 3 to confirm that you have them. **Record each of the three in a different safe place** (a password manager entry, a paper in a safe), never in this repository, a chat or a note on this Mac; any two unseal OpenBao. The Mac itself keeps shares 1 and 2 in the Keychain (items `ted-openbao-unseal-1` and `-2`) so that it can unseal itself; the screen and its scrollback are cleared afterwards. If you did not manage to record them, stop the jobs (`npm run openbao -- service uninstall`), delete `state/openbao/data` and run setup again: nothing is stored yet.

**After a reboot.** Log in (FileVault needs that anyway). The server starts at login but sealed; the keeper job unseals it from the Keychain within a minute and also renews the tokens. Nothing to do. Check with `npm run openbao -- status` (or `npm run doctor`). If it stays sealed (the Keychain item is gone, or after moving to a new Mac): `npm run openbao -- unseal --recovery` asks for two of your recovery shares at hidden prompts; then `npm run openbao -- setup` again writes the Keychain items and tokens back.

**Backups.** `npm run openbao -- backup` writes a Raft snapshot into `state/openbao/backup/` (mode 0600). It is encrypted by OpenBao, so it is useless without the unseal shares; keep a copy off this Mac (with your normal backup) and keep the recovery shares apart from it. Restoring needs `bao operator raft snapshot restore` and the shares. The audit log (`state/openbao/audit/audit.log`) grows without limit; truncate it now and then while OpenBao is running (`: > state/openbao/audit/audit.log`).

**Settings** (none is a secret, all optional, see `.env.example`): `OPENBAO_ADDR` (default `https://127.0.0.1:8200`), `OPENBAO_MOUNT` (`ted`), `OPENBAO_HOME` (`state/openbao`), `OPENBAO_ROLE` (`ted-owner`), `OPENBAO_KEYCHAIN_PREFIX` (`ted-openbao`), `OPENBAO_TIMEOUT_SECONDS`, `OPENBAO_CACHE_SECONDS`. The app token is never an environment variable.

**Good to know.** The Mac's Keychain holds enough shares to unseal, so sealing protects the data directory, backups and a stolen disk, not someone logged in as you. Lost recovery sheet while everything works: run setup on a fresh data directory, or change the shares with OpenBao's `operator rekey`, which needs `disable_unauthed_rekey_endpoints = false` in `state/openbao/config.hcl` for the time it takes (setup rewrites the config). The setup tool's own token (`ted-openbao-operator` in the Keychain) can only ask for a root token and take snapshots; if it is lost, OpenBao's recovery mode (`bao server -recovery`) is the way in. Upgrading OpenBao means changing the pinned version and checksum in `src/openbaoadmin.ts` (from the release's `checksums.txt`) and running setup.

## Saved details for forms (optional)

The browse worker can fill a form with your name, address, date of birth, passport number or loyalty numbers without ever seeing them. You enter them **in a terminal on this Mac, never in the chat** (the chat is logged and goes to the model):

```
npm run profile -- set email                 # hidden prompt; needs the secret store (previous section)
npm run profile -- set passport --domains sbb.ch,trainline.com
npm run profile -- list                      # keys, kinds and sites; values masked
npm run profile -- domains passport sbb.ch   # change the sites
npm run profile -- delete passport
```

Keys are lowercase words (`first_name`, `email`, `address.street`, `loyalty.sbb`); the kind (name, email, phone, address, nationality, dob, id, other) is guessed from the key or set with `--kind`. Name, e-mail, phone, address and nationality may be typed on any https page; date of birth, ID or passport and everything else are typed only on the sites you list, and nowhere until you do. The data is in the secret store (OpenBao, see the next section; `tenants/owner/profile/<key>`), not in a file next to the code. Card numbers, passwords and bank details are refused here (a payment card has its own command, see the next section). The final submit of a form that used your details always asks you first. See [SAFETY](SAFETY.md).

## Paying with a card (optional)

The browse worker can pay for what you asked it to buy, with **one dedicated debit card**. Use a card that has a low limit and confirms every online payment in its own app (3-D Secure, for example a Wise card); Ted treats it as a standard debit card and its caps are a second layer, not the first. You enter the card **in a terminal on this Mac, never in the chat**:

```
npm run card -- set --currency CHF --label Wise   # hidden prompts: number, expiry, security code, optional name on the card
npm run card -- list                              # the last four digits, caps, whether card payments are on
npm run card -- disable                           # the kill switch (the chat has /card off too)
npm run card -- enable                            # switch on again: only possible here, never from the chat
npm run card -- payments                          # the last payments: merchant, amount, last four, status
npm run card -- clear <id>                        # an unconfirmed payment you checked in the card app
npm run card -- delete
```

The card, including its security code, is stored in the secret store (`tenants/owner/card/primary`), apart from your saved details; nothing shows more than the last four digits. Every payment asks you first on Signal: the question names the shop, where the card is typed, the total with its currency, the last four digits and an id, and **only a typed YES approves it** (a 👍 does not; 👎 or NO declines). The payment is then confirmed in the card's own app, where you should check the amount. Ted's own caps apply too: `CARD_CAP_PURCHASE` (25) per payment and `CARD_CAP_DAY` (50) per day in the card's currency, and `BROWSE_MAX_PAYMENTS` (1) per task; set a cap to 0 to turn card payments off. Groups and background tasks never get the card. If a shop's payment page cannot be checked (an embedded frame from a site Ted does not know, no clear total), Ted stops and gives you the link to pay yourself. A card run starts the browser with a debugging port on the loopback address. See [SAFETY](SAFETY.md).

## More than one person (optional)

Off by default. With `TENANTS=on` friends can use the same instance, each as a **tenant** with a folder, notes, history, capabilities and limits of her own, running on a **shared instance key** (a separate Anthropic Console workspace key with a spend limit; yours is never used for her). It needs the assistant's **own Signal account** ([SIGNAL-ACCOUNT](SIGNAL-ACCOUNT.md); in Note to Self there is nobody else to talk to). Read "Host admin trust" in [SAFETY](SAFETY.md) first: you can read your friends' files, and you should tell them.

1. In the Anthropic Console create a separate workspace with a monthly spend limit and a key in it. Set `TENANTS=on` and `TENANT_ANTHROPIC_API_KEY=<that key>` in `.env` (not `ANTHROPIC_API_KEY`) and restart. Without the key friends are told the assistant is not set up for them and you get a notice; `npm run doctor` shows whether it is set.
2. In your chat ask for an invite ("invite Anna"), or `npm run tenants -- invite "for Anna"`. You get a single-use code that works for `INVITE_TTL_HOURS` (72). Send it to her yourself; she sends it to the assistant in a private Signal message. The assistant never writes to anyone first; anyone else who writes gets one fixed "invite only" reply and no model call.
3. She is now a tenant with the friend capabilities (`chat`, `browse`, `voice`, `heartbeat`, `dream`). `npm run tenants -- list` shows everybody with role and capabilities; `npm run tenants -- grant <id> <capability>` and `revoke` change them (`mail`, `calendar`, `notion`, `profile`, `card`, `wake`, `notes` are off until you grant them). `npm run tenants -- set-admin owner` restores the admin role if you are ever locked out. Roles and capabilities change only there, never in chat.
4. Her first reply says she is talking to an AI; before anything else she confirms she is 18 or older and where she lives, once.
5. Her day's limit is `TENANT_DAILY_BUDGET_USD` (2) on the instance key; `tenants/<id>/tenant.json` overrides it and a few more things (language, persona, `browse`/`voice` off, turn limits). If a request of hers hits a limit, runs out of credit or is refused, only she is paused (`npm run doctor` shows it).
6. Stop or leave: ask the assistant to suspend her (nothing is answered, data stays) or remove her (her folder is deleted; both ask on your phone). Her mail, calendar and the like are not available to tenants in this phase, nor are payments or your saved details.

## Daily use

- **Chat**: message yourself. Replies are formatted with Signal's native styles (bold, italic, strikethrough, monospace).
- **Send a drafted reply**: when the assistant has drafted a reply for you (it shows "✉️ Reply ready" with the recipient and text), react 👍 to send it exactly as shown, or reply to the message to change something.
- **Approve**: reply `yes` / `no`, a sentence, or react 👍 / 👎 on the question.
- `npm run doctor`: health check (tooling, permissions, Signal, Mailbird, login, launchd, skills, heartbeat liveness, spend, recent errors).
- `npm run report [hours]`: what the heartbeat archived, alerted and queued (local times).
- `npm run triage-check [n]`: how the heartbeat would classify your newest `n` emails and what it would do, without acting or changing anything. A safe way to check the classifier on real mail.
- `npm run restore <conversationId>`: put an archived conversation back in the inbox.
- `npm test` / `npm run typecheck` / `npm run check:secrets`.
- Folders: `state/` (bookkeeping), `logs/` (`agent.log` in local time, redacted and rotated; `audit.jsonl`, the audit trail; raw crash output, if any, in `launchd-stderr.log`, cut to its last 1 MB at start when it is over 5 MB), `memory/` (what the assistant remembers). All owner-only, all git-ignored.
- **Memory**: tell it things in chat ("remember that no meetings before 10", "forget the London trip", "what do you remember?"). It saves one markdown note per fact in `memory/notes/` (the SDK's auto-memory) and tells you on Signal exactly what it saved; say "forget that" to undo. You can also edit or add notes by hand: name the file `<category>-<slug>.md` with a category of `triage`, `people`, `scheduling`, `context`, `brief` or `style` (background jobs only read notes with one of those prefixes), and add `expires: YYYY-MM-DD` to the front matter for a temporary fact. Your writing preferences live here too, e.g. "Never use em dashes"; your daily-brief topics are `brief-` notes.
- **Spoken replies** (optional): the assistant can answer by voice when it fits, in a voice you choose, made locally with [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) (nothing leaves your Mac). Run `scripts/setup-tts.sh` once (about 400 MB; needs Python 3.10+ and ffmpeg), and use the assistant's own Signal account ([SIGNAL-ACCOUNT.md](SIGNAL-ACCOUNT.md)). The model decides per reply whether to speak or write: short conversational answers are spoken, long, detailed or exact ones (times, figures, links) stay text. `VOICE_REPLIES=off` turns it off; `TTS_VOICE` picks the voice. A different voice from a hosted service or your own server is possible but sends the spoken words there: see [REMOTE-TTS.md](REMOTE-TTS.md).
- **Nightly dream**: once a day, before the brief, a model with no tools reads what you told the assistant since the last time and proposes changes to its memory notes: new facts about you, people, preferences and projects, merges of duplicates, expired notes dropped. It works silently and logs what it did. See [ARCHITECTURE.md](ARCHITECTURE.md#the-dream). `DREAM=off` disables it; say "undo the dream" to put the notes back.
- **Voice messages** (optional): send a voice note in Note to Self and it is transcribed on your Mac with whisper.cpp (nothing leaves it), handled like typed text (at most `TRANSCRIBE_CONCURRENCY`, default 2, are transcribed at once, in your chat and all groups together; more wait in line). The transcript is logged with your other messages in `logs/messages.jsonl`, and you can ask the assistant what a voice message said (it may read `logs/`, `state/` and `memory/` and search the logs, read-only).
- **Proactive radar**: while you are awake it looks (about an hour before your next meeting, at most every `RADAR_MINUTES`, default 180, apart) at your calendar and messages you only when something deserves it (a meeting about to start, with its prep; a clash). Capped at `MAX_PROACTIVE_PER_DAY` messages of its own per day (mail alerts do not count); `PROACTIVE=off` disables it. It needs the calendar set up (say "set up").
- Tuning: every knob is an env var, listed in `.env.example` (heartbeat interval, quiet hours, brief start hour, archive cap, spend limit, model). They are validated at startup: a typo stops the agent with a clear message in the log.
- Chat session: it keeps recent history across days (never reset just because time passed) and is compacted when the conversation has grown `CHAT_COMPACT_GROWTH_TOKENS` (default 100000) beyond its first turn: in the background once it has been quiet for `COMPACT_QUIET_MINUTES` (default 5), or right after a reply if it grew 1.5 times past that, the same for your chat and every group, so long conversations stay cheap. Both are optional settings in `.env`.
- Pause: `touch state/paused` (or write a date into it to resume on that day). The heartbeat idles at night by itself (22:00 to 07:00 by default) and catches up in the morning.

Back to the [README](../README.md) · [Architecture](ARCHITECTURE.md) · [Safety](SAFETY.md) · [Adapting](ADAPTING.md)
