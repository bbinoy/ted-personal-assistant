# @ted-assistant/signal

A small, dependency-free TypeScript client for [signal-cli](https://github.com/AsamK/signal-cli)'s JSON-RPC daemon, for building bots and personal assistants on Signal.

- **Two ways to reach someone.** *Note to Self*: the bot is a linked device of your own account. Or *own account*: the bot is a separate Signal account that shows up as a contact, can join groups and shows "typing…" and "seen".
- **The Signal features a bot needs.** Text with styles, mentions, quotes (threaded replies), reactions, read receipts, typing, attachments, and groups (including whether a message is addressed to the bot).
- **A library that behaves.** It never calls `process.exit`, installs signal handlers or logs by default: you get a close event and a daemon handle and decide what happens.
- **Testable.** `/testing` ships `FakeSignalDaemon`, a fake of signal-cli's socket, so a bot's tests need no Signal account.
- **Voice messages as attachments.** An incoming voice note arrives as `IncomingMessage.audio` and an audio file you send is shown as a voice message. Turning speech into text and back is not part of this package: the assistant app keeps those libraries in `packages/speech`.
- **A Messenger adapter.** The `/messenger` entry point implements the `Messenger` interface of `@ted-assistant/messenger` (the assistant app loads it with `MESSENGER=signal`): the daemon, the client, targets, text styles, attachments and the doctor's checks behind one neutral interface.
- **Typed and small.** No third-party dependencies (the only package it uses is the interface package it implements), compiled JavaScript with `.d.ts` files, Node 24+, MIT.

It was written for, and is used every day by, a personal assistant ([Ted](https://github.com/bbinoy/ted-personal-assistant)) that lives in a Signal chat and in groups. Unofficial; not affiliated with Signal or signal-cli.

> Version 0.x: the API may still change between minor versions.

## Install

```bash
npm install @ted-assistant/signal
```

(The name and scope are placeholders until the package is published.)

System requirements, none of which this package installs:

- **signal-cli** with a registered or linked account, and the Java runtime it needs. See [docs/signal-account.md](docs/signal-account.md).
- macOS and Linux. Windows is untested. The daemon start also looks in `/opt/homebrew/bin` and `/usr/local/bin` besides `PATH`.

**Tested with** signal-cli 0.14.x on macOS. The field names this package reads (`sourceNumber`, `destinationNumber`, `targetSentTimestamp`, `groupInfo`, text style strings, `sendReceipt`'s single `recipient`) follow signal-cli's JSON-RPC output and have shifted between versions; if something stops working after a signal-cli upgrade, start with `interpretEnvelope` and its tests. The JSON-RPC connection is TCP only (no unix socket or stdio).

## Two ways to talk to someone

| Mode | The bot is | The person sees | Constructor |
|---|---|---|---|
| **Note to Self** (default) | a linked device of *their* Signal account | a chat with themselves | `new SignalClient({ host, port, account: theirNumber })` |
| **Own account** | a separate Signal account with its own name | a contact (and it can join groups) | `new SignalClient({ host, port, account: botAccount, peer: { number: theirNumber } })` |

Own-account mode needs a Signal account for the bot (a spare number, or Signal Login without one), created with signal-cli: [docs/signal-account.md](docs/signal-account.md).

## Use

```ts
import { SignalClient, ensureSignalDaemon } from "@ted-assistant/signal";

const me = process.env.SIGNAL_NUMBER!;     // you, international format
const bot = process.env.SIGNAL_ACCOUNT;    // optional: the bot's own account (a number or an account id)

const daemon = await ensureSignalDaemon({ account: bot ?? me, host: "127.0.0.1", port: 7583 }); // starts `signal-cli daemon`, or reuses one
const signal = new SignalClient({ host: "127.0.0.1", port: 7583, account: bot ?? me, peer: bot ? { number: me } : undefined });

// The library never exits your process or installs signal handlers: you decide what happens when Signal goes away.
daemon.exited.then(() => process.exit(1));
signal.onClose(() => process.exit(1));

signal.onMessage((m) => {
  if (m.direct && m.from === me) signal.send(`you said: ${m.text}`);   // YOU decide who may talk to it
});
await signal.connect();
```

You can also run `signal-cli daemon --tcp 127.0.0.1:7583 --no-receive-stdout` yourself (systemd, launchd, a container) and skip `ensureSignalDaemon`: the client only needs something listening.

Runnable examples, compiled with the package: [`examples/echo.ts`](examples/echo.ts) (Note to Self), [`examples/peer-bot.ts`](examples/peer-bot.ts) (own account, groups, reactions).

## API

Entry points: `@ted-assistant/signal` (the core), `/messenger` (the Messenger adapter), `/testing` (a fake daemon). All public symbols carry JSDoc, so your editor shows the details.

**`SignalClient`** (`new SignalClient({ host, port, account, peer?, logger?, rpcTimeoutMs?, ownReactionMs? })`)
- `onMessage(h)` receives `IncomingMessage { from, text, timestamp, direct, quote?, audio?, image?, file?, longText?, edited?, group?, addressedToMe?, fromUuid?, fromName? }`. `direct` means a private one-to-one conversation with the bot (Note to Self, or its own chat), never a group. Mentions arrive as `@name` in `text`. There is one handler slot: calling it again replaces the previous handler.
- `onReaction(h)` receives `IncomingReaction { from, emoji, targetTimestamp, targetAuthor?, isRemove, direct }`. `isOwnReaction(r)` recognises the bot's own reactions when they echo back (in Note to Self they look exactly like the person's). Reactions work as status indicators: a new reaction from the bot on the same message replaces its previous one.
- **Edits** arrive through `onMessage` too, with `edited: { targetTimestamp }`: `text` is the new text, `timestamp` is the edit's own, `targetTimestamp` is the message it replaces (the original's, or the previous edit's; clients differ, so keep every timestamp of a message). signal-cli reports them as `editMessage { targetSentTimestamp, dataMessage }` on the envelope, and your own edit from another device (Note to Self) as `syncMessage.sentMessage.editMessage`. An edit carries text only here (no audio or picture), and one that names no target is dropped. The package does not check that the sender is the original's author; do that before you apply an edit.
- `onDelete(h)` receives `IncomingDeletion { from, targetTimestamp, direct, group?, fromUuid?, fromName? }` when somebody deletes a message for everyone (signal-cli's `remoteDelete`; `targetTimestamp`, or `timestamp` in older versions). Same advice: compare `from` with the original's author. The handler slot works like the others.
- `send(text, { style?, quote?, attachments?, groupId? })` returns the sent message's timestamp. `style` is signal-cli's `start:length:STYLE` strings (`"0:5:BOLD"`; styles are BOLD, ITALIC, SPOILER, STRIKETHROUGH, MONOSPACE); `quote` threads a reply under an earlier message (`{ text, author, timestamp }`); `attachments` are **absolute paths** readable by signal-cli, and an audio file is shown as a voice message; `groupId` sends to a group instead.
- `react(emoji, { author, timestamp }, groupId?)`, `markRead(timestamp, from?)` (the "seen" check; `from` is the message's author, which in a group is not the peer), `typing(stop?, groupId?)`: best effort, they log and never throw. `markRead` and `typing` are own-account mode only.
- `groups()` lists the groups the bot is in with their members (number and account id).
- `sendFirst(text, recipient)` writes ONE first message to somebody the account has not talked to, by phone number (`+15555550114`) or Signal username (`name.42`; signal-cli's `username` parameter), and returns `{ timestamp, accountId? }` (the recipient's account id when signal-cli reports it). The Messenger interface offers it as the optional `sendFirst(recipient, text)`; platforms that cannot write to a stranger leave it out.
- `connect()` rejects if nothing is listening. `send` and `groups` reject when signal-cli refuses or does not answer within `rpcTimeoutMs`.
- `onClose(h)`: `h({ requested, error? })` runs once when the connection ends (`close()`, signal-cli gone, or a socket error). Requests still waiting are rejected. There is no reconnect. `close()` ends it on purpose.
- `separateAccount` tells which mode you are in.

**More than one person** (own-account mode): a private message from someone other than the peer has `direct: false`, `other: true` and her account id in `fromUuid` (`from` is her number, empty when Signal hides it); reactions and deletions carry the same. To answer one person, pass `toPerson(accountId)` wherever a `groupId` is taken (`send`, `react`, `typing`); `personOf(target)` reads it back. Who may talk to the bot is still yours to decide.

**Groups** (own-account mode): a group message has `group: { id }` and `direct: false`. `addressedToMe` is true when it @mentions the bot or replies to one of its messages, so a bot can stay silent otherwise. The package never decides who may talk to the bot: check `from`/`fromUuid` and the group's members yourself.

**Attachments.** `m.audio` and `m.image` hold only an id (the first audio file and the first picture of a message; audio up to 25 MB, pictures up to 20 MB). `m.file` holds the first other attachment (a PDF, a text file, a video...) as `{ id, size, name? }` of any size, the sender's file name cut to 200 characters (untrusted text, never a path); check the size and the bytes when you read it. signal-cli saves the bytes in its attachments folder; `attachmentPath(ref, dir?)` gives the file (default folder `~/.local/share/signal-cli/attachments`). The id is checked to be a plain file name; the content type is the sender's claim, so check the bytes yourself before trusting them as a picture.

**Long messages.** Signal apps send text over about 2000 characters as a cut `text` plus an attachment of type `text/x-signal-plain` with the full text. It arrives as `m.longText` (`{ id, size }`), never as `m.file`; `readLongText(m.longText, dir?)` returns `{ text, cut }` (a plain file only, strict UTF-8 without NUL, at most 64 KB) or `undefined` when it cannot be read as text, and you then use it in place of `m.text`.

**`ensureSignalDaemon({ account, host, port, logFd?, logger?, allowNonLoopback? })`** returns `{ started, stop(), exited }`. It installs no process handlers: call `stop()` when you shut down, and react to `exited` (a promise that settles when the daemon it started dies; it never settles for a daemon it merely reused). It refuses any host except `127.0.0.1`, `::1` and `localhost` unless you set `allowNonLoopback` (see Security). `logFd` is a file descriptor opened for appending that receives the daemon's output.

**Logging.** The package prints nothing by default. Pass `logger: console` (anything with `info`, `warn`, `error`) to see messages.

**Testing your bot** with `@ted-assistant/signal/testing`: `FakeSignalDaemon.start()` is a local fake of signal-cli's socket. It records the requests the client sends (`d.requests`), answers as you say, pushes incoming messages (`d.push(envelope)`) and can hang up (`d.dropConnections()`).

**Also exported:** `interpretEnvelope(envelope, { account, peer?, peerAci? })` (the pure function behind the receiving side; start here to understand or test it), `withMentions`, `parseQuote`, `parseAudio`, `parseImage`.

## Security: what the library trusts

- **signal-cli's TCP socket is unauthenticated.** Whoever can connect can send as the account. `ensureSignalDaemon` therefore refuses to listen anywhere but loopback unless you pass `allowNonLoopback`. If you run the daemon yourself, bind it to `127.0.0.1` and keep it off shared hosts and containers' public ports.
- **The client trusts every notification from the socket and authenticates nobody.** `direct` and `from` are derived from signal-cli's envelope: in Note to Self mode a message counts as the owner's because it is a sync from their other device; in own-account mode `from` equals the peer only if the number (or account id) matches. **Deciding who may talk to your bot is your application's job.**
- **Message text, quotes and names are untrusted input.** Do not put them into prompts, shell commands or file paths unfenced.
- **Attachment ids** are validated against `^[\w.-]{1,100}$` and may not start with a dot; the id is still only a file name inside a folder you choose. Join it with `attachmentPath`, and do not follow symlinks out of that folder.
- Temporary folders under `os.tmpdir()` are created by `mkdtemp` (mode 0700). You delete the one a `synthesize*` call returns.

## Third-party software

This package does not include, link or bundle any of the following. It starts them as separate programs or talks to them over a socket, and you install them under their own licences.

| Program | Used for | Licence |
|---|---|---|
| [signal-cli](https://github.com/AsamK/signal-cli) | talking to Signal (required) | GPL-3.0 |

About the GPL: signal-cli is a separate program under GPL-3.0. This package only starts it as its own process and exchanges JSON over a local TCP socket, which is generally understood as using a program, not as making a combined work, so signal-cli's licence does not extend to this package's code (which is MIT). That is not legal advice. What it means in practice: do not vendor a signal-cli binary or its jars in a package or container image you distribute without complying with the GPL for those parts; tell your users to install signal-cli themselves.

Signal is a trademark of its owners; this is an unofficial integration.

## Files

`src/client.ts` the client · `src/envelope.ts` `interpretEnvelope` and the other pure parsing · `src/daemon.ts` daemon start · `src/testing.ts` the fake daemon · `test/` run with `npm test` in this folder · `npm run build` compiles to `dist/`.

## Changes and contributing

See [CHANGELOG.md](CHANGELOG.md). Contributions: keep the package free of runtime dependencies and of anything that knows about a particular application; add a test (the fake daemon makes client tests easy); `npm test`, `npm run typecheck` and `npm run verify-pack` should pass.

Licensed under MIT, see [LICENSE](LICENSE). Not yet published to npm; the name and scope are placeholders.
