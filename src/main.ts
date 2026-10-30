import "./core/log.ts"; // first: timestamps, redaction and owner-only files for everything below
import "./core/agentstart.ts"; // second: a data folder in another layout stops the start before any module opens a file (core/requirelayout.ts)
import { createPipeline, group, owner, tenant, type Pipeline } from "./conversation/conversation.ts";
import type { PipelineDeps } from "./conversation/conversationmodel.ts";
import { replayUnanswered } from "./conversation/replay.ts";
import { dropTenantWarm, prepare, runConversation, runLook } from "./run/agent.ts";
import { chatTurn } from "./run/chattail.ts";
import { WARM_REFRESH_MS } from "./run/agentwarm.ts";
import { compactConversation, compactDue } from "./run/chatsession.ts";
import { approveIn } from "./approvals/permissions.ts";
import { scopeOf } from "./approvals/turnscope.ts";
import * as approvals from "./approvals/approvals.ts";
import { createApprovers } from "./approvals/approvers.ts";
import { acceptOwner } from "./conversation/guards.ts";
import { createDreamer, dreamConversations, dreamTrigger } from "./conversation/dream.ts";
import { groupName, sponsorInGroup, sponsorOfMember } from "./conversation/group.ts";
import { groupDir, loadSponsors, recordGroup } from "./conversation/groupstore.ts";
import { createWakeups, startupStagger } from "./heartbeat/wake.ts";
import { noteMacZone } from "./heartbeat/whereabouts.ts";
import { startHeartbeat, startJobs } from "./heartbeat/heartbeat.ts";
import { ensureNotesDir } from "./memory/notes.ts";
import { searchScope, warmSearchIndexes } from "./memory/search.ts";
import { compactIfNeeded, GROUP_LOG_MAX_BYTES, recordMessage, type Extra, type Kind } from "./core/messages.ts";
import { summarizeWithHaiku } from "./conversation/summarize.ts";
import { dropAll, mailRuntime, startAll, stopAll } from "./modules/runtime.ts";
import { preparePicture } from "./run/image.ts";
import { prepareFile, type AudioTools } from "./conversation/document.ts";
import { createOutbound } from "./conversation/outbound.ts";
import { Ledger } from "./modules/browse/payments.ts";
import { applyCredentialMode, mask, settings, signalIdentity } from "./core/settings.ts";
import { checkHideSettings } from "./modules/index.ts";
import { createVoiceLanguage } from "./conversation/lang.ts";
import { directOf, type IncomingMessage } from "@ted-assistant/messenger";
import { loadMessengerInUse } from "./conversation/messenger.ts";
import { providerReady, stopQwen, synthesizeWith, warmQwen } from "@ted-assistant/speech/tts";
import { Limiter } from "./core/limiter.ts";
import { activeTenant, admitStranger } from "./tenants/tenantroute.ts";
import { sweepStaleRuns } from "./modules/browse/browse.ts";
import { createTenantRunner } from "./conversation/tenantrun.ts";
import { wire } from "./heartbeat/wiring.ts";
import { createRegistrar } from "./approvals/registerask.ts";
import { welcomeStart } from "./core/welcome.ts";
import { ensureOwner, learnOwnerAci, REGISTRY_NOTICE, registryProblem, plainSummary, resolveSender, tenantByTarget, tenantContext } from "./tenants/tenants.ts";
import { probeAudio, transcribe, voiceReady } from "@ted-assistant/speech/voice";
import { DAMAGED_NOTICE, ledgerDamage } from "./core/instancedb.ts";
import { retentionTrigger, runRetention } from "./core/retention.ts";
import { registerFileRules } from "./heartbeat/retentionrules.ts";
import { instancePaths } from "./core/convpaths.ts";

applyCredentialMode();
checkHideSettings(); // a NOTION_TOOLS, MAILBIRD_TOOLS or GMAIL_TOOLS typo stops the start with a message naming the setting
ensureNotesDir(); // first run: conversations/owner/notes/, where the chat agent keeps its notes
sweepStaleRuns(); // page views and screenshots of a browse run that never ended
if (!ledgerDamage() && new Ledger().recover()) console.log("card: a payment that was clicked and never reported back is now unconfirmed (npm run card -- payments)"); // a crash between the click and the result

// The owner's record in the registry (tenants.ts): made on the first start from SIGNAL_OWNER_NUMBER, its account id learned from her first message.
const identity = signalIdentity();
const ownerRecord = ensureOwner({ number: identity.ownerNumber, aci: identity.ownerAci });
// The chat platform (MESSENGER, default signal): everything below talks to this interface (packages/messenger) and knows no platform call.
const messenger = await loadMessengerInUse({ owner: { address: identity.ownerNumber, id: identity.ownerAci ?? ownerRecord.acis[0] }, account: identity.account });
// What was said goes into that conversation's own log: the owner's chat, or the group's (made on first use).
function record(target: string | undefined, kind: Kind, ts: number, text: string, extra?: Extra) {
  // A tenant's own history (tenants.ts), in her folder, bounded by size and never summarised by a model (that call would run on the instance's login).
  if (directOf(target)) {
    const rec = tenantByTarget(target); // a stranger's fixed reply, or a tenant deleted meanwhile, is logged nowhere
    if (!rec) return;
    const { logFile } = tenantContext(rec);
    recordMessage(kind, ts, text, new Date(), logFile, extra);
    return void compactIfNeeded(plainSummary, GROUP_LOG_MAX_BYTES, logFile).catch((e) => console.error("tenant log: compaction failed:", e.message));
  }
  const groupId = target;
  if (groupId) return void (groupDir(groupId, groupName(groupId)), recordGroup(groupId, kind, ts, text, extra));
  recordMessage(kind, ts, text, new Date(), undefined, extra);
  void compactIfNeeded(summarizeWithHaiku).catch((e) => console.error("messages: compaction failed:", e.message));
}
const out = createOutbound(messenger, (kind, ts, text, target) => record(target, kind, ts, text));
// Every question is asked in the conversation that triggered the action (approvers.ts): the owner's chat for her own turns and her unattended
// runs (the heartbeat run: only an explicit yes / no or a reply to the question answers those, whatever else she types meanwhile is a chat message), a group in the group
// (any member may answer), a tenant in her own chat. approvals.ts scopes every question to its conversation, so an answer from another one (the admin's included) never applies.
// This is the one place the modules' hooks are set (wiring.ts; it stops the start if one is missing): those modules are used by runs that have no pipeline in reach.
wire({
  approvers: createApprovers(out),
  sendFirst: messenger.sendFirst?.bind(messenger), // the owner's hello to a number or username (tenanttools.ts invite_person; undefined where the platform has none)
  dropTenant: (id) => (dropTenantWarm(id), dropAll(id)), // a suspended or removed tenant: her warm process and every connection of hers (modules/runtime.ts RUNTIME lifecycles: her Google server, her Notion) stop
});
// `say` is a plain message to the owner (start-up problems; what the assistant says on its own goes through the pipeline as a "notice", which the chat remembers: messages.ts).
const say = async (text: string) => void (await out.replyPlain(text, "notice"));

// Every voice message is transcribed (in a group it may be meant for the assistant), but only a few at a time: a flood waits in line
// instead of starting that many whisper processes. One line for the owner's chat and every group.
const transcribing = new Limiter(() => 2) // voice notes transcribed at the same time; the rest wait their turn;

// A voice message's words, from the local speech model; the transcript goes into the message log like any message (a
// mishearing can be searched there). Throws a sentence the user can be told if it cannot be made out.
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

// Group chats (src/conversation/group.ts): in any group the owner is a member of. Everything said or reacted there goes
// into that group's own history; the brain decides when the assistant speaks. No access to anything private.
const isOwnerAccount = (who: { number?: string; uuid?: string }) => resolveSender({ number: who.number, aci: who.uuid })?.role === "admin";
const fromOwner = (w: { from: string; fromUuid?: string }) => isOwnerAccount({ number: w.from || undefined, uuid: w.fromUuid });
const vouch = (groupId: string) => sponsorInGroup(groupId, () => messenger.groups(), sponsorOfMember); // is this group's sponsor in it?
loadSponsors(); // (groups that friends sponsor are known as theirs from the first event)

// Both kinds of conversation run through one pipeline (src/conversation/conversation.ts). Spoken replies need the
// assistant's own chat (in Note to Self our own voice message would echo back as if the owner had sent
// it) and the local speech setup.
// Several people on one instance (TENANTS=on, src/tenants/tenants.ts): each friend is a tenant with her own folder, API key (OpenBao), limits and cooldown.
// Needs a messenger other people can write to: with Signal that is the assistant's own account (in Note to Self there is nobody else to talk to).
if (settings.tenants && !messenger.capabilities.people) throw new Error("TENANTS=on needs the assistant's own account (with Signal: SIGNAL_ACCOUNT, docs/SIGNAL-ACCOUNT.md)");
const tenantRunner = createTenantRunner({});
// One turn of a private chat. A tenant's goes through her gates first (tenantrun.ts, which ends in the same runConversation); the owner's tells the approvals what she wrote.
const runChat: PipelineDeps["run"] = (conv, prompt, ownerMessage, pictures, hooks, documents, reactedTo, reactedAt, arrivedAt) => {
  const turn = scopeOf(conv.key); // what the approval judge is told led to this turn (turnscope.ts); a reaction's reacted-to text is what the assistant said, not their message
  turn.say(ownerMessage, reactedTo, reactedAt, arrivedAt);
  return (conv.tenantId ? tenantRunner.run(conv, prompt, pictures, hooks, documents) : runConversation(conv, {}, chatTurn(conv, { prompt, pictures, documents }), hooks?.firstOutput)).finally(() => turn.end());
};
const pipeline: Pipeline = createPipeline({
  messenger,
  out,
  record,
  run: runChat,
  picture: async (m) => preparePicture(await messenger.attachmentFile(m.image!)), // the messenger resolves the id to its own file (Signal: a plain file name inside signal-cli's folder)
  document: async (m) => prepareFile(await messenger.attachmentFile(m.file!), m.file!.name, audioTools), // the same; an audio file is transcribed (queued with voice messages)
  longText: (m) => messenger.readLongText(m.longText!), // the same
  transcript,
  speech: {
    ready: () => settings.voiceReplies && messenger.capabilities.voice && providerReady(settings.tts).ok,
    synth: (words, conversation, limits) => synthesizeWith(words, settings.tts, console, conversation, messenger.capabilities.voiceFormat, limits), // the conversation picks its cloned voice (voicetool.ts); the messenger picks the audio format
    foreign: createVoiceLanguage(settings.ttsLanguages), // the language the voice does not speak, if any; a failed check falls back to the conversation's last known language
  },
  approvals,
  vouch,
  isOwner: fromOwner,
  compact: compactConversation, // every conversation, after the reply is out and only when it grew far past the limit (urgent); the next message waits for it
  // After each turn the conversation's next process is started, whoever it is (agent.ts prepare: the kind's room, the payer); a group is also warmed on arrival (group.ts).
  afterTurn: (conv) => prepare(conv),
});

// The linked device sees ALL of the owner's Signal traffic. Only their own Note to Self is
// ever acted on; everything else is dropped here, before it can reach anything else.
// A group's event goes to the group; anything else must be the owner's own chat (the caller has checked).
const route = (w: { group?: { id: string } }, ev: Parameters<Pipeline["handleIncoming"]>[1]) =>
  void pipeline.handleIncoming(w.group ? group(w.group.id) : owner(), ev).catch((e) => console.error(`${ev.type} error:`, e.message));
// With TENANTS=on a private message from someone else is decided by tenantroute.ts: a tenant's goes to her conversation, anybody else gets ONE fixed line
// with no model call and the owner is asked in her own chat whether she may join (registerask.ts); what the stranger wrote is held, shown to nobody and
// replayed as her first turn after the owner's yes. Off: ignored, exactly as before.
const deliverToTenant = (id: string, m: IncomingMessage) => void pipeline.handleIncoming(tenant(id), { type: "message", m }).catch((e) => console.error("tenant message error:", e.message));
const registrar = createRegistrar({
  send: (text) => out.reply(text, { plain: true, kind: "approval" }),
  // The owner said yes: what she wrote while she waited is her first turn, through the usual tenant path (her gates, the instance key, her persona).
  joined: (t, held, r) => held.forEach((h) => deliverToTenant(t.id, { from: r.number ?? "", fromUuid: r.aci, fromName: r.name, text: h.text, timestamp: h.timestamp, direct: false, other: true })),
});
function fromStranger(m: IncomingMessage): void {
  const decided = admitStranger({ fromUuid: m.fromUuid, name: m.fromName, number: m.from || undefined, text: m.text, timestamp: m.timestamp }, {
    reply: (to, text) => out.reply(text, { plain: true, kind: "other", target: to }),
    deliver: (t) => deliverToTenant(t.id, m),
    requested: (r) => registrar.ask(r),
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

// The mail provider's own start-up (its module, src/modules): Mailbird's connection (the approval of any send shows the draft read back from it), or the Gmail connector's read-backs for the same approval.
// MAIL_PROVIDER=none: no mail client is made at all, so there is no proposer either.
if (settings.mail) mailRuntime()?.start();

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
console.log(`connected to ${messenger.name} (${messenger.summary}); accepting only ${mask(identity.ownerNumber)}; auth: ${settings.credential}`);

prepare(owner()); // (start-up: the owner's chat is the one conversation that is certainly there)
if (ledgerDamage()) void say(DAMAGED_NOTICE).catch(() => {}); // degraded mode (core/instancedb.ts): told once per start
if (registryProblem() !== undefined) void say(REGISTRY_NOTICE).catch(() => {}); // the owner is served, the friends are paused (tenants.ts)
welcomeStart(); // a fresh data folder is marked once: its first run (chat turn or look) is told to introduce itself (core/welcome.ts)
replayUnanswered({ pipeline, tell: (conv, text) => out.reply(text, { plain: true, kind: "other", target: conv.target }) }); // what anyone (the owner, a friend, a group) wrote just before the last stop and never got an answer to (replay.ts)
if (settings.tenants) registrar.askOpen(); // requests still open from before this start are put to the owner again
// The cloned voice takes a few seconds to load: have it ready for the first spoken reply (it is stopped again after WARM_IDLE_MINUTES (settings.ts) idle, and the next reply restarts it).
if (settings.tts.provider === "qwen" && settings.warm && settings.voiceReplies && providerReady(settings.tts).ok) void warmQwen(settings.tts.qwen).then((err) => console.log(err ? `Qwen voice not warmed up (Kokoro stands in): ${err}` : "Qwen voice server ready"));
// A warm process is used only while fresh (agent.ts); keep one ready so a message after a
// quiet hour is still quick. Local work only, no model call.
setInterval(() => dreamConversations().forEach((conv) => prepare(conv, { refresh: true })), WARM_REFRESH_MS).unref(); // (every conversation that holds a process: it renews only those)
// Every conversation's search index (memory/search.ts: the owner's, the groups', the friends'; each stays in its own folder) is brought up to date a little after start-up, one after another in small slices that leave the event loop free, so the first real search_logs is quick.
setTimeout(() => void warmSearchIndexes(dreamConversations().map((c) => searchScope(c.convId))).catch(() => {}), 20_000).unref();

// One dreamer (dream.ts) for every conversation, one after another: the owner, the groups, the friends (one failing never keeps another from being dreamt). Each conversation is dreamt at most once a day, only when it said something new.
const dreamer = createDreamer({ busy: (conv) => pipeline.busy(conv) });
const dream = () => dreamer.run().catch(() => {});
const dreamAtItsHour = dreamTrigger(dream);
// The retention job (core/retention.ts): once a day from 03:30 it removes what has outlived its window (rotated audit lines, old signal-cli attachments, expired notes, old snapshots and logs...).
// Plain file work, no model; it waits for the next tick while the owner's chat is in a turn. RETENTION=off disables it.
registerFileRules();
const retentionAtItsHour = retentionTrigger((now) => runRetention(now, { stateFile: instancePaths().retention }), { stateFile: instancePaths().retention, enabled: () => settings.retention, busy: () => pipeline.busy(owner()) });
// The clock of every conversation's own initiative: every tick, each conversation whose next look has come may be woken (wake.ts). The look is the heartbeat run
// (heartbeat/look.ts; the daily brief is a skill it delegates), the same for the owner, every group and every friend, each with its own approver: a question goes to the chat that triggered it.
const wakeups = createWakeups({
  pipeline,
  groupChats: messenger.capabilities.groups,
  stagger: startupStagger,
  vouch,
  run: (conv, payer, build, extra) => runLook(conv, payer, build, approveIn(conv.key, { background: true }), extra),
  compact: { due: (conv) => compactDue(conv.convId), run: (conv) => compactConversation(conv, "quiet") },
});

// Independent jobs: each starts on every tick in its own try/catch and none waits for another (startJobs, heartbeat.ts; the
// dream is started by its own job, below).
startHeartbeat({
  onSleep: () => void wakeups.slept(),
  onTick: () => {
    startJobs({
      wake: () => wakeups.tick(),
      whereabouts: () => noteMacZone(), // the Mac's zone history (heartbeat/whereabouts.ts)
      retention: () => retentionAtItsHour(), // the first tick at or after 03:30, once a day, never while a chat turn runs (core/retention.ts)
      dream: () => dreamAtItsHour(), // the first tick at or after the preset's dream hour; each conversation is dreamt at most once a day, and only when it said something new (dream.ts)
    });
  },
});
