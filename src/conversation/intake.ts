import { allows } from "../policy/capabilities.ts";
import { cleanIncoming, type Conversation, type Held, type Incoming, type PipelineDeps } from "./conversationmodel.ts";
import { findMessage, revisionsOf, type Extra, type Kind } from "../core/messages.ts";
import { editNote, DELETED_LINE, isAuthor, sameText } from "./edit.ts";
import { MAX_PICTURES, PICTURE_NOTE, type Picture } from "../run/image.ts";
import { documentNote, takeDocuments, type Document } from "./document.ts";
import { withQuoteContext } from "./quote.ts";
import { holdQuote, holdVoiceNote, rememberSender } from "../modules/voice/voicenote.ts";
import { cardCommand } from "../modules/browse/card.ts";
import { commandReply } from "./ownercommands.ts";
import { TYPED_YES_NEEDED } from "../modules/browse/paymentrules.ts";
import { reactionMessage, reactionPrompt } from "../core/reaction.ts";
import { scopeOf } from "../approvals/turnscope.ts";
import { taskReply } from "./taskreplies.ts";
import { forgetDeclined } from "../approvals/declined.ts";
import { voiceOption } from "./voicereply.ts";
import { settings } from "../core/settings.ts";
import { clean, LIMITS, oneLine } from "../core/sanitize.ts";
import { MAX_LONG_TEXT_BYTES, type IncomingDeletion, type IncomingMessage, type IncomingReaction } from "@ted-assistant/messenger";
import type { Queue } from "./queue.ts";
import type { Delivery } from "./delivery.ts";

// Everything that arrives for a conversation, up to the moment its turn is handed to the queue: edits, deletes, reactions, owner commands, approval answers, and the steps a message
// goes through first (voice, picture, file, long text). This module owns the record of messages taken as approval answers.
export function createIntake(deps: PipelineDeps, queue: Queue, delivery: Delivery) {
  const { messenger, out } = deps;
  const caps = messenger.capabilities;
  const now = deps.now ?? Date.now;
  const { burst, enqueue, overtake, pendingOf, authorOf, dropPending } = queue;
  const { reactTo, status, canSpeak, holdTyping, runTurn } = delivery;

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
    rememberSender(conv.key, author, original.fromName && oneLine("sender name", original.fromName, 40)); // (memory only, whatever the voice provider: the voice tool and the task tools both name who is asking)
    if (settings.tts.provider === "qwen") {
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
      if (await taskReply(conv, m, (t) => out.reply(t, { plain: true, target: conv.target }))) return; // /tasks in a group, an answer to the learned list (taskreplies.ts)
      if (await approvalAnswer(conv, m, author)) return;
      forgetDeclined(conv.key);
      if (m.addressedToMe) overtake(conv); // (a group's other talk is not a chat turn: the look goes on, and its post is judged against the log)
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
    // /stop, /pause, /resume, /status: also in code, before any model and ahead of the queue, so "stop" works while a turn runs (ownercommands.ts).
    if (!edited && !m.picture && !m.document) {
      const said = commandReply(conv, m.text, { dropQueued: () => queue.dropAllPending(conv) });
      if (said !== undefined) return void (await out.reply(said, { plain: true, target: conv.target }));
    }
    // While an approval is pending, a message may be its answer. That must skip the queue.
    scopeOf(conv.key).wrote(now()); // (an answer to a question is something written too: a reaction on an older message answers nothing newer)
    if (!edited && (await taskReply(conv, m, (t) => out.reply(t, { plain: true, target: conv.target })))) return; // an answer to the learned list (taskreplies.ts)
    if (!edited && (await approvalAnswer(conv, m, m.from || m.fromUuid))) return;
    if (!edited && (await deps.feedback?.message(conv, m))) return void console.log("feedback: a quoted reply to something sent unprompted was handled (an offer, or the answer to one)"); // learning from feedback (feedback.ts); only a short quoted reply, and a group never gets here
    forgetDeclined(conv.key); // a new message: they may be asking for a declined action again (declined.ts)
    overtake(conv); // a look of this conversation that is running gives way to the turn
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
            run: (hooks) => deps.run(conv, prompt, ms.map((x) => x.text).join("\n"), ms.flatMap((x) => x.picture ?? []).slice(-MAX_PICTURES), hooks, takeDocuments(ms.map((x) => x.document)), undefined, undefined, ms[0]!.timestamp),
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
    overtake(conv, false); // an emoji is news for the look but never calls it off
    await enqueue(conv, async () => {
      console.log(`owner reacted ${r.emoji}`);
      const on = findMessage(r.targetTimestamp, conv.logFile);
      record(conv, "reaction", now(), `${r.emoji} on: ${(on?.text ?? "an older message").slice(0, LIMITS.preview)}`);
      if (await deps.feedback?.reaction(conv, r)) return void console.log("feedback: a reaction was handled (an offer, or the answer to one)"); // a 👎 on something sent unprompted, or the 👍 / 👎 on an offer: no chat turn (feedback.ts)
      const prompt = reactionPrompt(r.emoji, on);
      // The judge is told "<owner> reacted <emoji>" as the owner's message and the reacted-to text as what the assistant said (it may quote mail): never as their words.
      await runTurn(conv, { run: () => deps.run(conv, prompt, reactionMessage(oneLine("reaction", r.emoji, 16)), undefined, undefined, undefined, on?.text, on ? Date.parse(on.at) || 0 : 0), target: { author: r.targetAuthor ?? messenger.self, timestamp: r.targetTimestamp }, reaction: true, announce: false });
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

  return { handleIncoming };
}
