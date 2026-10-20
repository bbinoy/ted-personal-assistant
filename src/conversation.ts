import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { audit } from "./audit.ts";
import { allows } from "./policy/capabilities.ts";
import { cleanIncoming, group, owner, tenant, type Batch, type Conversation, type Held, type Incoming, type PipelineDeps, type Turn, type TurnResult } from "./conversationmodel.ts";
import { findMessage, revisionsOf, type Extra, type Kind } from "./messages.ts";
import { DELETED_LINE, editNote, isAuthor, sameText } from "./edit.ts";
import { MAX_PICTURES, PICTURE_NOTE, type Picture } from "./image.ts";
import { documentNote, takeDocuments, type Document } from "./document.ts";
import { shouldThread, withQuoteContext } from "./quote.ts";
import { holdQuote, holdVoiceNote, rememberSender } from "./modules/voice/voicenote.ts";
import { cardCommand } from "./modules/browse/card.ts";
import { TYPED_YES_NEEDED } from "./modules/browse/paymentrules.ts";
import { withSend, type Content, type SendSink } from "./modules/send/send.ts";
import { reactionMessage, reactionPrompt, splitReaction } from "./reaction.ts";
import { scopeOf } from "./approvals/turnscope.ts";
import { splitVoice, VOICE_FAILED_NOTE, voiceOption } from "./voicereply.ts";
import { settings } from "./settings.ts";
import { UNSURE } from "./lang.ts";
import { clean, LIMITS, oneLine } from "./sanitize.ts";
import { startTiming, type Timing } from "./timing.ts";
import { MAX_LONG_TEXT_BYTES, type IncomingDeletion, type IncomingMessage, type IncomingReaction, type Quote } from "@ted-assistant/messenger";
import { MAX_SPOKEN_CHARS } from "@ted-assistant/speech/tts";

// The conversation model lives in conversationmodel.ts; these are re-exported for the modules and tests that import them from here.
export { cleanIncoming, group, owner, tenant, type Batch, type Conversation, type Incoming };

// The one pipeline every conversation goes through: the owner's private chat and each group. What differs
// between them is DATA on a Conversation, and a Conversation is made only by owner(), group(id) and tenant(id), so trust
// cannot be mixed up by building one by hand. What is the same is the code: read receipt, voice message in,
// record, run, [[voice]] / [[react]] / [[silent]], quote threading, typing, error notice, one turn at a time.
// A burst of messages is one turn in both (burst below): a short settling pause, then everything that arrived is answered together.
//   owner   its own chat with the assistant; the full toolset (policy source "chat"); approvals exist; always answered
//   group   one group chat; no private data (policy source "group"); the participation gate decides (group.ts)
//   tenant  a friend's private chat (tenants.ts): the owner's turn path, the group's isolation, her own folder and API key


const SILENT = /^\s*\[\[silent\]\]\s*$/i;


export function createPipeline(deps: PipelineDeps) {
  const { messenger, out } = deps;
  const caps = messenger.capabilities;
  const now = deps.now ?? Date.now;

  // One turn at a time per conversation: two at once would share one session. Approval answers skip this
  // (see handleIncoming): the queue is blocked on the very turn that is waiting for them.
  const tails = new Map<string, Promise<unknown>>();
  function enqueue<T>(conv: Conversation, job: () => Promise<T>): Promise<T> {
    const run = (tails.get(conv.key) ?? Promise.resolve()).then(job);
    const tail = run.catch(() => {});
    tails.set(conv.key, tail);
    void tail.then(() => tails.get(conv.key) === tail && tails.delete(conv.key));
    return run;
  }

  // Burst handling, the same for every conversation: after each message wait a short settling pause; a newer message
  // restarts it and takes over, so a burst is ONE turn. Messages that arrive while that turn is queued join it; ones that
  // arrive while a run is in progress wait in the queue and make the next turn. Messages are kept here, in the order they came.
  // The pause is capped: once the first message of a burst has waited settleMaxSeconds, the burst is processed even if
  // people are still typing (what arrives after that joins the next turn).
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const wait = deps.wait ?? sleep;
  const bursts = new Map<string, { epoch: number; pending: unknown[]; queued: boolean; firstAt?: number }>();
  // `arrivedAt`: when the message really came in, if earlier than this call (voice transcription, group lookup).
  async function burst<T>(conv: Conversation, item: T, settled: (b: Batch<T>) => Promise<void>, arrivedAt: number = now()): Promise<void> {
    const timing = startTiming(conv.kind, now, arrivedAt);
    const st = bursts.get(conv.key) ?? { epoch: 0, pending: [], queued: false };
    bursts.set(conv.key, st);
    if (!st.pending.length) st.firstAt = now();
    st.pending.push(item);
    const mine = ++st.epoch;
    const maxMs = deps.settleMaxMs ? deps.settleMaxMs() : settings.settleMaxSeconds * 1000;
    const left = Math.max(0, maxMs - (now() - (st.firstAt ?? now())));
    await wait(Math.min(deps.settleMs ? deps.settleMs() : settings.settleSeconds * 1000, left));
    if (st.epoch !== mine || st.queued || !st.pending.length) return; // a newer message took over, or a queued run will take this one too
    timing.mark("settle");
    await settled({
      stale: () => st.epoch !== mine,
      timing,
      run: (job) => {
        st.queued = true;
        const queuedAt = now();
        return enqueue(conv, async () => {
          timing.set("queue", now() - queuedAt);
          st.queued = false;
          st.firstAt = undefined;
          const items = st.pending.splice(0) as T[];
          if (items.length) await job(items);
        });
      },
    });
  }

  // A run is already queued for the current burst, so a message arriving now joins it (no verdict of its own is needed).
  const burstQueued = (conv: Conversation): boolean => !!bursts.get(conv.key)?.queued;

  const record = (conv: Conversation, kind: Kind, ts: number, text: string, extra?: Extra) => deps.record(conv.target, kind, ts, text, extra);

  // Messages still waiting for their turn (the settling pause, or queued behind a running turn): an edit replaces one and a delete
  // removes one. Matched by timestamp: the original's or an edit's, whichever the sender's app uses.
  const stampOf = (x: unknown) => (x as { timestamp: number }).timestamp;
  const pendingOf = (conv: Conversation, stamps: readonly number[]) => bursts.get(conv.key)?.pending.find((x) => stamps.includes(stampOf(x)));
  const authorOf = (x: unknown) => (x as { author?: string; from?: string; fromUuid?: string }).author ?? (x as { from?: string }).from ?? (x as { fromUuid?: string }).fromUuid;
  function dropPending(conv: Conversation, stamps: readonly number[]): void {
    const st = bursts.get(conv.key);
    if (st) st.pending = st.pending.filter((x) => !stamps.includes(stampOf(x)));
  }

  // Timestamps of messages that were taken as the answer to an approval: an edit of one never answers anything (see edit()).
  const approvalAnswers = new Set<number>();
  const answeredApproval = (ts: number) => {
    approvalAnswers.add(ts);
    if (approvalAnswers.size > 200) approvalAnswers.delete(approvalAnswers.keys().next().value!);
  };

  // An emoji on a message, where the messenger has reactions.
  const reactTo = (conv: Conversation, emoji: string, target: { author: string; timestamp: number }) => {
    if (caps.reactions) void messenger.react(conv.target, target, emoji);
  };

  // Working / done / failed icons on the owner's message. Only where the messenger shows no "typing…" (Signal's Note to Self); where
  // it does, the typing indicator says it, and groups are never decorated.
  const status = (conv: Conversation, emoji: string, target?: { author: string; timestamp: number }) => {
    if (target && !caps.typing) reactTo(conv, emoji, target);
  };

  const canSpeak = () => deps.speech.ready();

  // Speaks and sends. False on any failure: the caller then sends the words as text.
  async function speak(conv: Conversation, words: string): Promise<boolean> {
    let file: string | undefined;
    try {
      file = await deps.speech.synth(words, conv.key); // the voice active in THIS conversation
      await out.sendVoice(file, words, conv.target);
      return true;
    } catch (e) {
      console.error("voice reply failed, sending text:", (e as Error).message);
      return false;
    } finally {
      if (file) rmSync(dirname(file), { recursive: true, force: true });
    }
  }

  // THE delivery of everything a turn says: the final reply and each `send` tool call (send.ts) go through here, so the rules exist once.
  // Text (or a voice note: only if speech is set up and the language is one the voice speaks, else text), a picture, an emoji reaction.
  // Target and quote: a threaded quote under the conversation's rule, a reaction on the message being answered. The sanitiser runs in
  // out.reply / out.sendPicture; [[silent]] sends nothing; logging is out's. `more`: the turn goes on, so "typing…" resumes (a send clears it on the phone).
  function delivery(conv: Conversation, t: Pick<Turn, "target" | "threadUnder" | "hadQuote" | "reaction" | "kind"> & { started: number }) {
    const state = { spoke: false, reacted: false };
    const quote = () => (t.threadUnder && (conv.threadAlways || shouldThread(!!t.hadQuote, now() - t.started)) ? t.threadUnder : undefined);
    async function send(c: Content, more: boolean): Promise<string> {
      let told: string;
      if (c.kind === "reaction") {
        if (!t.target) return "Nothing to react to.";
        if (t.target.author === messenger.self) return "That is your own message; do not react to it."; // the one rule: no emoji on its own messages
        if (!caps.reactions) return "Reactions are not available here.";
        reactTo(conv, c.emoji, t.target);
        state.reacted = true;
        told = "Reacted.";
      } else if (c.kind === "picture") {
        const caption = c.caption.trim();
        await out.sendPicture(c.file, SILENT.test(caption) ? "" : caption, { kind: t.kind ?? "chat", quote: quote(), target: conv.target });
        state.spoke = true;
        console.log(`${conv.kind} picture sent (${c.id}, ${c.size} bytes)`);
        told = `Sent ${c.id} as a picture.`;
      } else {
        const words = SILENT.test(c.text) ? "" : c.text.trim();
        let spoken = false;
        let speechFailed = false;
        // Safety net: the voice speaks only TTS_LANGUAGES; text in another language would get a wrong accent, so it goes out as text.
        const speakable = c.voice && !!words && canSpeak() && words.length <= MAX_SPOKEN_CHARS;
        const foreign = speakable ? await deps.speech.foreign(words) : undefined;
        if (foreign) console.error(`voice skipped: ${foreign === UNSURE ? "the language of the reply could not be told" : `reply looks ${foreign}`}, the voice speaks ${settings.ttsLanguages.join("/")}; sending text`);
        if (speakable && !foreign) speechFailed = !(spoken = await speak(conv, words));
        if (spoken) {
          state.spoke = true;
          told = "Sent as a voice note.";
        } else if (!words) {
          return "Nothing to send.";
        } else {
          await out.reply(speechFailed ? `${words}\n\n${VOICE_FAILED_NOTE}` : words, { kind: t.kind ?? "chat", quote: quote(), target: conv.target }); // the model may have announced a voice message
          state.spoke = true;
          told = "Sent.";
        }
        console.log(`${conv.kind} ${spoken ? "voice note" : "text"} sent (${words.length} chars)`);
      }
      if (more && typers.has(conv.key)) void messenger.typing(conv.target, true);
      return `${told} Carry on.`;
    }
    return { state, send };
  }

  // The final reply of a run, by its markers: [[voice]] words, [[react: 👍]] with or without words, [[silent]] or nothing.
  async function deliverFinal(conv: Conversation, d: ReturnType<typeof delivery>, replied: string, t: Pick<Turn, "target" | "reaction">): Promise<void> {
    const chosen = splitVoice(replied);
    const { reaction, text } = splitReaction(chosen.text);
    if (conv.source === "chat") scopeOf(conv.key).assistantSaid(text); // the owner's own chat (the others are isolated): the judge reads her next "yes" against it
    await d.send({ kind: "text", text, voice: !!chosen.voice }, false);
    if (reaction && t.target) await d.send({ kind: "reaction", emoji: reaction }, false);
    else if (!t.reaction && !d.state.reacted) status(conv, "✅", t.target); // a reaction the model already put on that message stays
  }

  // "typing…" for a conversation, from the moment it is decided to answer (not when the model starts) until the reply is out.
  // Holds are counted: the early one (the caller, while the gate's delay or an earlier turn is still running) and the turn's
  // own overlap without a stop and a restart in between; the last release stops it. Whoever holds must release (finally).
  // The one place that refreshes it (platforms clear it after a few seconds) and stops it, for the owner and every group.
  const typers = new Map<string, { holds: number; timer?: ReturnType<typeof setInterval> }>();
  function holdTyping(conv: Conversation, timing?: Timing): () => void {
    let t = typers.get(conv.key);
    if (!t) {
      // Only where the messenger shows "typing…" (Signal does not in Note to Self).
      t = { holds: 0, timer: caps.typing ? setInterval(() => void messenger.typing(conv.target, true), 8000) : undefined };
      typers.set(conv.key, t);
      void messenger.typing(conv.target, true);
    }
    timing?.mark("typing");
    const mine = t;
    mine.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--mine.holds > 0) return;
      clearInterval(mine.timer);
      typers.delete(conv.key);
      void messenger.typing(conv.target, false);
    };
  }

  const lastNotice = new Map<string, number>();
  // Tell the conversation what went wrong (the usage limit, an expired login, "something broke"), at most once per conv.noticeEveryMs
  // (always in the owner's chat, every few minutes in a group). The one place both turns that fail and a gate that cannot decide use.
  async function warn(conv: Conversation, e: unknown, quote?: Quote): Promise<boolean> {
    if (now() - (lastNotice.get(conv.key) ?? 0) < conv.noticeEveryMs) return false;
    lastNotice.set(conv.key, now());
    return out.reply(conv.notice(e), { quote: conv.groupId ? quote : undefined, kind: conv.target ? "chat" : undefined, target: conv.target }).then(() => true, () => false);
  }

  // One run for one conversation: typing, the model, the reply, or a notice if it failed. Call it inside
  // enqueue(). It never throws: a failure becomes a notice (if someone is waiting) and a result.
  async function runTurn(conv: Conversation, turn: Turn): Promise<TurnResult> {
    const started = now();
    const background = !!turn.reaction || !!turn.background; // a reaction or a wake-up is no conversation: no typing, no icons
    if (!background) status(conv, "👀", turn.target); // 👀 working, ✅ answered, ⚠️ failed, each replacing the last
    const typing = background ? undefined : holdTyping(conv, turn.timing); // already showing if the decision to answer came earlier
    const d = delivery(conv, { ...turn, started }); // one for the whole turn: the tool sends and the final reply share its state
    // The `send` tool (send.ts): the same delivery as the final reply; none for a reaction or a wake-up. Its screenshots go when the turn ends.
    const sink: SendSink | undefined = background ? undefined : (c) => d.send(c, true);
    try {
      const by = turn.target?.author;
      const asking = { author: by, timestamp: turn.target?.timestamp, owner: conv.source === "chat" || (!!by && deps.isOwner({ from: by, fromUuid: by })) };
      const { text, costUsd } = await withSend(conv.key, sink, () => turn.run({ firstOutput: () => turn.timing?.mark("first") }), asking);
      turn.timing?.set("run", now() - started);
      console.log(`${conv.kind} replied (${text.length} chars${costUsd === undefined ? "" : `, $${costUsd.toFixed(4)}`})`);
      await deliverFinal(conv, d, text, turn);
      const sent = d.state;
      turn.timing?.mark("total");
      turn.timing?.report(); // before compaction: that runs after the reply and is not part of the wait
      if (conv.kind === "group") audit("group_reply", sent.spoke || sent.reacted ? "sent" : "silent", "group");
      if (!turn.reaction) await deps.compact?.(conv, "urgent");
      return { spoke: sent.spoke };
    } catch (e) {
      turn.timing?.mark("total");
      turn.timing?.report();
      console.error(background ? `agent error (${turn.background ? "wake-up" : "reaction"}):` : `${conv.kind}: run failed:`, (e as Error).message); // a reaction needs no apology
      if (conv.kind === "group") audit("group_reply", "failed", "group", { error: (e as Error).message.slice(0, LIMITS.preview) });
      let noticed = false;
      if (!background) status(conv, "⚠️", turn.target);
      // Someone is waiting: say what is wrong (but not over and over, in a group).
      if (!background && turn.announce) noticed = await warn(conv, e, turn.threadUnder);
      return { spoke: false, error: e, noticed };
    } finally {
      typing?.();
      deps.afterTurn?.(conv);
    }
  }

  // The owner's messages of one burst, as the model sees them: oldest first, each with its own quote and voice marks.
  function ownerPrompt(ms: readonly Held[]): string {
    const docs = new Set<Document>(takeDocuments(ms.map((x) => x.document))); // the newest few only
    const one = (m: Held) => withQuoteContext(m.edit ? editNote(m.text, m.edit.before) : m.voice ? `[Voice message, transcribed automatically, so words may be misheard] ${m.text}` : m.picture ? `${PICTURE_NOTE} ${m.text}`.trim() : m.document && docs.has(m.document) ? `${documentNote(m.document)}\n${m.text}`.trim() : m.text, m.quote);
    const text = ms.length === 1 ? one(ms[0]!) : `${ms.length} messages arrived one after another, oldest first. Answer them together, as one reply:\n\n${ms.map(one).join("\n\n")}`;
    return canSpeak() ? `${text}\n\n${voiceOption(true)}` : text;
  }

  // Tell the sender why their voice message or picture could not be used: the owner always gets the reason (`before` runs
  // first, for the owner only); in a group only someone who spoke to the assistant does, otherwise it just moves on.
  async function tell(conv: Conversation, m: IncomingMessage, why: string, before?: () => void): Promise<void> {
    if (conv.attention === "always") {
      before?.();
      if (conv.target) await out.reply(why, { plain: true, target: conv.target });
      else await out.replyPlain(why);
    } else if (m.addressedToMe) await out.reply(why, { kind: "chat", target: conv.groupId });
  }

  // Voice message -> text, or false when it could not be understood (the sender was told, if they should be).
  async function hear(conv: Conversation, m: IncomingMessage): Promise<Held | false> {
    const target = { author: m.from, timestamp: m.timestamp };
    if (conv.attention === "always") status(conv, "👂", target);
    try {
      const text = clean("voice transcript", await deps.transcript(m), { max: LIMITS.body });
      // Kept (id only, no copy) so the voice tool can build a cloned voice from it: per conversation, never across conversations.
      if (settings.tts.provider === "qwen" && m.audio) holdVoiceNote(conv.key, { ts: m.timestamp, id: m.audio.id, size: m.audio.size, by: m.from || m.fromUuid || "", byName: m.fromName && oneLine("sender name", m.fromName, 40), snippet: oneLine("voice note", text, 60) });
      return { ...m, text, audio: undefined, voice: true };
    } catch (e) {
      await tell(conv, m, (e as Error).message, () => status(conv, "⚠️", target));
      return false;
    }
  }

  // A picture -> the message with it attached, or false when it could not be opened (the sender was told, if they should be).
  // The same step for every conversation; the bytes go to the model for this turn and nowhere else.
  async function see(conv: Conversation, m: IncomingMessage): Promise<Held | false> {
    console.log(`🖼️ image${m.text ? ` (caption ${m.text.length} chars)` : ""}`);
    try {
      return { ...m, image: undefined, picture: await deps.picture(m) };
    } catch (e) {
      await tell(conv, m, (e as Error).message);
      return false;
    }
  }

  // A PDF, text file or audio file -> the message with it attached, or false when it could not be opened or is not a kind we read (the sender
  // was told, if they should be). Like see(): one step for every conversation; only its size and kind are logged, never the name or the content.
  async function openFile(conv: Conversation, m: IncomingMessage): Promise<Held | false> {
    console.log(`📄 file (${m.file!.size} bytes${m.text ? `, caption ${m.text.length} chars` : ""})`);
    try {
      const document = await deps.document(m);
      // An audio file with speech in it is also a source for the voice tool (same list as voice messages; id only, never a copy): per conversation.
      if (document.kind === "audio" && document.speech && settings.tts.provider === "qwen") {
        holdVoiceNote(conv.key, { ts: m.timestamp, id: m.file!.id, size: m.file!.size, by: m.from || m.fromUuid || "", byName: m.fromName && oneLine("sender name", m.fromName, 40), snippet: oneLine("audio file", document.text, 60), kind: "file", name: document.name, seconds: document.seconds });
      }
      return { ...m, file: undefined, document };
    } catch (e) {
      await tell(conv, m, (e as Error).message);
      return false;
    }
  }

  const LONG_CUT_NOTE = "[Note: this message was long and arrived cut off; the full text could not be read. Say so if the missing end matters, and ask to have it sent again]";
  const LONG_CUT_AT = `[Note: this message was very long; only the first ${MAX_LONG_TEXT_BYTES / 1024} KB are shown]`;

  // A long message: some platforms (Signal) send the first ~2000 characters as the body and all of it as an attachment. The attachment's text
  // takes the body's place (when it starts with the body; otherwise it follows it); it is cleaned like any text right after. Unreadable: the
  // cut body stays, with a note for the model. Never a file, so no "unsupported" sentence. Only the size is logged.
  async function withLongText(m: IncomingMessage): Promise<IncomingMessage> {
    if (!m.longText) return m;
    const { longText: ref, ...rest } = m;
    const got = await deps.longText?.(m);
    if (!got) {
      console.log(`long message: attachment (${ref.size} bytes) could not be read, using the cut text (${m.text.length} chars)`);
      return { ...rest, text: `${m.text}\n${LONG_CUT_NOTE}`.trim() };
    }
    console.log(`long message: ${got.text.length} chars from the attachment (body ${m.text.length} chars)`);
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const head = norm(m.text).slice(0, LIMITS.preview);
    const whole = !head || norm(got.text).startsWith(head) ? got.text : `${m.text}\n${got.text}`;
    return { ...rest, text: got.cut ? `${whole}\n${LONG_CUT_AT}` : whole };
  }

  // Everything a message goes through before its conversation decides what to do with it. The same steps for the owner and
  // every group; the Conversation's flags (vouch, attention, optionalPictures) say where they differ.
  async function intake(conv: Conversation, incoming: IncomingMessage): Promise<void> {
    const original = cleanIncoming(await withLongText(incoming)); // the door: hidden characters never get past here
    const arrived = now();
    if (conv.vouch && !(await deps.vouch(conv.groupId!))) return; // a group we cannot vouch for gets nothing, not even a transcription
    if (original.edited) return edit(conv, original, arrived);
    const author = original.from || original.fromUuid;
    if (caps.readReceipts) {
      if (conv.attention === "always") void messenger.markRead(conv.target, { timestamp: original.timestamp, author: conv.kind === "tenant" ? author : undefined }); // the owner sees it was read, as soon as we have it (a tenant: the receipt goes to her)
      else if (original.addressedToMe && author) void messenger.markRead(conv.target, { timestamp: original.timestamp, author }); // only those who spoke to us see "seen"
    }
    if (settings.tts.provider === "qwen") {
      rememberSender(conv.key, author, original.fromName && oneLine("sender name", original.fromName, 40));
      if (original.quotedAudio) holdQuote(conv.key, original.timestamp, original.quotedAudio);
    }
    let m: Held = original;
    if (m.audio) {
      const heard = await hear(conv, m);
      if (!heard) return;
      m = heard;
    }
    if (m.image) {
      // Looked at only when it will be used: in "tagged" mode a picture nobody addressed to us is just a line in the history.
      const seen = !conv.optionalPictures || m.addressedToMe || settings.groupParticipation !== "tagged" ? await see(conv, m) : false;
      if (!seen && !conv.optionalPictures) return;
      m = { ...m, image: undefined, picture: seen ? seen.picture : undefined };
    }
    if (m.file) {
      // An audio file is opened like a voice message is transcribed, whoever it is for (it may be the source of a voice someone asks for next).
      const seen = !conv.optionalPictures || m.addressedToMe || settings.groupParticipation !== "tagged" || m.file.audio ? await openFile(conv, m) : false;
      if (!seen && !conv.optionalPictures) return;
      m = { ...m, file: undefined, document: seen ? seen.document : undefined };
    }
    // The line for the history: searchable, and what the dream learns from (never the picture or the document itself).
    const line = original.audio ? `🎙️ ${m.text}` : original.image ? `🖼️ ${m.text || "image"}` : original.file ? `📄 ${m.text || (m.document?.kind === "audio" ? "audio file" : "document")}` : m.text;
    if (!conv.approvals) {
      // A question asked in this group is answered here by ANY member (their message, a quoted reply or a reaction); the model reads it
      // like the owner's. Only this group's approvals can be answered; an edit and a caption never answer.
      if (await approvalAnswer(conv, m, author)) return;
      return deps.admitGroup(conv, { groupId: conv.groupId!, arrivedAt: arrived, text: line, picture: m.picture, document: m.document, timestamp: m.timestamp, isOwner: deps.isOwner(m), fromName: m.fromName, addressedToMe: !!m.addressedToMe, author, quote: m.quote, voice: m.voice });
    }
    return ownerTurn(conv, m, line, arrived);
  }

  // An edit of an earlier message, the same for the owner's chat and every group. Only its author may edit it; the original may be
  //   still waiting (settling, queued, or being judged by the gate): the edit takes its place, so the answer is about the new text;
  //   answered already: the edit is a new message that says it is one (and what it replaced), so the answer can be corrected;
  //   unchanged (after whitespace and Unicode normalisation): nothing happens.
  // An edit is never an approval answer, whatever the original was: the owner's path below skips the approval check, and an edit of a
  // message that WAS taken as an answer is dropped altogether.
  async function edit(conv: Conversation, m: IncomingMessage, arrived: number): Promise<void> {
    const targetTs = m.edited!.targetTimestamp;
    const past = revisionsOf(targetTs, conv.logFile);
    const stamps = past ? past.stamps : [targetTs];
    if (stamps.some((t) => approvalAnswers.has(t))) return void console.log("edit of an approval answer ignored");
    const waiting = pendingOf(conv, stamps);
    if (!waiting && past && past.root.kind !== "owner" && past.root.kind !== "member" && past.root.kind !== "edit") return void console.log("edit of a message that is not someone's own ignored");
    if (!waiting && !past && conv.kind === "group") return void console.log("edit of an unknown message in a group ignored"); // nobody to check it against
    if (!isAuthor(m, waiting ? authorOf(waiting) : past?.root.by, conv.direct)) return void console.log(`edit by someone other than the author ignored (${conv.kind})`);
    const prior = waiting ? (waiting as { text: string }).text : past?.latest.text;
    const author = m.from || m.fromUuid;
    const via = { targetTimestamp: targetTs, stamps, prior, pending: !!waiting, picture: (waiting as { picture?: Picture } | undefined)?.picture, document: (waiting as { document?: Document } | undefined)?.document };
    if (conv.kind === "group") {
      if (author && m.addressedToMe && caps.readReceipts) void messenger.markRead(conv.target, { timestamp: m.timestamp, author });
      return deps.admitGroup(conv, { groupId: conv.groupId!, arrivedAt: arrived, text: m.text, picture: via.picture, document: via.document, timestamp: m.timestamp, isOwner: deps.isOwner(m), fromName: m.fromName, addressedToMe: !!m.addressedToMe, author, quote: m.quote, edit: via });
    }
    if (prior !== undefined && sameText(prior, m.text)) return void console.log("edit changes nothing, ignored");
    if (waiting) dropPending(conv, stamps);
    const held: Held = { ...m, picture: via.picture, document: via.document, ...(waiting ? {} : { edit: { before: prior } }) };
    return ownerTurn(conv, held, m.text, arrived, { of: targetTs });
  }

  // Is this message the answer to a question open in THIS conversation? Then it is consumed (and the owner or group is told what happened).
  // Never an edit (an approval is answered by a new message, a reaction or a quoted reply, so "no" edited into "yes" changes nothing)
  // and never a picture caption. A voice message is a message like any other; the judge is told it is an automatic
  // transcript.
  async function approvalAnswer(conv: Conversation, m: Held, by: string | undefined): Promise<boolean> {
    if (m.picture || m.edit) return false;
    const target = { author: m.from, timestamp: m.timestamp };
    const { outcome, changes, reply } = await deps.approvals.answer(m.text, () => status(conv, "⏳", target), m.quote, undefined, { scope: conv.key, by, voice: !!m.voice });
    if (outcome === "none") return false;
    answeredApproval(m.timestamp);
    console.log(`approval ${outcome}${changes ? ` (${changes.map((c) => c.field).join(", ")})` : ""}`);
    const say = (text: string) => out.reply(text, { plain: true, target: conv.target });
    reactTo(conv, { approved: "👍", modified: "👍", declined: "👎", feedback: "💬", clarify: "💬" }[outcome], target);
    if (reply) await say(reply); // clarify: the approval stays open and this message was an answer, not a request; approved / declined with a reply: the parts of a multi-answer that are still open
    // An edited call runs without a second look, so say exactly what changed.
    if (outcome === "modified" && changes) await say(`Applied your change: ${changes.map((c) => `${c.field} → ${c.value}`).join(", ")}`);
    return true;
  }

  async function ownerTurn(conv: Conversation, m: Held, line: string, arrived: number, edited?: { of: number }): Promise<void> {
    record(conv, edited ? "edit" : "owner", m.timestamp, line, { by: m.from || m.fromUuid, ...(edited ? { of: edited.of } : {}) });
    // The card's kill switch: handled here, in code, before any model sees the message, and only for the owner's own chat. It can only switch card
    // use OFF; switching it on is the terminal's (card.ts).
    if (allows(conv, "card") && !edited && !m.picture && !m.document) {
      const said = cardCommand(m.text);
      if (said !== undefined) return void (await out.reply(said, { plain: true }));
    }
    // While an approval is pending, a message may be its answer. That must skip the queue.
    if (!edited && (await approvalAnswer(conv, m, m.from || m.fromUuid))) return;
    await burst(conv, m, async (b) => {
      const typing = holdTyping(conv, b.timing); // the owner is always answered: show it now, even while an earlier turn still runs
      try {
        await b.run(async (items) => {
          const ms = items.sort((a, c) => a.timestamp - c.timestamp);
          const last = ms[ms.length - 1]!;
          for (const x of ms) {
            console.log(`owner message (${x.text.length} chars)`);
            if (x.quote) console.log(`owner is replying to an earlier message (${x.quote.text.length} chars)`);
          }
          const prompt = ownerPrompt(ms);
          await runTurn(conv, {
            run: (hooks) => deps.run(conv, prompt, ms.map((x) => x.text).join("\n"), ms.flatMap((x) => x.picture ?? []).slice(-MAX_PICTURES), hooks, takeDocuments(ms.map((x) => x.document))),
            target: { author: last.from, timestamp: last.timestamp },
            threadUnder: { text: last.text.slice(0, LIMITS.preview), author: last.from, timestamp: last.timestamp },
            hadQuote: ms.some((x) => x.quote),
            announce: true,
            timing: b.timing,
          });
        });
      } finally {
        typing();
      }
    }, arrived);
  }

  // Any reaction that is not an approval answer is feedback on a message. The model is told which message
  // it was on (looked up by timestamp in the log) and decides what, if anything, it means.
  async function ownerReaction(conv: Conversation, r: IncomingReaction): Promise<void> {
    const outcome = deps.approvals.answerReaction(r.emoji, r.targetTimestamp, conv.key, r.from || r.fromUuid);
    if (outcome === "needs_text") return void (await out.reply(TYPED_YES_NEEDED, { plain: true })); // a payment is not approved by a reaction
    if (outcome !== "ignored") return void console.log(`approval ${outcome} (by reaction)`);
    await enqueue(conv, async () => {
      console.log(`owner reacted ${r.emoji}`);
      const on = findMessage(r.targetTimestamp, conv.logFile);
      record(conv, "reaction", now(), `${r.emoji} on: ${(on?.text ?? "an older message").slice(0, LIMITS.preview)}`);
      const prompt = reactionPrompt(r.emoji, on);
      // The judge is told "<owner> reacted <emoji>" as the owner's message and the reacted-to text as what the assistant said (it may quote mail): never as their words.
      await runTurn(conv, { run: () => deps.run(conv, prompt, reactionMessage(oneLine("reaction", r.emoji, 16)), undefined, undefined, undefined, on?.text), target: { author: r.targetAuthor ?? messenger.self, timestamp: r.targetTimestamp }, reaction: true, announce: false });
    });
  }

  async function groupReaction(conv: Conversation, r: IncomingReaction): Promise<void> {
    const groupId = conv.groupId!;
    if (!(await deps.vouch(groupId))) return;
    const answered = deps.approvals.answerReaction(r.emoji, r.targetTimestamp, conv.key, r.from || r.fromUuid); // a reaction on a question asked in this group
    if (answered !== "ignored") return void console.log(`approval ${answered} (by reaction, in a group)`);
    const on = findMessage(r.targetTimestamp, conv.logFile)?.text ?? "an older message";
    return deps.admitGroup(conv, { groupId, text: "", timestamp: now(), isOwner: deps.isOwner(r), fromName: r.fromName && oneLine("group member name", r.fromName, LIMITS.name), addressedToMe: false, reaction: { emoji: oneLine("reaction", r.emoji, 16), on } });
  }

  // A message deleted for everyone. Only its author can. Still waiting: it is dropped, so it is never answered and nothing in it is
  // acted on. Answered already: a marker line says so, nothing runs again. Nobody is told about it, in a group least of all.
  async function deletion(conv: Conversation, d: IncomingDeletion): Promise<void> {
    if (conv.vouch && !(await deps.vouch(conv.groupId!))) return;
    const past = revisionsOf(d.targetTimestamp, conv.logFile);
    const stamps = past ? past.stamps : [d.targetTimestamp];
    const waiting = pendingOf(conv, stamps);
    if (!waiting && !past) return void console.log("delete of an unknown message ignored");
    if (past?.deleted) return;
    if (!waiting && past && past.root.kind !== "owner" && past.root.kind !== "member" && past.root.kind !== "edit") return void console.log("delete of a message that is not someone's own ignored");
    if (!isAuthor(d, waiting ? authorOf(waiting) : past?.root.by, conv.direct)) return void console.log(`delete by someone other than the author ignored (${conv.kind})`);
    dropPending(conv, stamps);
    console.log(`${conv.kind} message deleted by its author${waiting ? " before it was answered" : ""}`);
    if (conv.direct) return record(conv, "delete", now(), `[${DELETED_LINE}]`, { of: d.targetTimestamp });
    // The group brain writes the marker (it knows how members are named) and forgets a pending address of the deleted message.
    return deps.admitGroup(conv, { groupId: conv.groupId!, text: "", timestamp: now(), isOwner: deps.isOwner(d), fromName: d.fromName && oneLine("group member name", d.fromName, LIMITS.name), addressedToMe: false, deletion: { targetTimestamp: d.targetTimestamp, stamps } });
  }

  // Everything that arrives for a conversation. The caller has already decided who may speak to it
  // (guards.ts for the owner's chat; our own echoes and reactions are dropped before this).
  function handleIncoming(conv: Conversation, ev: Incoming): Promise<void> {
    if (ev.type === "deletion") return deletion(conv, ev.d);
    if (conv.direct) return ev.type === "message" ? intake(conv, ev.m) : ownerReaction(conv, ev.r);
    return ev.type === "message" ? intake(conv, ev.m) : groupReaction(conv, ev.r);
  }

  // `react`: a quick reaction of our own, no run needed (the gate chose it).
  return { handleIncoming, enqueue, burst, burstQueued, wait, holdTyping, runTurn, record, canSpeak, react: reactTo, warn, dropPending };
}

export type Pipeline = ReturnType<typeof createPipeline>;
