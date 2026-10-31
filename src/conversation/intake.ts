import { allows } from "../policy/capabilities.ts";
import { cleanIncoming, type Batch, type Conversation, type Entry, type Held, type Incoming, type PipelineDeps } from "./conversationmodel.ts";
import { findMessage, revisionsOf, type Extra, type Kind, type Sent } from "../core/messages.ts";
import { editNote, DELETED_LINE, isAuthor, sameText } from "./edit.ts";
import { MAX_PICTURES, PICTURE_NOTE } from "../run/image.ts";
import { documentNote, takeDocuments, type Document } from "./document.ts";
import { withQuoteContext } from "./quote.ts";
import { holdQuote, holdVoiceNote, rememberSender } from "../modules/voice/voicenote.ts";
import { cardCommand } from "../modules/browse/card.ts";
import { commandReply } from "./ownercommands.ts";
import { TYPED_YES_NEEDED } from "../modules/browse/paymentrules.ts";
import { reactionMessage, reactionPrompt } from "../core/reaction.ts";
import { journalAround } from "../memory/journalread.ts";
import { scopeOf } from "../approvals/turnscope.ts";
import { createGroupAnswering, speaker, type Go } from "./group.ts";
import { replayPrompt } from "./replay.ts";
import { forgetDeclined } from "../approvals/declined.ts";
import { voiceOption } from "./voicereply.ts";
import { settings } from "../core/settings.ts";
import { clean, defuseSpeakers, LIMITS, oneLine } from "../core/sanitize.ts";
import { MAX_LONG_TEXT_BYTES, type IncomingDeletion, type IncomingMessage, type IncomingReaction } from "@ted-assistant/messenger";
import type { Queue } from "./queue.ts";
import type { Delivery } from "./delivery.ts";

// ONE INTAKE for every conversation (docs/ARCHITECTURE.md, "One intake"): everything that arrives for the owner's chat, a friend's and a group, a message (text, voice, picture, file), an
// edit, a deletion or a reaction, goes through the same ordered chain of steps below, and the only per-kind differences are the rows of WAYS. This module owns the record of messages
// taken as approval answers.
export function createIntake(deps: PipelineDeps, queue: Queue, delivery: Delivery) {
  const { messenger, out } = deps;
  const caps = messenger.capabilities;
  const now = deps.now ?? Date.now;
  const { burst, enqueue, overtake, pendingOf, authorOf, dropPending } = queue;
  const { reactTo, status, canSpeak, holdTyping, runTurn } = delivery;
  const answering = createGroupAnswering(deps, delivery, queue);

  const record = (conv: Conversation, kind: Kind, ts: number, text: string, extra?: Extra) => deps.record(conv.target, kind, ts, text, extra);

  // Timestamps of messages that were taken as the answer to an approval: an edit of one never answers anything (see edit()).
  const approvalAnswers = new Set<number>();
  const answeredApproval = (ts: number) => {
    approvalAnswers.add(ts);
    if (approvalAnswers.size > 200) approvalAnswers.delete(approvalAnswers.keys().next().value!);
  };

  // The owner's messages of one burst, as the model sees them: oldest first, each with its own quote and voice marks.
  function ownerPrompt(ms: readonly Held[]): string {
    const docs = new Set<Document>(takeDocuments(ms.map((x) => x.document))); // the newest few only
    const one = (m: Held) => withQuoteContext(m.edit ? editNote(m.text, m.edit.before) : m.voice ? `[Voice message, transcribed automatically, so words may be misheard] ${m.text}` : m.picture ? `${PICTURE_NOTE} ${m.text}`.trim() : m.document && docs.has(m.document) ? `${documentNote(m.document)}\n${m.text}`.trim() : m.text, m.quote);
    const text = ms.length === 1 ? one(ms[0]!) : `${ms.length} messages arrived one after another, oldest first. Answer them together, as one reply:\n\n${ms.map(one).join("\n\n")}`;
    return canSpeak() ? `${text}\n\n${voiceOption(true)}` : text;
  }

  // Tell the sender why their voice message or picture could not be used: where everyone is heard (WAYS) they always get the reason (`before` runs
  // first, for them only); otherwise only someone who spoke to the assistant does, and the rest just moves on.
  async function tell(conv: Conversation, m: IncomingMessage, why: string, before?: () => void): Promise<void> {
    if (waysOf(conv).everyone) {
      before?.();
      if (conv.target) await out.reply(why, { plain: true, target: conv.target });
      else await out.replyPlain(why);
    } else if (m.addressedToMe) await out.reply(why, { kind: "chat", target: conv.groupId });
  }

  // Voice message -> text, or false when it could not be understood (the sender was told, if they should be).
  async function hear(conv: Conversation, m: IncomingMessage): Promise<Held | false> {
    const target = { author: m.from, timestamp: m.timestamp };
    if (waysOf(conv).everyone) status(conv, "👂", target);
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

  // ---- THE TABLE: the only places where the kinds of conversation differ on the way in ----
  // A private chat (the owner's, a friend's) and a group are told apart by `conv.direct` here and nowhere else in the chain. Everything else is the same function for all of them.
  //   who may do what   code-only commands are checked against the conversation's capabilities (ownercommands.ts: /card needs "card", /pause "admin", /tasks "tasks", ...), not its kind.
  //   the answer        a private chat always answers; a group answers when addressed (`forUs`: tagged or quoted, then sticky until answered) or when the participation gate says act
  //                     (`mayAnswer`, `decide`, group.ts). A paused or over-budget group answers nothing, and says so once to someone who addressed it.
  //   who is heard      `everyone`: every sender gets the reason for a voice message or picture that could not be used; otherwise only someone who spoke to us. (A read receipt goes to
  //                     every sender in both: a vouched group's messages are all read and logged, and the "seen" mark is how its members can tell the assistant is online.)
  //                     `vouch`: the group's sponsor (the owner, or an active friend who may add us to her groups; group.ts sponsorInGroup) must be a member (a stranger cannot add us to a group and use it). `optionalPictures`: a picture is opened only when it
  //                     can be answered, and an unusable one is dropped (the caption stays); otherwise it is required.
  //   history           `recorded`/`say`/`sayReaction`: how a line reads in the log (a group's lines name their speaker).
  //   the turn          `turn`: how the burst is shown to the model (a private chat: the messages; a group: its recent log, fenced) and delivered (threading and target are the
  //                     Conversation's: threadAlways, target). A reaction in a private chat is a quiet turn of its own; in a group a reaction (or quoted reply) to the assistant's own message is addressed to it, one on anyone else's is chatter.
  // Delivery data that stays on the Conversation: target (where it goes), threadAlways, notice and noticeEveryMs (conversationmodel.ts).
  type Who = { from: string; fromUuid?: string; fromName?: string };
  interface Ways {
    vouch: boolean;
    everyone: boolean;
    optionalPictures: boolean;
    recorded: "owner" | "member";
    forUs: (m: { addressedToMe?: boolean }) => boolean;
    mayAnswer: (m: { addressedToMe?: boolean }) => boolean;
    say: (who: Who, text: string, max?: number) => string;
    sayReaction: (who: Who, emoji: string, on: string) => { line: string; said: string };
    note: (conv: Conversation, e: Entry) => void;
    forget: (conv: Conversation, stamps: readonly number[], deleted: boolean) => void;
    react: (conv: Conversation, r: IncomingReaction, e: Entry) => Promise<void>;
    decide: (conv: Conversation, d: { batch: Batch<Entry>; e: Entry; showTyping: () => void }) => Promise<Go | undefined>;
    turn: (conv: Conversation, items: Entry[], go: Go, batch: Batch<Entry>) => Promise<void>;
  }
  const WAYS: { private: Ways; group: Ways } = {
    private: {
      vouch: false,
      everyone: true,
      optionalPictures: false,
      recorded: "owner",
      forUs: () => true,
      mayAnswer: () => true,
      say: (_who, text) => text,
      sayReaction: (_who, emoji, on) => ({ line: `${emoji} on: ${on.slice(0, LIMITS.preview)}`, said: emoji }),
      note: () => {},
      forget: () => {},
      react: privateReaction,
      decide: async (_conv, { showTyping }) => (showTyping(), {}), // the owner is always answered: show it now, even while an earlier turn still runs
      turn: privateTurn,
    },
    group: {
      vouch: true,
      everyone: false,
      optionalPictures: true,
      recorded: "member",
      forUs: (m) => !!m.addressedToMe,
      mayAnswer: answering.mayAnswer,
      say: (who, text, max = LIMITS.logLine) => `${speaker({ isOwner: deps.isOwner(who), fromName: who.fromName })}: ${defuseSpeakers(clean("group message", text, { max }))}`,
      sayReaction: (who, emoji, on) => {
        const name = speaker({ isOwner: deps.isOwner(who), fromName: who.fromName });
        return { line: `${name} reacted ${oneLine("reaction", emoji, 16)} to: ${defuseSpeakers(clean("reaction", on, { max: LIMITS.preview }))}`, said: `${name} reacted ${oneLine("reaction", emoji, 16)}` };
      },
      note: answering.note,
      forget: answering.forget,
      react: (conv, _r, e) => (answering.note(conv, e), settle(conv, WAYS.group, e)), // (note remembers an address: a reaction to our own message is one)
      decide: answering.decide,
      turn: answering.turn,
    },
  };
  const PEOPLE: ReadonlySet<Kind> = new Set<Kind>(["owner", "member", "edit", "reaction", "delete"]); // log kinds written by people; every other kind is the assistant's own
  const NEGATIVE: ReadonlySet<string> = new Set(["👎"]); // the reactions that are a correction; any other reaction on our message is chatter
  const waysOf = (conv: Conversation): Ways => (conv.direct ? WAYS.private : WAYS.group);

  // A private chat's turn: the burst's messages as one prompt, one run.
  async function privateTurn(conv: Conversation, ms: Entry[], _go: Go, b: Batch<Entry>): Promise<void> {
    const last = ms[ms.length - 1]!;
    for (const x of ms) {
      console.log(`owner message (${x.text.length} chars)`);
      if (x.quote) console.log(`owner is replying to an earlier message (${x.quote.text.length} chars)`);
    }
    const late = ms.filter((x) => x.late);
    const shown = late.length ? replayPrompt(late.map((x) => ({ at: x.late!.at, text: x.text }))) : ownerPrompt(ms);
    await runTurn(conv, {
      run: (hooks) => deps.run(conv, shown, ms.map((x) => x.text).join("\n"), ms.flatMap((x) => x.picture ?? []).slice(-MAX_PICTURES), hooks, takeDocuments(ms.map((x) => x.document)), undefined, undefined, ms[0]!.timestamp),
      target: { author: last.from, timestamp: last.timestamp },
      threadUnder: { text: last.text.slice(0, LIMITS.preview), author: last.from, timestamp: last.timestamp },
      hadQuote: ms.some((x) => x.quote),
      announce: true,
      timing: b.timing,
    });
  }

  // A reaction in a private chat that is not an approval answer is feedback on a message. The model is told which message it was on (looked up by timestamp in the log) and the journal
  // lines around it, and decides what, if anything, it means (a 👎 on something it did is a correction: the learn rule in its persona). A quiet turn: no typing, no icons, no apology.
  async function privateReaction(conv: Conversation, r: IncomingReaction, e: Entry): Promise<void> {
    const on = findMessage(r.targetTimestamp, conv.logFile);
    await enqueue(conv, async () => {
      console.log(`owner reacted ${r.emoji}`);
      const prompt = reactionPrompt(r.emoji, on, e.reaction?.journal);
      // The judge is told "<owner> reacted <emoji>" as the owner's message and the reacted-to text as what the assistant said (it may quote mail): never as their words.
      await runTurn(conv, { run: () => deps.run(conv, prompt, reactionMessage(oneLine("reaction", r.emoji, 16)), undefined, undefined, undefined, on?.text, on ? Date.parse(on.at) || 0 : 0), target: { author: r.targetAuthor ?? messenger.self, timestamp: r.targetTimestamp }, reaction: true, announce: false });
    });
  }

  // ---- THE CHAIN ----
  // A message of any conversation, in this order (an edit skips 2 to 3: it is never a command or an approval answer):
  //   0. the door         hidden characters out, a long message read whole, a group we cannot vouch for gets nothing; read receipt; voice, picture and file made usable; an edit is checked (edit())
  //   1. record           the line goes into the conversation's log, before anything can lose it (replay.ts finds what a restart lost there)
  //   2. commands         code only, before any model: /card off, /stop, /pause, /status, /tasks, /quiet ... each needs a capability the conversation has (ownercommands.ts)
  //   3. approval answer  a message, a quoted reply or a reaction answers a question open in THIS conversation; it is consumed, and never replayed
  //   4. declined         a new message: a declined action may be asked for again (declined.ts)
  //   5. the burst        a message that is for us calls off a look that is running; then a short settling pause, and one turn for everything that arrived (queue.ts)
  //   6. the answer       WAYS.decide: is anything to be said? (a private chat always; a group when addressed or when the gate says act)
  //   7. the turn         WAYS.turn: one run for the burst, delivered by delivery.ts
  async function message(conv: Conversation, incoming: IncomingMessage): Promise<void> {
    const w = waysOf(conv);
    const original = cleanIncoming(await withLongText(incoming)); // the door: hidden characters never get past here
    const arrived = now();
    if (w.vouch && !(await deps.vouch(conv.groupId!))) return; // a group we cannot vouch for gets nothing, not even a transcription
    const author = original.from || original.fromUuid;
    if (caps.readReceipts) {
      if (w.everyone) void messenger.markRead(conv.target, { timestamp: original.timestamp, author: conv.kind === "tenant" ? author : undefined }); // the owner sees it was read, as soon as we have it (a tenant: the receipt goes to her)
      else if (author) void messenger.markRead(conv.target, { timestamp: original.timestamp, author }); // a group: to whoever wrote it, addressed or not (every message is read)
    }
    rememberSender(conv.key, author, original.fromName && oneLine("sender name", original.fromName, 40)); // (memory only, whatever the voice provider: the voice tool and the task tools both name who is asking)
    if (settings.tts.provider === "qwen") {
      if (original.quotedAudio) holdQuote(conv.key, original.timestamp, original.quotedAudio);
    }
    if (original.edited) return edit(conv, original, arrived);
    let m: Held = original;
    if (m.audio) {
      const heard = await hear(conv, m);
      if (!heard) return;
      m = heard;
    }
    if (m.image) {
      // Looked at only when it will be used: in "tagged" mode a picture nobody addressed to us is just a line in the history.
      const seen = w.mayAnswer(m) ? await see(conv, m) : false;
      if (!seen && !w.optionalPictures) return;
      m = { ...m, image: undefined, picture: seen ? seen.picture : undefined };
    }
    if (m.file) {
      // An audio file is opened like a voice message is transcribed, whoever it is for (it may be the source of a voice someone asks for next).
      const seen = w.mayAnswer(m) || m.file.audio ? await openFile(conv, m) : false;
      if (!seen && !w.optionalPictures) return;
      m = { ...m, file: undefined, document: seen ? seen.document : undefined };
    }
    // The line for the history: searchable, and what the dream learns from (never the picture or the document itself).
    const line = original.audio ? `🎙️ ${m.text}` : original.image ? `🖼️ ${m.text || "image"}` : original.file ? `📄 ${m.text || (m.document?.kind === "audio" ? "audio file" : "document")}` : m.text;
    return admit(conv, m, line, arrived);
  }

  // Steps 1 to 7 for a message that is ready (an edit comes here with `edited`: the timestamp of the message it replaces).
  async function admit(conv: Conversation, m: Held, line: string, arrived: number, edited?: { of: number }): Promise<void> {
    if (!line.trim()) return;
    const w = waysOf(conv);
    const author = m.from || m.fromUuid;
    // 1. record
    record(conv, edited ? "edit" : w.recorded, m.timestamp, w.say(m, line), { by: author, ...(edited ? { of: edited.of } : {}), ...(m.addressedToMe ? { addressed: true } : {}) });
    if (!edited) {
      // 2. commands: code only, ahead of the queue, so "stop" works while a turn runs. A caption or a file never makes one.
      if (!m.picture && !m.document) {
        const said = (allows(conv, "card") ? cardCommand(m.text) : undefined) ?? commandReply(conv, m.text, { dropQueued: () => queue.dropAllPending(conv) });
        if (said !== undefined) return void (await out.reply(said, { plain: true, target: conv.target }));
      }
      // 3. approval answer: it skips the queue (the queue is blocked on the very turn that is waiting for it)
      scopeOf(conv.key).wrote(now()); // (an answer to a question is something written too: a reaction on an older message answers nothing newer)
      if (await approvalAnswer(conv, m, author)) return;
    }
    forgetDeclined(conv.key); // 4. a new message: they may be asking for a declined action again (declined.ts)
    const e: Entry = { ...m, line, said: w.say(m, line, LIMITS.message), author, arrivedAt: arrived };
    if (w.forUs(m)) overtake(conv); // 5. a look of this conversation that is running gives way to the turn (a group's other talk is not a chat turn: the look goes on, and its post is judged against the log)
    if (!w.mayAnswer(m)) return;
    w.note(conv, e);
    return settle(conv, w, e);
  }

  // Steps 5 to 7: the burst, the answer decision, the turn. Replay (below) joins here too.
  function settle(conv: Conversation, w: Ways, e: Entry): Promise<void> {
    return burst(conv, e, async (b) => {
      let typing: (() => void) | undefined;
      try {
        const go = await w.decide(conv, { batch: b, e, showTyping: () => void (typing ??= holdTyping(conv, b.timing)) });
        if (go) await b.run((items) => w.turn(conv, items.sort((x, y) => x.timestamp - y.timestamp), go, b));
      } finally {
        typing?.(); // however it ended: answered, silent, superseded or failed
      }
    }, e.arrivedAt);
  }

  // An edit of an earlier message, the same for every conversation. Only its author may edit it; the original may be
  //   still waiting (settling, queued, or being judged by the gate): the edit takes its place, so the answer is about the new text;
  //   answered already: the edit is a new message that says it is one (and what it replaced), so the answer can be corrected;
  //   unchanged (after whitespace and Unicode normalisation): nothing happens.
  // An edit is never an approval answer, whatever the original was (admit skips steps 2 to 4 for it): an edit of a message that WAS taken as an answer is dropped altogether.
  async function edit(conv: Conversation, m: IncomingMessage, arrived: number): Promise<void> {
    const w = waysOf(conv);
    const targetTs = m.edited!.targetTimestamp;
    const past = revisionsOf(targetTs, conv.logFile);
    const stamps = past ? past.stamps : [targetTs];
    if (stamps.some((t) => approvalAnswers.has(t))) return void console.log("edit of an approval answer ignored");
    const waiting = pendingOf(conv, stamps) as Entry | undefined;
    if (!waiting && past && past.root.kind !== "owner" && past.root.kind !== "member" && past.root.kind !== "edit") return void console.log("edit of a message that is not someone's own ignored");
    if (!waiting && !past && !conv.direct) return void console.log("edit of an unknown message in a group ignored"); // nobody to check it against
    if (!isAuthor(m, waiting ? authorOf(waiting) : past?.root.by, conv.direct)) return void console.log(`edit by someone other than the author ignored (${conv.kind})`);
    const before = waiting ? w.say(m, waiting.line) : past?.latest.text; // (as the log has it)
    const line = w.say(m, m.text);
    if (before !== undefined && sameText(before, line)) return void console.log("edit changes nothing, ignored");
    if (waiting) {
      dropPending(conv, stamps);
      w.forget(conv, stamps, false);
    }
    const held: Held = { ...m, picture: waiting?.picture, document: waiting?.document, ...(waiting ? {} : { edit: { before } }) };
    return admit(conv, held, m.text, arrived, { of: targetTs });
  }

  // Is this message the answer to a question open in THIS conversation? Then it is consumed (and the conversation is told what happened). In a group ANY member's answer counts (their message, a
  // quoted reply or a reaction); the model reads it like the owner's.
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
    // An edited call runs without a second look; its result tells the run what changed (permissions.ts editedNote), and the run says it.
    return true;
  }

  // A reaction: the same steps as a message (vouch, approval answer, record, overtake), then the kind's own way to answer it (WAYS.react). A reaction to a message of the assistant's own
  // that corrects it (a 👎) is addressed to it (a group answers it without the participation gate); any other reaction, and one to someone else's message, is chatter that has to pass the gate.
  async function reaction(conv: Conversation, r: IncomingReaction): Promise<void> {
    const w = waysOf(conv);
    if (w.vouch && !(await deps.vouch(conv.groupId!))) return;
    const outcome = deps.approvals.answerReaction(r.emoji, r.targetTimestamp, conv.key, r.from || r.fromUuid); // a reaction on a question asked in this conversation
    if (outcome === "needs_text") return void (await out.reply(TYPED_YES_NEEDED, { plain: true, target: conv.target })); // a payment is not approved by a reaction
    if (outcome !== "ignored") return void console.log(`approval ${outcome} (by reaction)`);
    overtake(conv, false); // an emoji is news for the look but never calls it off
    const on = findMessage(r.targetTimestamp, conv.logFile)?.text ?? "an older message";
    const { line, said } = w.sayReaction(r, r.emoji, on);
    const t = now();
    record(conv, "reaction", t, line);
    const reacted = findMessage(r.targetTimestamp, conv.logFile);
    const ours = reacted ? !PEOPLE.has(reacted.kind) : r.targetAuthor === messenger.self; // (the log says who wrote it; failing that, the messenger does)
    const correction = ours && NEGATIVE.has(r.emoji.replace(/[\u{1F3FB}-\u{1F3FF}\uFE0F]/gu, ""));
    const journal = reacted && ours ? journalAround(conv.logFile, reacted.at) : undefined;
    const e: Entry = { from: r.from, fromUuid: r.fromUuid, fromName: r.fromName, text: "", timestamp: t, direct: r.direct, addressedToMe: correction, line, said, arrivedAt: t, reaction: { emoji: oneLine("reaction", r.emoji, 16), on, ...(journal ? { journal } : {}) } };
    return w.react(conv, r, e);
  }

  // A message deleted for everyone. Only its author can. Still waiting: it is dropped, so it is never answered and nothing in it is
  // acted on. Answered already: a marker line says so, nothing runs again. Nobody is told about it, in a group least of all.
  async function deletion(conv: Conversation, d: IncomingDeletion): Promise<void> {
    const w = waysOf(conv);
    if (w.vouch && !(await deps.vouch(conv.groupId!))) return;
    const past = revisionsOf(d.targetTimestamp, conv.logFile);
    const stamps = past ? past.stamps : [d.targetTimestamp];
    const waiting = pendingOf(conv, stamps);
    if (!waiting && !past) return void console.log("delete of an unknown message ignored");
    if (past?.deleted) return;
    if (!waiting && past && past.root.kind !== "owner" && past.root.kind !== "member" && past.root.kind !== "edit") return void console.log("delete of a message that is not someone's own ignored");
    if (!isAuthor(d, waiting ? authorOf(waiting) : past?.root.by, conv.direct)) return void console.log(`delete by someone other than the author ignored (${conv.kind})`);
    dropPending(conv, stamps);
    w.forget(conv, stamps, true); // (a group forgets a pending address of it and no longer judges it)
    console.log(`${conv.kind} message deleted by its author${waiting ? " before it was answered" : ""}`);
    record(conv, "delete", now(), w.say(d, `[${DELETED_LINE}]`), { of: d.targetTimestamp });
  }

  // What a restart lost, found in the log (replay.ts) and put through the chain again from step 6: the same burst, the same answer decision, the same turn. Not step 1 to 5: it is
  // recorded already, and neither a command nor an approval answer is ever replayed (an old "yes" is no new one). In a private chat the lines are one turn. In a group a line is answered only
  // when it addressed us (the log says so) or when the gate, asked again on the tail, says act. The caller has dropped what is too old or may have been done already.
  // `sorry`: the run may have acted before it died, so nothing is run again; it is said (once) to someone who was waiting, i.e. when a line was for us.
  async function replay(conv: Conversation, lines: readonly Sent[], sorry?: () => Promise<unknown>): Promise<void> {
    const w = waysOf(conv);
    if (w.vouch && !(await deps.vouch(conv.groupId!))) return;
    if (sorry) return void (lines.some((l) => w.forUs({ addressedToMe: !!l.addressed })) && (await sorry()));
    const t = now();
    const entries = lines
      .map((l): Entry => ({ from: l.by ?? "", text: l.text, timestamp: l.ts, direct: conv.direct, addressedToMe: !!l.addressed, line: l.text, said: l.text, author: l.by, arrivedAt: t, late: { at: l.at } }))
      .filter((e) => w.mayAnswer(e));
    for (const e of entries) w.note(conv, e);
    await Promise.all(entries.map((e) => settle(conv, w, e))); // (all joined into the burst first: the last one settles it)
  }

  // Everything that arrives for a conversation. The caller has already decided who may speak to it
  // (guards.ts for the owner's chat; our own echoes and reactions are dropped before this).
  function handleIncoming(conv: Conversation, ev: Incoming): Promise<void> {
    if (ev.type === "deletion") return deletion(conv, ev.d);
    return ev.type === "message" ? message(conv, ev.m) : reaction(conv, ev.r);
  }

  return { handleIncoming, replay };
}
