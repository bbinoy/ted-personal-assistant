# Ted

**Proactive personal assistant with a character, who organises your calendar, emails, tasks and meetings, and can do research on the web for you.**

<img width="300" alt="Ted answering in Signal: a text reply, a voice message and reactions" src="docs/images/chat.png" />

🔊 [Listen to an example voice message](docs/audio/voice-message.m4a), spoken by the built-in stock voice (Kokoro `am_onyx`, no real person's voice).

## Why it feels like a person

- **A character, by default Ted Lasso.** Warm, folksy and relentlessly optimistic. Change it by telling Ted what you want.
- **Typing, seen, reactions.** It marks your message read, shows "typing..." while it works, and sometimes answers with just an emoji on your message. 
- **Voice in and out.** Talk to Ted in voice notes and he may answer in one. Send him a voice note or a short clip of any voice you're allowed to use, and he adopts that voice from then on.
- **Pictures, PDFs and text files.** Send a picture, a PDF or a text file and Ted reads it. When browsing the web it can send you screenshots of what it sees.
- **Browse the web.** It has a browser it can use to research for you online, and tells you what it is up to before a long errand. *Coming soon: fill in forms, store secrets securely and pay securely, with your typed YES for every payment.*
- **Groups, where it decides when to speak.** Add Ted to a group and a small model judges each message: Ted always answers when addressed and otherwise joins in only when it fits. Each group has its own notes and history, and Ted brings none of your private data there.
- **Smart memory and context.** Ted remembers relevant details about you, your preferences and recurring tasks, and while you are away it can note facts it learns (a friend moved, a trip), logged, so you can inspect it and say "forget it". A nightly dream organises memory; ask "what did you learn" to see what changed and say "undo the dream" to take it back. Context is automatically populated with relevant tools, recent messages, memory, and compacted above a threshold.
- **Smart about asking for permission.** A small model judge decides what is a safe action and when to ask you for confirmation, like sending an email.
- **People who matter.** Tell Ted about friends and family (where they live, how close, how often you'd like to be in touch). When your calendar or mail shows you are travelling to where they live, Ted sends you one short message with who is there and how long since you last spoke, and offers a draft.
- **Proactive.** Wakes up every 15min to check if anything needs acting on (via small model judge).
- **Its own contact.** Give Ted its own Signal account (a name, a picture) and you chat with a contact instead of with yourself.
- **Pre-configured as a helpful personal assistant.** Comes with skills out of the box to be a helpful personal assistant.

## Personal assistant

- **Inbox.** Every 15 minutes it checks for new mail. Newsletters, notifications and cold outreach are archived (never deletes). Anything that needs you arrives as one short message on Signal. When appropriate a reply is drafted automatically for you to review.
- **A short hello.** On its very first start Ted says hello once (what it does, `/status`, `/pause 2h`, `/today`, and "set up" if you want to walk through connecting things). It archives routine mail from the start, as your notes say; every archive is listed in `/today` and the brief, and "restore 3" brings one back.
- **Meeting prep** from your Notion meeting database and past threads, in the daily brief and again as one short message 15 minutes before each meeting with other people (who, what it is about, your last thread with them, what you owe each other, the Notion page; `PREP_MINUTES`).
- **People.** "Invite Sam" or "write to Anna" does not mean guessing or asking for an address: `find_person` looks in your people notes and, for a friend, her Google Contacts, and only asks when it finds none or several. Google Drive and Docs are on by default: it can find and read your files.
- **Its own task list.** Say "remind me to call Sam on Friday" and it keeps a list per chat (yours, each friend's, each group's): tasks, promises you made and things you wait on, with repeat rules (`every monday at 09:00`), snoozing and a full history, never deleting anything. What a mail asks of you it adds by itself and tells you in a line ("drop that task" undoes it). `/tasks` shows the list.
  - *Talk to it about tasks.* "What's on my plate?", "remind me Friday at 3 to call Sam" (a task with a reminder, which only messages you: it never sends mail), "I owe Sam the deck by Friday", "Sam owes me the contract", "what does Sam owe me?", "done with the licence", "snooze that for an hour". It works out the date itself and answers with the weekday and date it understood, so a wrong guess is easy to spot.
  - *Tasks from mail are added, then told.* When a mail holds a request or a deadline for you, something you promised in a mail you sent, or something someone owes you, a look adds it to the list and tells you in its own words: what came in, why it is a task, the due date, what it depends on. Never twice for the same mail, at most 10 a day; a task from a mail grants nothing (acting on it is judged like acting on the mail).
  - *Groups and friends.* In a group any member can add and finish; "Sam by Friday" assigns it; "remind me ..." makes a group task for that member (and the member is told once that it is the group's, a private reminder goes to Ted directly); anyone can type `/tasks`; a task from the group's mail or chat is added and told in the group. A friend has the same in her own chat.
- **Tasks live in Ted, not in Notion.** The daily brief reads Ted's own list (overdue, due today, waiting on, what you owe); a task a look added from mail is marked as such. Chat with it to add, tick off or reschedule. If you have an old Notion task table, Ted moves it over once, after a preview you confirm ("import my tasks"); after that it never writes tasks to Notion again.
- **Calendar.** Creates events from mail, flags conflicts and proposes fixes. Plain events on your own calendar just happen (logged); anything with other people asks.
- **Daily brief.** An email sent to you once a day in the morning with a key focus for the day based on tasks, emails and calendar, upcoming calendar events, what it did since the last brief (emails that were auto-archived), and newsletter digest.
- **Routines: one schedule mechanism.** Besides the morning brief, Ted sends a short evening wrap on weekdays (18:30: what got done, tomorrow, what still waits on you) and a weekly review on Fridays (16:30: wins, what slipped, next week, who to follow up); read-only, each a skill with a `schedule:` line, on/off with `ROUTINES_OFF`. You, a friend or a group can also ask in chat for your own ("every Monday at 9 summarise my week"): Ted saves it as a note with a `when:` line and tells you when it first runs. Code decides what is due and that it happens once; if your Mac slept through the time, it catches up when it wakes or skips and says so. `/status` shows every scheduled item's next run.
- **Newsletter digest.** The top three nuggets, based on your preferences, in the daily brief.

Meeting prep and the calendar need the Notion and Google Calendar connectors (the task list does not). Without one, Ted skips that part and says so. It helps you point it to the right page in Notion if it doesn't find it automatically.

## Setup

Just ask Claude Code to set up the repo and install dependencies. Then start Ted, it will automatically look where in Notion you keep your meetings, and confirms that with you. Tasks need no setup (an old Notion task table can be imported once, see docs/SETUP.md).

By default it uses the "Note to self" chat on Signal, but for a better experience consider creating a dedicated Signal account for Ted so you can chat to him as its own user and add him to groups.

To customize the voice, just send Ted a voice note or a short clip. Use your own voice, or one whose owner agreed: a clip from a film, a show or a public figure is someone else's voice.

Step by step: [docs/SETUP.md](docs/SETUP.md).

## Safety

- **A judge that can skip questions, inside a floor.** One small model decides, for every tool in every place, which questions to spare you: what follows from your request or your standing tasks and is easy to undo goes ahead, anything a mail asks for, new recipients, sharing and the like ask. The floor is code and no verdict overrides it: payments, logins, the never-allowed set, group and tenant boundaries and web addresses that could carry data out. Skips are logged and listed by `npm run report`, and `AUTO_APPROVE=off` turns the judge off.
- **It learns from your 👎.** React 👎 to something Ted sent on its own (an alert, a digest, a brief), or quote it and say "stop sending these", and Ted answers once with ONE concrete note it would save ("Archive LinkedIn digest mails from now on, without telling me."), written for the triage, notice or brief machinery that already reads your notes and based on what it did and why. Nothing is saved until you 👍 the offer (or answer "yes" to it); then it is a confirmed note, undone with one message. A 👎 or "no" saves nothing and is not asked again; at most 3 offers a day. A 👍 on something it sent is only counted, as a reason for the dream to keep a related note. Friends get the same in their own chat; groups do not (a reaction there is too ambiguous).
- **Ask "what did you do today?"** Everything it did on its own (mail archived, calendar and Notion changes, notes saved, messages held) is one line in a journal in your chat's own history, written by code as it happened: what it did (the mail by subject and sender), why (your message at 09:12, the approval you answered, a safety-check verdict) and how to undo it. Ask "what did you do today?" or "why did you archive that?" and Ted reads it; `/today` is the same in one phone-sized message. A friend or a group has the journal of their own conversation, and no one else's.
- **Approvals with the exact arguments.** Sending, forwarding, sharing and anything that involves other people ask first.
- **A browser with guard rails.** Browsing runs in a separate, throwaway browser with no logins and none of your data. A small judge decides whether a step is read-only (searching, filtering) or books, buys or sends something, and anything like that asks you first. Payment and login fields always ask you, and the address checks that keep the browser away from your own machine and network are code, not a model decision.
- **Permission policy in code.** Every tool call is allow, ask or deny in `src/policy/policy.ts`, tested against real tool names. Deletes are denied. Memory can shape tone and priorities but never grant permissions.
- **Untrusted content cleaned at the door.** Messages, mail, web pages and tool results lose hidden and look-alike characters and invisible HTML before a model reads them, and are treated as data.
- **What this is not.** This is application-level policy running on your Mac as your user. It is **not** OS-level or container isolation. Prompt injection is contained and tested, not eliminated: a hostile mail can still try. `signal-cli` keeps its keys unencrypted on disk, so keep FileVault on.
- **Control and no silent failures.** `/stop`, `/pause 2h`, `/resume`, `/status`, `/today`, `/quiet 2h` (or `/quiet until 18:00`, `/quiet`) and `/unquiet` work from your chat in code, whatever a model is doing (`/quiet` only holds what I'd post unprompted; `/pause` stops unattended work). Unprompted messages are held in quiet hours and capped per day, and what was held comes as one digest; a big spend day (a warning at $20, then every $5; nothing is paused) or background work that keeps failing is reported to you once, ending with the one step that fixes it.
- **Tests.** Full test suite ensures the code behaves as expected.
- **Logging.** Every decision and action is logged and can be inspected for behaviour (`npm run report`).

Full details: [docs/SAFETY.md](docs/SAFETY.md).

## Run it for yourself, your friends and family

One Ted can look after you and the people around you. Give a friend or a family member Ted's Signal username (or number, whichever your setup shows) and they chat with it in private, just like you do: their own conversation, their own notes and memory, and nothing of yours.

- **You look after it, you don't read along.** Anyone can write to Ted, and when a stranger does, Ted asks you in your own chat whether to let them in; you say yes or no, and then only switch things on or off for each person (what Ted may do for them) or pause them. When Ted wants to send something or change something for a friend, the question goes to that friend's own chat, not to you, and Ted's activity log keeps no words of theirs. One honest footnote: you run the computer, so you could technically open their files, and Ted tells each friend so in the first message.
- **Their own budget.** Friends use a shared API key you set up in your Anthropic console, with a monthly spend limit,, and you are warned when all friends together, or one friend, spend a lot in a day (nothing is refused). You hear in your own chat if the shared key itself stops working.
- **Their own Google Calendar, Gmail and Notion, if you set it up.** After a one-time setup of yours (a public address for a small private setup page, plus a Google Cloud project for Google; Notion needs nothing more from you), each friend connects their own account from a one-time link, with no password or key typed into the chat. Ted then reads their mail and calendar and their Notion pages for them, and asks them in their own chat before anything risky, like sending a mail or inviting someone.
- **The honest limits.** Friends cost you money (they use the shared key). Google needs a Google Cloud project of yours, and while it is in test mode each friend reconnects about once a week. You, as the person running it, hold your friends' connection tokens. Saved details and a card are still only yours. This is a service for a small circle of people you know, not a product for strangers.

Step by step: [docs/SETUP.md](docs/SETUP.md#more-than-one-person-optional).

## A day in the life: AFC Richmond edition

*(Characters borrowed with love from Ted Lasso. Nobody at Richmond has been consulted.)*

**Tuesday, 07:00.** Your Mac wakes and the daily brief starts. The full brief lands in your inbox. On Signal you get the short version:

> **💪 Pep talk**
> Mornin', Coach! Now, I know the inbox looks like a pile of angry geese, but today is really just three things, and you've handled worse before your first biscuit. Answer the Board before 11:00 and everything else is a nice, easy warm-up.
>
> **🎯 Focus**
> **Answer Rebecca about the stadium budget before 11:00.** She's asked twice, and the second message just says "Ted. Budget."
> - Press conference prep at 14:00, the prep page is ready.
> - Ring the boiler repairman. Again.

**10:42.** An urgent mail arrives while you are in a meeting, so you get exactly one alert:

> Keeley Jones needs your decision on the PR plan by noon: the whole campaign is waiting on a yes or no.

**Any time.** Just talk to Ted, in text or a voice note:

> **You:** what's on my plate today?
> **Ted:** Three things, and not one of them is a lion! 🦁
> - **Rebecca** wants an answer on the budget by 11:00.
> - Kickball clinic at 17:30 collides with the Sponsors' Brunch. I'd move the brunch. Nobody ever won a championship over a quiche.
> - Your coaching licence is 4 days overdue. No judgment here, buddy.
>
> **You:** remember that messages from Jamie are never urgent
> **Ted:** Saved: Jamie's "URGENT!!!" emails will now wait their turn. Which, between you and me, is a long line.

**11:20.** Anything involving other people waits for your say-so, and Ted asks like a person would:

> **You:** put "find a decent cup of tea" in my calendar tomorrow at 15:00, and invite Coach Beard
> **Ted:** Happy to! That's "find a decent cup of tea" tomorrow at 15:00, with Coach Beard invited. Shall I send him the invite?
>
> **You:** yes but make it 16:00
> **Ted:** Done: moved to 16:00 and the invite is on its way to Beard.

**12:30.** The Richmond group chat. Ted is in there too, with notes and a memory of its own, and none of yours:

> **Roy:** *(sends a voice note)* Ted, talk as me.
> **Ted:** 🎤 Voice's saved: from now on I'll sound like Roy in this group only. Say "normal voice" and I'm back to me.
> **Keeley:** Who's up for team drinks after training?
> **Ted:** *(in Roy's gravelly voice)* Fine. But I'm not wearing the hat.

**14:10.** You forward Rebecca's budget as a PDF:

> **Ted:** Pages 3 and 7 are the ones to read. The stadium line is up 12%, and she's buried the reason on page 7. Want me to draft her a reply?

**16:45.** The long errand:

> **You:** find me a train to London on Tuesday
> **Ted:** On it, checking SBB and Omio.
> *(a minute later)*
> **Ted:** The 06:59 is the one: 8h36, one change, around CHF 230 to 330. I couldn't confirm the exact fare, so call that a range. Here's what SBB showed me. *(screenshot)* I'd book it yourself from this link, since I stop before anything that costs money.

## How it compares

Personal agents are having a moment. Ted sits in the middle: hosted products like Instinct are opaque and cannot be changed, and OpenClaw is open and extensible but technical to set up. Ted comes with what a powerful personal assistant needs out of the box, with strong safety defaults, and you run it yourself and can change it. The cells for other products come from public descriptions, not from using them.

| | **Ted** | **[OpenClaw](https://en.wikipedia.org/wiki/OpenClaw)** | **[Grok Bot](https://www.vellum.ai/blog/official-grok-bot-breakdown)** | **[Instinct](https://www.vellum.ai/blog/official-instinct-breakdown)** |
|---|---|---|---|---|
| **What it is** | A personable assistant in your Signal chats, with heartbeat, memory, browsing and mail, calendar and task skills out of the box | A general-purpose agent platform | A general agent on a cloud computer | A general assistant you text or call |
| **Before it acts** | Code-enforced policy: reads run, outward actions ask on your phone (in chat, a send you asked for exactly may go through on a small model's judgement), deletes are denied | Per-agent tool permissions; sandboxed or full system access, your choice | Allow once / always / deny, plus auto-review rules | Reported by Vellum: no approval step required for actions. Corrections welcome |
| **Setup** | Ask Claude Code to install it, then message it in Signal: the rest of the setup happens in the chat | A command-line onboarding wizard (`openclaw onboard`) for model, gateway and channels; some steps in a masked terminal | Sign in to the app | Invite-only; you message it and connect accounts |
| **Secrets and payments** | Secrets never go through chat or the model: entered at a local CLI or a one-time link. Card payments need your typed YES in the chat, with caps and a ledger | Community skills are a reported risk: a Snyk scan found about 7% of ClawHub skills pass keys or card numbers through the model | Not documented in what I found | Not documented in what I found |
| **Source** | Open (MIT)| Open, large | Proprietary | Proprietary |
| **Cost** | Your Claude plan. Measured in October 2026 with Sonnet: about $0.01 for a simple warm reply, $0.03 to $0.08 for a calendar question | Free software plus your model costs | $200/month, or bundled with SuperGrok Heavy and Cursor plans | Free in invite-only beta, pricing not published |
| **Runs on** | Your Mac | Your machine or server | xAI's cloud | The vendor's cloud |
| **Where you talk to it** | Signal (other messengers plug into a generic interface) | WhatsApp, Telegram, Signal, Slack, iMessage and more | Desktop and iPhone app | iMessage, WhatsApp, phone calls |

**Ted may suit you** if you want a readable assistant for yourself (and, if you like, a few people you know) that comes with personality and personal assistant skills out of the box, that you set up by chatting, and that you can run and change yourself. **OpenClaw** fits a broad, self-hosted agent platform with many channels and community skills, and more technical setup. **Grok Bot or Instinct** fit if you would rather have a hosted product than run anything yourself.

## Make it yours

- **Your preferences**: personality, tone, length, who matters, what the brief includes. They live in small notes (`conversations/owner/notes/`) that you can also change by chatting. No code, no restart.
- **Your mail**: it ships with [Mailbird](https://www.getmailbird.com/). If you use Gmail only, set `MAIL_PROVIDER=gmail` to use your Claude account's Gmail connector instead and skip the local client ([docs/SETUP.md](docs/SETUP.md#gmail-no-local-mail-client)).
- **Your messenger**: Signal is a thin layer. Telegram, Slack, iMessage and WhatsApp are realistic swaps.
- **Your rules**: what runs unattended, what needs approval and what is blocked is one short, tested file.

How to do each: [docs/ADAPTING.md](docs/ADAPTING.md).

## Roadmap

What is built but not switched on yet, and what is planned next. Order and dates can change.

- **Secrets and payments.** A sealed card store (OpenBao), a typed YES in the chat for every payment, spending caps and a ledger. Built, not live yet: it is being tested with fake cards before it is switched on.
- **Several people.** Friends with their own memory, notes and budget, isolated from you and from each other, exist and are off by default. Their own Google and Notion, signed in from a one-time link, are built and tested against fakes, and the first live run with real accounts is still ahead. Saved details and a card for friends are not built.
- **A generic messenger layer.** All Signal code moves behind one interface, so other messengers plug in without changes to the assistant. Design notes for Telegram, Slack and WhatsApp are in docs/ADAPTING.md; none is built.
- **Telegram, and an even faster setup.** A Telegram bot as the default: create the bot, paste the token, scan a QR code, and finish the setup in the chat. Signal stays supported and remains the more private choice.
- **Tools and assistant presets.** Tools as small modules and the personal assistant's persona and routines as data, so it is easier to add a tool or make a different kind of assistant. No marketplace of third-party modules, on purpose.

## Docs

|||
|---|---|
| [Setup](docs/SETUP.md) | requirements, install, skills, daily use, tuning |
| [Safety](docs/SAFETY.md) | what it can and cannot do, and how that is enforced |
| [Architecture](docs/ARCHITECTURE.md) | how it works, project layout, development |
| [Adapting](docs/ADAPTING.md) | Proton and Mailbird, Gmail directly, other messengers, other tweaks |

## License

[MIT](LICENSE)
