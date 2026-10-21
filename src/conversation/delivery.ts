import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { audit } from "../core/audit.ts";
import type { Conversation, PipelineDeps, Turn, TurnResult } from "./conversationmodel.ts";
import { shouldThread } from "./quote.ts";
import { RunStopped } from "../run/ceiling.ts";
import { withSend, type Content, type SendSink } from "../modules/send/send.ts";
import { splitReaction } from "../core/reaction.ts";
import { scopeOf } from "../approvals/turnscope.ts";
import { splitVoice, VOICE_FAILED_NOTE } from "./voicereply.ts";
import { settings } from "../core/settings.ts";
import { UNSURE } from "./lang.ts";
import { LIMITS } from "../core/sanitize.ts";
import { type Timing } from "../core/timing.ts";
import type { Quote } from "@ted-assistant/messenger";
import { MAX_SPOKEN_CHARS } from "@ted-assistant/speech/tts";
import { lastNoticeAt, markNoticeAt } from "../core/capnotice.ts";

const SILENT = /^\s*\[\[silent\]\]\s*$/i;

// Everything the assistant says or shows while a conversation is being answered: the delivery of a reply (text, voice, picture, reaction), "typing…", the failure notice, and the run of one turn.
// This module owns the typing holds and the once-per-interval notice record.
export function createDelivery(deps: Pick<PipelineDeps, "messenger" | "out" | "now" | "speech" | "isOwner" | "compact" | "afterTurn">) {
  const { messenger, out } = deps;
  const caps = messenger.capabilities;
  const now = deps.now ?? Date.now;

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
      file = await deps.speech.synth(words, conv.convId); // the voice active in THIS conversation (its library: voices/ in its folder)
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
    const state = { spoke: false, reacted: false, pieces: 0 }; // pieces: what was really delivered, one per send
    const quote = () => (t.threadUnder && (conv.threadAlways || shouldThread(!!t.hadQuote, now() - t.started)) ? t.threadUnder : undefined);
    async function send(c: Content, more: boolean): Promise<string> {
      let told: string;
      if (c.kind === "reaction") {
        if (!t.target) return "Nothing to react to.";
        if (t.target.author === messenger.self) return "That is your own message; do not react to it."; // the one rule: no emoji on its own messages
        if (!caps.reactions) return "Reactions are not available here.";
        reactTo(conv, c.emoji, t.target);
        state.reacted = true;
        state.pieces++;
        told = "Reacted.";
      } else if (c.kind === "picture") {
        const caption = c.caption.trim();
        await out.sendPicture(c.file, SILENT.test(caption) ? "" : caption, { kind: t.kind ?? "chat", quote: quote(), target: conv.target });
        state.spoke = true;
        state.pieces++;
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
          state.pieces++;
          told = "Sent as a voice note.";
        } else if (!words) {
          return "Nothing to send.";
        } else {
          await out.reply(speechFailed ? `${words}\n\n${VOICE_FAILED_NOTE}` : words, { kind: t.kind ?? "chat", quote: quote(), target: conv.target }); // the model may have announced a voice message
          state.spoke = true;
          state.pieces++;
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
    // (kept in instance/cap-notices.json across restarts, keyed by the conversation's folder name, never a raw group id; with a clock injected, as tests do, in memory only)
    const persist = deps.now === undefined && conv.noticeEveryMs > 0;
    const last = lastNotice.get(conv.key) ?? (persist ? lastNoticeAt(`warn:${conv.convId}`) : undefined) ?? 0;
    if (now() - last < conv.noticeEveryMs) return false;
    lastNotice.set(conv.key, now());
    if (persist) markNoticeAt(`warn:${conv.convId}`, now());
    if (lastNotice.size > 50) for (const [key, at] of lastNotice) if (now() - at > 24 * 3_600_000) lastNotice.delete(key); // (only the last few minutes of an entry matter)
    return out.reply(conv.notice(e), { quote: conv.groupId ? quote : undefined, kind: conv.target ? "chat" : undefined, target: conv.target }).then(() => true, () => false);
  }

  // An unattended run that may speak while it works (the heartbeat run and its expert): the SAME send tool as a chat turn, delivered by the same function as the final reply, as a
  // notice in the conversation the run belongs to. It takes no place in the queue (the run may wait on an approval); `onSend` counts each piece delivered.
  async function sendWhile<T>(conv: Conversation, run: () => Promise<T>, onSend?: () => void): Promise<T> {
    const d = delivery(conv, { kind: "notice", started: now() });
    return withSend(conv.key, async (c) => {
      const before = d.state.pieces;
      const told = await d.send(c, false);
      if (d.state.pieces > before) onSend?.();
      return told;
    }, run);
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
      if (!background && turn.announce && !(e instanceof RunStopped)) noticed = await warn(conv, e, turn.threadUnder); // (stopped by the owner: "Stopped." was the answer)
      return { spoke: false, error: e, noticed };
    } finally {
      typing?.();
      deps.afterTurn?.(conv);
    }
  }

  return { reactTo, status, canSpeak, holdTyping, warn, sendWhile, runTurn };
}

export type Delivery = ReturnType<typeof createDelivery>;
