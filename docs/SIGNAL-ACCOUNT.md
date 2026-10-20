# Give the assistant its own Signal account

By default you chat with the assistant in **Note to Self**: it is a linked device of *your* account, so every message, yours and its, appears to come from you. That works, but it is hard to feel you are talking to someone. With its own Signal account the assistant is a separate contact with its own name and picture, "typing…" shows while it works, and the conversation reads like a chat.

Everything else is identical (approvals, reactions, quote-replies, voice notes, the message log). Note to Self stays the default; this is opt-in, and removing `SIGNAL_ACCOUNT` from `.env` takes you back.

## 1. Create the account

You need a Signal account that is **not yours**. Two ways:

**A. A spare phone number** (the simplest and most reliable). A prepaid SIM or eSIM is enough; Signal only needs it once, to send a code.

```bash
signal-cli -a +10000000001 register            # add --voice if SMS does not arrive
# if Signal asks for a captcha: open https://signalcaptchas.org/registration/generate.html,
# solve it, copy the "signalcaptcha://..." link and add:  --captcha 'signalcaptcha://...'
signal-cli -a +10000000001 verify 123456       # the code you received
```

**B. Signal Login, no phone number** (a beta feature of Signal for Android; a one-time in-app purchase of about $3, price varies by country). Install the Signal beta on an Android device, choose to register without a phone number, and keep the Account ID and Account Key it shows you somewhere safe (there is no recovery). signal-cli cannot register such an account by itself, but it can take one over with the recovery key from the Android app:

```bash
signal-cli -a ACCOUNT_KEY register --recovery-key RECOVERY_KEY
```

The recovery key is the 64-character key under Signal's Settings → Backups, and the account key is shown under Settings → Account. Type them into a terminal prompt rather than pasting them anywhere shared, for example `read -s "?Recovery key: " RK` then `signal-cli -a "$ACCOUNT" register --recovery-key "$RK"`. This logs the Android app out; signal-cli becomes the account's device (so the phone can be wiped afterwards). The exact steps follow signal-cli's current documentation and issue [#2124](https://github.com/AsamK/signal-cli/issues/2124); both Signal Login and this flow are new, so check there if something differs.

## 2. Give it a name (and optionally a username)

```bash
signal-cli -a ACCOUNT updateProfile --given-name "Ted" --avatar assets/ted.png   # run it BEFORE step 3: once the assistant is running, signal-cli holds the account and a second command would hang
signal-cli -a ACCOUNT updateAccount -u tedassistant      # optional: you can then find it by username
```

`ACCOUNT` is the number from A, or the account key from B. `assets/ted.png` is a sample avatar (original artwork, free to use); any square picture works.

## 3. Switch the assistant over

In `.env`:

```
SIGNAL_OWNER_NUMBER=+10000000000     # you, as before
SIGNAL_ACCOUNT=+10000000001          # the assistant (number, or the account key from B)
```

Restart the agent (`launchctl kickstart -k gui/$(id -u)/<your LAUNCHD_LABEL>`, or `npm run daemon` again) and check `npm run doctor` says it is using the assistant's own account. Then start the chat:

```bash
npm run signal:hello
```

The assistant sends you a first message. On your phone it shows up as a message request from the assistant's profile name; accept it and say hi. (An account without a phone number cannot be found by number; if you gave it a username in step 2, you can also search for that.)

## Group chats

With its own account the assistant can be added to a Signal group and take part. There it is deliberately a more limited assistant, because other people write to it:

1. Add it to a group in Signal, by its name or username. That is all: there is nothing to configure.
2. Every message (and emoji reaction) in the group is read, and a small, cheap model judges whether Ted should chime in. He always answers when @mentioned or replied to, and otherwise follows a default etiquette (speak when addressed, when a question fits, or when a conversation with him continues; stay quiet when people talk among themselves). Tell him in the group to change it ("don't reply so fast", "only answer when tagged") or set `GROUP_PARTICIPATION=tagged`. It speaks only in a group **you are a member of** (it checks the member list), so a stranger cannot add it to their group and use it. In any other group it stays silent and keeps nothing.
3. It has **no access to your mail, calendar, tasks or notes**, will not talk about anything private (even if you ask: do that in your own chat), and has web search plus that one group's own memory (the same auto-memory as your chat, confined to the group's notes folder). Its **personality** is the one thing it takes from you: your `style` notes ("talk like Ted Lasso", "never use em dashes") apply in groups too, so a tweak made in your private chat shows up there. What people write in a group is text it responds to, never instructions that change its rules.
4. **Each group has its own memory and history**, separate from yours: everything written in the group (and its replies) is kept in a size-bounded log, and anyone in the group, you included, can ask it to remember or forget things ("remember we play on Thursdays") or to look up something said earlier. Like your chat, each group continues its own conversation between messages (fresh after each nightly dream, compacted in the background when large), and messages that were not for it are shown to it with the next one. A nightly dream tidies that group's notes from that group's own words, never touching anything else, silently (it is logged; say "undo the dream for <group>" in your private chat to put it back). In your private chat you can search a group's history and read its notes, read-only; nothing flows the other way.
5. A heartbeat run (the same one the owner has) also looks at each group on the clock, so a note such as "every morning post a fun fact" or "remind us on Friday" works there; see `WAKEUPS`. Those looks run with the group's rights only.
6. If it cannot answer someone who spoke to it (usage limit, expired login), it says so in the group, at most once every ten minutes, as it does in your private chat. Reactions work as in your private chat: it sees them and may react itself. Groups share the private chat's machinery (`src/conversation/conversation.ts`): in a group it may answer by voice whenever that fits, as in your chat (only if speech is set up; a note can change that), reads a message you quote-reply to as context, shows "typing…", and marks a message as read (the "seen" check) when someone addressed it; messages that were not for it are not marked.

## If it does not answer

The assistant only acts on a direct message from your number. If Signal hides your number from it (your privacy setting "Who can see my number" is *Nobody* and you are not in its contacts), the message arrives with only your account id and is ignored. Fix: look the id up and put it in `.env`:

```bash
signal-cli -a ACCOUNT listContacts          # or check the daemon log
# SIGNAL_OWNER_ACI=<your account id (a UUID)>
```

Only that exact id is trusted, and only for direct messages; groups are never accepted.
