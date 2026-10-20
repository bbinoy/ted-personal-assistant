import "./log.ts"; // first: timestamps, redaction and owner-only files for everything below
import { createPipeline, group, owner, tenant, type Pipeline } from "./conversation.ts";
import { dropTenantWarm, prepare, runConversation, runProfile } from "./agent.ts";
import { compactConversation, compactDue } from "./chatsession.ts";
import { approveIn, setApprovers } from "./permissions.ts";
import { scopeOf } from "./turnscope.ts";
import * as approvals from "./approvals.ts";
import { createApprovers } from "./approvers.ts";
import { config, mask } from "./config.ts";
import { acceptOwner } from "./guards.ts";
import { createDreamer } from "./dream.ts";
import { createGroupBrain, groupName, ownerInGroup } from "./group.ts";
import { createGroupDreamer } from "./groupdream.ts";
import { createTenantDreamer } from "./tenantdream.ts";
import { createTenantMailLoops } from "./mailloops.ts";
import { keyNotices } from "./keynotice.ts";
import { groupDir, recordGroup } from "./groupstore.ts";
import { logTail } from "./gate.ts";
import { createWakeups } from "./wake.ts";
import { createHandler } from "./handler.ts";
import { startHeartbeat, startJobs } from "./heartbeat.ts";
import { writeNotice } from "./notice.ts";
import { ensureNotesDir } from "./notes.ts";
import { compactIfNeeded, recordMessage, type Extra, type Kind } from "./messages.ts";
import { summarizeWithHaiku } from "./summarize.ts";
import { dropAll, mailRuntime, startAll, stopAll } from "./modules/runtime.ts";
import { preparePicture } from "./image.ts";
import { prepareFile, type AudioTools } from "./document.ts";
import { createOutbound } from "./outbound.ts";
import { Ledger } from "./payments.ts";
import { OWNER_KEY } from "./send.ts";
import { settings } from "./settings.ts";
import { unsupportedForVoice } from "./lang.ts";
import { directOf, type IncomingMessage } from "@ted-personal-assistant/messenger";
import { loadMessengerInUse } from "./messenger.ts";
import { providerReady, stopQwen, synthesizeWith, warmQwen } from "@ted-personal-assistant/signal/tts";
import { Limiter } from "./limiter.ts";
import { activeTenant, admitStranger } from "./tenantroute.ts";
import { sweepStaleRuns } from "./browse.ts";
import { createTenantRunner } from "./tenantrun.ts";
import { tenantHooks } from "./tenanttools.ts";
import { ensureOwner, learnOwnerAci, markDisclosed, plainSummary, resolveSender, targetOf, tenantByTarget, tenantContext } from "./tenants.ts";
import { probeAudio, transcribe, voiceReady } from "@ted-personal-assistant/signal/voice";

ensureNotesDir(); // first run: memory/notes/, where the chat agent keeps its notes
sweepStaleRuns(); // page views and screenshots of a browse run that never ended
if (new Ledger().recover()) console.log("card: a payment that was clicked and never reported back is now unconfirmed (npm run card -- payments)"); // a crash between the click and the result

// The owner's record in the registry (tenants.ts): made on the first start from SIGNAL_OWNER_NUMBER, its account id learned from her first message.
const ownerRecord = ensureOwner({ number: config.ownerNumber, aci: config.ownerAci });
// The chat platform (MESSENGER, default signal): everything below talks to this interface (packages/messenger) and knows no platform call.
const messenger = await loadMessengerInUse({ owner: { address: config.ownerNumber, id: config.ownerAci ?? ownerRecord.acis[0] }, account: config.signalAccount });
// What was said goes into that conversation's own log: the owner's chat, or the group's (made on first use).
function record(target: string | undefined, kind: Kind, ts: number, text: string, extra?: Extra) {
  // A tenant's own history (tenants.ts), in her folder, bounded by size and never summarised by a model (that call would run on the instance's login).
  if (directOf(target)) {
    const rec = tenantByTarget(target); // a stranger's fixed reply, or a tenant deleted meanwhile, is logged nowhere
    if (!rec) return;
    const { logFile } = tenantContext(rec);
    recordMessage(kind, ts, text, new Date(), logFile, extra);
    return void compactIfNeeded(plainSummary, settings.groupLogMb * 1_000_000, logFile).catch((e) => console.error("tenant log: compaction failed:", e.message));
  }
  const groupId = target;
  if (groupId) return void (groupDir(groupId, groupName(groupId)), recordGroup(groupId, kind, ts, text, extra));
  recordMessage(kind, ts, text, new Date(), undefined, extra);
  void compactIfNeeded(summarizeWithHaiku).catch((e) => console.error("messages: compaction failed:", e.message));
}
const out = createOutbound(messenger, (kind, ts, text, target) => record(target, kind, ts, text));
// Every question is asked in the conversation that triggered the action (approvers.ts): the owner's chat for her own turns and her unattended
// runs (wake-ups, the brief, the radar, the mail handler: only an explicit yes / no or a reply to the question answers those, whatever else
// she types meanwhile is a chat message), a group in the group (any member may answer), a tenant in her own chat. approvals.ts scopes every
// question to its conversation, so an answer from another one (the admin's included) never applies.
setApprovers(createApprovers(out));
const approveBackground = approveIn(OWNER_KEY, { background: true });
// `say` is a plain message to the owner. `notify` is what the assistant sends on its own (mail
// alerts, handled mail, setup problems) and is also remembered, so the chat knows what a reply
// like "yes, do that" refers to (messages.ts). Memory announcements and chat answers use `say`.
const say = async (text: string) => void (await out.replyPlain(text, "notice"));
const warmChat = () => prepare(owner(), { notify: say });
const notify = async (text: string) => {
  await say(text);
  prepare(owner(), { notify: say }, { refresh: true }); // the chat prompt carries recent pings, so the warm process is stale now (a renewal, not activity)
};

// Every voice message is transcribed (in a group it may be meant for the assistant), but only a few at a time: a flood waits in line
// instead of starting that many whisper processes. One line for the owner's chat and every group.
const transcribing = new Limiter(() => settings.transcribeConcurrency);

// A voice message's words, from the local speech model; the transcript is logged (logs/voice.jsonl) to inspect a
// mishearing. Throws a sentence the user can be told if it cannot be made out.
async function transcript(m: IncomingMessage): Promise<string> {
  let heard = "";
  try {
    heard = await transcribing.run(async () => transcribe(await messenger.attachmentFile(m.audio!), settings.whisperModel));
  } catch (e) {
    const gaps = voiceReady(settings.whisperModel);
    console.error("voice: transcription failed:", (e as Error).message);
    throw new Error(gaps.ok ? "I couldn't make out that voice message. Try again or type it." : `I can't transcribe voice messages yet: missing ${gaps.missing.join(", ")}.`);
  }
  console.log(`voice: transcribed (${heard.length} chars)`);
  if (!heard) throw new Error("I couldn't hear any words in that voice message.");
  return heard;
}

// An audio file somebody sent: what it really is (ffprobe) and its first minutes in words, in the same queue as voice messages.
const audioTools: AudioTools = {
  probe: probeAudio,
  transcribe: (file, maxSeconds) => transcribing.run(() => transcribe(file, settings.whisperModel, maxSeconds)),
};

// Group chats (src/group.ts): in any group the owner is a member of. Everything said or reacted there goes
// into that group's own history; the brain decides when the assistant speaks. No access to anything private.
const isOwnerAccount = (who: { number?: string; uuid?: string }) => resolveSender({ number: who.number, aci: who.uuid })?.role === "admin";
const fromOwner = (w: { from: string; fromUuid?: string }) => isOwnerAccount({ number: w.from || undefined, uuid: w.fromUuid });
const vouch = (groupId: string) => ownerInGroup(groupId, () => messenger.groups(), isOwnerAccount); // is the owner in this group?

// Both kinds of conversation run through one pipeline (src/conversation.ts). Spoken replies need the
// assistant's own chat (in Note to Self our own voice message would echo back as if the owner had sent
// it) and the local speech setup.
// Several people on one instance (TENANTS=on, src/tenants.ts): each friend is a tenant with her own folder, API key (OpenBao), limits and cooldown.
// Needs a messenger other people can write to: with Signal that is the assistant's own account (in Note to Self there is nobody else to talk to).
if (settings.tenants && !messenger.capabilities.people) throw new Error("TENANTS=on needs the assistant's own account (with Signal: SIGNAL_ACCOUNT, docs/SIGNAL-ACCOUNT.md)");
keyNotices.sendTo((text) => void out.replyPlain(text, "notice")); // the one notice for the owner about the shared instance key (keynotice.ts), from every kind of run
const tenantRunner = createTenantRunner({});
tenantHooks.drop = (id) => (dropTenantWarm(id), dropAll(id)); // a suspended or removed tenant: her warm process and every connection of hers (modules/runtime.ts LIFECYCLE: her Google server, her Notion) stop
const pipeline: Pipeline = createPipeline({
  messenger,
  out,
  record,
  // One turn of a private chat. A tenant's goes through her gates first (tenantrun.ts, which ends in the same runConversation); the owner's tells the approvals what she wrote.
  run: (conv, prompt, ownerMessage, pictures, hooks, documents, reactedTo) => {
    const turn = scopeOf(conv.key); // what the approval judge is told led to this turn (turnscope.ts); a reaction's reacted-to text is what the assistant said, not their message
    turn.say(ownerMessage, reactedTo);
    return (conv.tenantId ? tenantRunner.run(conv, prompt, pictures, hooks, documents) : runConversation(conv, { notify: say }, () => ({ prompt, pictures, documents }), hooks?.firstOutput)).finally(() => turn.end());
  },
  picture: async (m) => preparePicture(await messenger.attachmentFile(m.image!)), // the messenger resolves the id to its own file (Signal: a plain file name inside signal-cli's folder)
  document: async (m) => prepareFile(await messenger.attachmentFile(m.file!), m.file!.name, audioTools), // the same; an audio file is transcribed (queued with voice messages)
  longText: (m) => messenger.readLongText(m.longText!), // the same
  transcript,
  speech: {
    ready: () => settings.voiceReplies && messenger.capabilities.voice && providerReady(settings.tts).ok,
    synth: (words, conversation) => synthesizeWith(words, settings.tts, console, conversation, messenger.capabilities.voiceFormat), // the conversation picks its cloned voice (voicetool.ts); the messenger picks the audio format
    foreign: (words) => unsupportedForVoice(words, settings.ttsLanguages),
  },
  approvals,
  vouch,
  isOwner: fromOwner,
  admitGroup: (_conv, m) => groupBrain(m),
  compact: compactConversation, // every conversation, after the reply is out and only when it grew far past the limit (urgent); the next message waits for it
  // The owner's chat is kept warm after each turn; the group that spoke last has its own warm process (group.ts).
  afterTurn: (conv) => void (conv.kind === "owner" ? warmChat() : conv.kind === "tenant" && tenantRunner.warm(conv)),
});
const groupBrain = createGroupBrain({ pipeline, recent: (groupId) => logTail(group(groupId)) });

// The linked device sees ALL of the owner's Signal traffic. Only their own Note to Self is
// ever acted on; everything else is dropped here, before it can reach anything else.
// A group's event goes to the group; anything else must be the owner's own chat (the caller has checked).
const route = (w: { group?: { id: string } }, ev: Parameters<Pipeline["handleIncoming"]>[1]) =>
  void pipeline.handleIncoming(w.group ? group(w.group.id) : owner(), ev).catch((e) => console.error(`${ev.type} error:`, e.message));
// With TENANTS=on a private message from someone else is decided by tenantroute.ts: a tenant's goes to her conversation, anybody else gets a fixed
// reply with no model call (an invitation, a welcome); the assistant answers only what was written to it. Off: ignored, exactly as before.
function fromStranger(m: IncomingMessage): void {
  const decided = admitStranger({ fromUuid: m.fromUuid, name: m.fromName, text: m.text }, {
    reply: (to, text) => out.reply(text, { plain: true, kind: "other", target: to }),
    deliver: (t) => void pipeline.handleIncoming(tenant(t.id), { type: "message", m }).catch((e) => console.error("tenant message error:", e.message)),
    welcomed: (t) => markDisclosed(tenantContext(t)),
  });
  if (decided.kind === "ignore") console.log(`ignored a message from someone else (${decided.why})`);
}
messenger.onMessage((m) => {
  if (!m.group) {
    if (!acceptOwner(m, resolveSender)) {
      if (settings.tenants && m.other) return fromStranger(m);
      return void console.log(`ignored a message from ${mask(m.from)}`);
    }
    learnOwnerAci({ number: m.from, aci: m.fromUuid }); // the first message from her number carries her account id: the pair is recorded once
    if (!m.edited && out.isOwnEcho(m)) return; // one of our own replies coming back (an edit is the owner's, never an echo)
  }
  route(m, { type: "message", m });
});

// A message deleted for everyone: the same door as a message.
messenger.onDeletion((d) => {
  if (d.group || acceptOwner(d, resolveSender)) route(d, { type: "deletion", d });
  else if (settings.tenants && d.other && activeTenant(d.fromUuid)) void pipeline.handleIncoming(tenant(activeTenant(d.fromUuid)!.id), { type: "deletion", d }).catch((e) => console.error("tenant deletion error:", e.message));
});

// The mail provider's own start-up (its module, src/modules): Mailbird's connection for reply drafts (the handler's drafts are shown on Signal, propose.ts,
// and the approval of any send shows the draft read back from it), or the Gmail connector's read-backs for the same approval.
// MAIL_PROVIDER=none: no mail client is made at all, so there is no proposer and no mail handler either.
const mail = settings.mail ? mailRuntime()?.start({ reply: (t) => out.replyPlain(t, "draft") }) : undefined;

// A 👍 / 👎 on the pending approval message answers it (the pipeline checks); any other reaction of the
// owner is feedback. (Our own status icons come back as reactions; the messenger does not deliver those.)
messenger.onReaction((r) => {
  if (r.isRemove) return;
  if (r.group || acceptOwner(r, resolveSender)) route(r, { type: "reaction", r });
  else if (settings.tenants && r.other && activeTenant(r.fromUuid)) void pipeline.handleIncoming(tenant(activeTenant(r.fromUuid)!.id), { type: "reaction", r }).catch((e) => console.error("tenant reaction error:", e.message));
});

// Policy of this app, not of the messenger: if the platform goes away we exit, and launchd restarts the whole agent
// cleanly instead of leaving a process with no connection. A signal we are asked to stop on takes the platform's helper (Signal's daemon) down too.
messenger.onClose(({ reason }) => {
  console.error(`${reason}; exiting so launchd restarts us`);
  process.exit(1);
});
// The friends' server processes and the private folders that hold their tokens go with the application, whichever way it ends (exit also runs for the exit above).
startAll();
process.once("exit", () => (stopAll(), messenger.stop()));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => (stopAll(), messenger.stop(), stopQwen(), process.exit(0)));
await messenger.start();
console.log(`connected to ${messenger.name} (${messenger.summary}); accepting only ${mask(config.ownerNumber)}; auth: ${config.credential}`);

warmChat();
// The cloned voice takes a few seconds to load: have it ready for the first spoken reply (it is stopped again after WARM_IDLE_MINUTES idle, and the next reply restarts it).
if (settings.tts.provider === "qwen" && settings.warm && settings.voiceReplies && providerReady(settings.tts).ok) void warmQwen(settings.tts.qwen).then((err) => console.log(err ? `Qwen voice not warmed up (Kokoro stands in): ${err}` : "Qwen voice server ready"));
// A warm process is used only while fresh (agent.ts); keep one ready so a message after a
// quiet hour is still quick. Local work only, no model call.
setInterval(() => prepare(owner(), { notify: say }, { refresh: true }), settings.warmRefreshMinutes * 60_000).unref();

const handler = mail?.propose ? createHandler({ approve: approveBackground, notify, write: writeNotice, propose: mail.propose }) : undefined;
handler?.resume();

const dreamer = createDreamer();
const groupDreamer = createGroupDreamer();
const tenantDreamer = createTenantDreamer();
// The dream tidies the notes the brief then reads; it runs at most once a day, only when you said something new, and a
// failure just moves on. The tenants' dreams start with it but are not waited for: the brief never waits for them, and each is its own.
const dream = () => {
  void tenantDreamer.run().catch(() => {});
  return dreamer.run().then(() => groupDreamer.run()).catch(() => {});
};
// The clock half of the gate: every tick, each conversation whose next look has come may be woken (wake.ts). The owner's
// gate also decides when the brief and the radar run, with a deterministic backstop for the brief.
const wakeups = createWakeups({
  pipeline,
  groupChats: messenger.capabilities.groups,
  vouch,
  runProfile: (profile, prompt, extra) => runProfile(profile, prompt, approveBackground, extra),
  presets: { sendBrief: out.sendBriefSummary, notify: say, beforeBrief: dream },
  compact: { due: (conv) => compactDue(conv.sessionFile), run: (conv) => compactConversation(conv, "quiet") },
});

// The friends' mail (TENANTS=on, the `google` and `mail` capabilities, a connected account): the heartbeat's own mail check and handler, once per friend, in her folder and her chat.
const tenantMail = createTenantMailLoops({
  notify: async (id, text) => {
    const to = targetOf(id);
    if (to) await out.reply(text, { plain: true, kind: "notice", target: to });
  },
});

// Independent jobs: each starts on every tick in its own try/catch and none waits for another (startJobs, heartbeat.ts; the
// dream runs inside the brief preset, before the brief).
startHeartbeat({
  alert: notify,
  write: writeNotice,
  handle: (items) => handler?.enqueue(items),
  briefDue: () => wakeups.briefPending(),
  onTick: () => {
    startJobs({
      wake: () => wakeups.tick(),
      tenantMail: () => tenantMail.tick(), // each friend's own mail check, triage and handler (mailloops.ts): the same code as the owner's, with her Google
    });
  },
});
