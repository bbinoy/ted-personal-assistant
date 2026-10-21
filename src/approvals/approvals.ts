import { discardJudge, prepareJudge } from "./approvaljudge.ts";
import { applyChanges, isModifiable, type Change } from "../policy/policy.ts";
import { settings } from "../core/settings.ts";
import { audit, wordless, type Source } from "../core/audit.ts";
import { isTenantKey } from "../core/ownerkey.ts";
import { judgeAnswer } from "./approvalmodel.ts";
import type { OpenView, Recent } from "./approvalprompt.ts";
import { recentIn } from "./recentchat.ts";
import { sameCall } from "./declined.ts";
import { isTypedYes, TYPED_YES_NEEDED } from "../modules/browse/paymentrules.ts";

// Human-in-the-loop approvals over Signal. Several questions may be open at once; each is
// answered by its own reaction or quoted reply, or by a plain yes / no for the newest chat one.

// Fast path: exact (normalised) phrases that need no model call.
const YES = new Set([
  "yes", "y", "yep", "yeah", "yup", "ok", "okay", "k", "sure", "go", "go ahead", "do it",
  "sure go ahead", "yes please", "please do", "approve", "approved", "confirm", "go for it", "👍", "✅",
]);
const NO = new Set([
  "no", "n", "nope", "nah", "stop", "deny", "cancel", "no thanks", "dont", "do not", "👎", "❌",
]);

// lowercase, drop punctuation and apostrophes, collapse spaces (emoji kept).
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// What the open question resolves to. `feedback` is set when the owner replied
// with something other than a clear yes/no: the agent gets it as the reason for
// the denial and can act on it in the same turn (e.g. "yes but make it 16:00").
export interface Decision {
  approved: boolean;
  feedback?: string;
  updatedInput?: Record<string, unknown>; // set when approved with an accepted edit
  question?: string; // set by makeApprove (approvalask.ts): the question exactly as the owner was shown it and answered
  expired?: true; // set by request() when nobody answered in time (not a no): a caller that keeps the matter open can tell the two apart
  superseded?: true; // a newer question about the same action was asked while this one was open: this one is closed, nothing was approved
  failure?: string; // the approval could not be run (no question could be written, the reply could not be read): nothing was approved, the agent is told why and decides what to do
}

export interface Answer {
  outcome: "none" | "approved" | "declined" | "feedback" | "modified" | "clarify";
  changes?: Change[]; // for "modified": what was applied
  reply?: string; // for "clarify" (which one do you mean; a payment needs a typed yes): what to tell the owner. The message was consumed and the approval stays open
}

// One open question. Kept in `open` keyed by its conversation and the timestamp of its "Approve?" message (known once the send resolved): two conversations can
// hold a message with the same timestamp, and a reply or a reaction in one never reaches the other's question.
interface Open {
  resolve: (d: Decision) => void;
  label: string;
  call: { tool: string; input: Record<string, unknown> };
  background: boolean; // asked by an unattended run (wake-up, preset, handler): the owner is not in a conversation with it
  ts: number; // 0 until the "Approve?" message is sent
  done: boolean;
  shown: string; // the question text as sent (what the judge is shown)
  askedAt: number;
  source: Source;
  scope: string; // the conversation it was asked in (Conversation.key): an answer from another conversation never applies, whoever gives it (the admin included)
  typedYes: boolean; // a card payment: only a typed yes approves it (isTypedYes); never a reaction, an emoji, a voice message or the judge's own reading
}
const slot = (scope: string, ts: number) => `${scope}:${ts}`;
const open = new Map<string, Open>();
let openChat = 0; // open approvals (background ones too): they share the one warm judge
const closed = new Map<string, string>(); // recently ended approvals (scope and timestamp -> label): a quoted reply to one must not land on another

// "15 min", "2 h", "1 h 30 min".
export function formatWait(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  return m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// A tenant's rows in the audit log (the admin's) carry no words (audit.ts wordless), and her questions stay out of the console log too.
const rows = (scope: string, meta: Record<string, unknown>) => (isTenantKey(scope) ? wordless(meta) : meta);

const REACT_YES = new Set(["👍", "✅"]);
const REACT_NO = new Set(["👎", "❌"]);

// A reaction counts only if it is on an open "Approve?" message itself; it answers that one. A card payment is the exception: a 👍 never
// approves it ("needs_text": the question stays open and the owner is told to type yes); a 👎 declines it like any other.
// Is a question of this conversation open (asked, not answered)? A heartbeat look parked on one is not called off by a message: that message may be its answer (conversation.ts lease).
export const hasOpen = (scope: string): boolean => [...open.values()].some((o) => o.scope === scope && !o.done);

export function answerReaction(emoji: string, targetTimestamp: number, scope: string, by?: string): "approved" | "declined" | "ignored" | "needs_text" {
  const current = open.get(slot(scope, targetTimestamp));
  if (!current || current.done || current.scope !== scope) return "ignored";
  const e = emoji.replace(/[︎️]/g, ""); // drop variation selectors
  if (current.typedYes && REACT_YES.has(e)) {
    audit(current.call.tool, "answer-reaction-refused", current.source, rows(scope, { by, scope, question: current.shown }));
    return "needs_text";
  }
  if (REACT_YES.has(e) || REACT_NO.has(e)) {
    audit(current.call.tool, "answer-reaction", current.source, rows(scope, { by, scope, approved: REACT_YES.has(e), question: current.shown }));
    current.resolve({ approved: REACT_YES.has(e) });
    return REACT_YES.has(e) ? "approved" : "declined";
  }
  return "ignored";
}

// Feed an incoming message while approvals may be open in its conversation (read() below). Result: "none" = a normal message;
// "approved" / "declined" / "modified" = consumed as the answer; "feedback" = consumed as feedback; "clarify" = consumed, the
// approval stays open. `onJudging` fires just before the (slower) model judge starts, for an ack.
export interface AnswerDeps {
  judge?: typeof judgeAnswer;
  recent?: (reply: string) => Recent[];
}
// `scope`: the conversation the message arrived in; only approvals asked there can be answered. `by`: who wrote it (audit).
// `voice`: the text is an automatic transcript of a voice message.
export interface Ctx {
  scope: string;
  by?: string;
  voice?: boolean;
}
export async function answer(text: string, onJudging: () => void, quote: { timestamp: number } | undefined, deps: AnswerDeps = {}, ctx: Ctx): Promise<Answer> {
  const mine = [...open.values()].filter((o) => o.scope === ctx.scope && !o.done);
  if (mine.length === 0) return { outcome: "none" };
  return read(text, onJudging, quote, deps, ctx, mine);
}

const ENDED = "That question has already ended. Reply to one that is still open, or react to it.";
const WHICH = "Which one do you mean? Reply to the question itself, or react to it.";

// Code decides only two things: an exact plain yes / no that unambiguously targets the one
// open approval (it is the single open one, or the reply quotes it), and the safety invariants below. Every other message is read by
// the judge against ALL open approvals (which one(s), yes / no / an allowed edit / something else); nothing is matched by words
// here and there is no length rule. Invariants kept in code: only this function (a message after the ask) or a reaction resolves an
// approval; an edit applies only through applyChanges (the allow-list); any judge failure or unusable answer approves nothing, is
// logged and is silent: the message goes on as a normal chat message.
async function read(text: string, onJudging: () => void, quote: { timestamp: number } | undefined, deps: AnswerDeps, ctx: Ctx, mine: readonly Open[]): Promise<Answer> {
  const live = [...mine].sort((a, b) => a.ts - b.ts);
  const t = normalise(text);
  const found = quote && quote.timestamp !== 0 ? open.get(slot(ctx.scope, quote.timestamp)) : undefined;
  const quoted = found?.scope === ctx.scope ? found : undefined;
  const direct = quoted && !quoted.done ? quoted : live.length === 1 && !quote ? live[0] : undefined;
  // A card payment: the fast path approves only a typed yes (not 👍, ok, sure, and not a transcript of a voice message); any other yes is asked for again.
  const typedOk = (o: Open) => !o.typedYes || (isTypedYes(text) && !ctx.voice);
  if (direct && (YES.has(t) || NO.has(t) || (direct.typedYes && isTypedYes(text)))) {
    if (!NO.has(t) && !typedOk(direct)) return audit(direct.call.tool, "answer-refused", direct.source, rows(ctx.scope, { by: ctx.by, scope: direct.scope, reply: text, question: direct.shown })), { outcome: "clarify", reply: TYPED_YES_NEEDED };
    const approved = !NO.has(t);
    audit(direct.call.tool, "answer-fast", direct.source, rows(ctx.scope, { by: ctx.by, scope: direct.scope, reply: text, approved, question: direct.shown }));
    direct.resolve({ approved });
    return { outcome: approved ? "approved" : "declined" };
  }
  const ids = new Map(live.map((o, i) => [`A${i + 1}`, o]));
  const views: OpenView[] = live.map((o, i) => ({
    id: `A${i + 1}`,
    background: o.background,
    ageMs: Date.now() - o.askedAt,
    question: o.shown,
    args: isModifiable(o.call.tool) ? o.call.input : undefined,
    typedYes: o.typedYes,
  }));
  const quotedId = quoted && [...ids].find(([, o]) => o === quoted)?.[0];
  onJudging();
  const started = Date.now();
  const j = await (deps.judge ?? judgeAnswer)(text, views, (deps.recent ?? ((reply) => recentIn(ctx.scope, reply)))(text), quote && quote.timestamp !== 0 || ctx.voice ? { id: quotedId, ended: !!quote && !quoted && closed.has(slot(ctx.scope, quote.timestamp)), voice: ctx.voice } : undefined);
  const stillOpen = () => live.filter((o) => !o.done);
  const record = (what: string, o?: Open) => audit(o?.call.tool ?? "approval", `answer-${what}`, o?.source ?? "chat", rows(ctx.scope, { by: ctx.by, scope: o?.scope ?? ctx.scope, reply: text, question: o?.shown, verdict: j && `${j.target} ${j.outcome}`, reason: j?.reason, ms: Date.now() - started }));
  // A reply that is neither yes nor no (a change, a condition, a question, "later") ends that approval: it is superseded by the owner's new instruction. The pending call
  // fails back to the agent with the owner's words, and the agent makes a fresh proposal in the same turn if it still wants to act, so no old approval stays open next to a new
  // question. A card payment is the exception (it stays open until a typed yes or a no: the caller handles it).
  const supersede = (o: Open) => {
    record("superseded", o);
    o.resolve({ approved: false, feedback: text });
  };
  // "Yes to both": each part is applied to its own approval; a part that is not a plain yes / no is superseded like any other reply. An unknown or ended approval is skipped, never guessed.
  const multi = (parts: readonly { target: string; outcome: "approve" | "decline" | "other" }[]): Answer => {
    let approved = 0;
    let declined = 0;
    let replaced = 0;
    for (const p of parts) {
      const o = ids.get(p.target);
      if (!o || o.done || o.typedYes && p.outcome !== "decline") continue; // "yes to both" is no typed yes to a payment, and no reply replaces one
      if (p.outcome === "other") {
        supersede(o);
        replaced++;
        continue;
      }
      record(p.outcome === "approve" ? "approved" : "declined", o);
      o.resolve({ approved: p.outcome === "approve" });
      if (p.outcome === "approve") approved++;
      else declined++;
    }
    const ask = stillOpen().length ? WHICH : undefined;
    if (approved + declined + replaced === 0) return { outcome: "clarify", reply: ask };
    return { outcome: approved ? "approved" : declined ? "declined" : "feedback", ...(ask ? { reply: ask } : {}) };
  };
  if (!j) {
    // Not approved, and not silent for the agent: every open chat approval returns the owner's words as feedback, so the agent
    // decides itself whether to ask again, rephrase or drop the action (permissions.ts caps the re-asks). Background ones stay open.
    record("failed");
    const chat = live.filter((o) => !o.background && !o.done);
    for (const o of chat) o.resolve({ approved: false, feedback: text, failure: "the owner's reply could not be read as a yes or no" });
    return chat.length ? { outcome: "feedback" } : { outcome: "none" };
  }
  if (j.outcome === "unrelated") return record("unrelated"), { outcome: "none" };
  if (j.outcome === "multi") return multi(j.answers ?? []);
  if (j.target === "unclear") {
    record("unclear");
    return { outcome: "clarify", reply: WHICH };
  }
  const current = ids.get(j.target);
  if (!current || current.done) return { outcome: "none" }; // resolved or expired while the judge thought
  // A payment resolves only through the direct paths (the sole open approval, or a reply that quotes it), never because the answer model chose it as the target of a message
  // that quotes nothing: "YES" meant for the calendar question must not pay when the model picks the payment. Ask which one is meant.
  if (current.typedYes && current !== direct) {
    record("refused", current);
    return { outcome: "clarify", reply: `${WHICH} A payment is approved only by typing yes as a reply to its own question.` };
  }
  const call = current.call;
  if (j.outcome === "decline") {
    record("declined", current);
    current.resolve({ approved: false });
    return { outcome: "declined" };
  }
  if (j.outcome === "approve" && !typedOk(current)) {
    record("refused", current); // the judge read a yes, but a payment needs the typed word itself
    return { outcome: "clarify", reply: TYPED_YES_NEEDED };
  }
  if (j.outcome === "approve") {
    record("approved", current);
    current.resolve({ approved: true });
    return { outcome: "approved" };
  }
  if (j.outcome === "approve_modified" && current.typedYes) {
    record("refused", current);
    return { outcome: "clarify", reply: TYPED_YES_NEEDED }; // a payment is never edited
  }
  if (j.outcome === "approve_modified") {
    const patched = applyChanges(call.tool, call.input, j.changes ?? []);
    if (patched) {
      record("modified", current);
      current.resolve({ approved: true, updatedInput: patched });
      return { outcome: "modified", changes: j.changes };
    }
    supersede(current); // a change code does not allow (a recipient): not approved, the agent gets the words and re-proposes
    return { outcome: "feedback" };
  }
  // other: a condition, a change, a delay, a question...
  if (quote && !quoted && closed.has(slot(ctx.scope, quote.timestamp))) {
    record("clarify", current); // it quotes a question that has ended: that says nothing about this open one
    return { outcome: "clarify", reply: ENDED };
  }
  if (current.typedYes) {
    record("clarify", current);
    return { outcome: "clarify", reply: TYPED_YES_NEEDED }; // a payment stays open until a typed yes or a no
  }
  supersede(current);
  return { outcome: "feedback" };
}

// Ask in `opts.scope`, the conversation that triggered the action, and nowhere else. Resolves "not approved" on no, timeout, or an aborted turn.
// Several may be open at once.
// A chat approval waits APPROVAL_TIMEOUT_MINUTES, a background one BACKGROUND_APPROVAL_TIMEOUT_MINUTES.
export function request(
  send: (text: string) => Promise<number>, // returns the sent message's timestamp
  description: string,
  call: { tool: string; input: Record<string, unknown> },
  signal: AbortSignal | undefined,
  opts: { scope: string; source: Source; background?: boolean; question?: string; typedYes?: boolean; minutes?: number },
): Promise<Decision> {
  if (signal?.aborted) return Promise.resolve({ approved: false });
  const background = !!opts.background;
  const minutes = opts.minutes ?? (background ? settings.backgroundApprovalTimeoutMinutes : settings.approvalTimeoutMinutes);
  return new Promise<Decision>((resolve) => {
    const label = description.split("\n")[0] ?? "";
    const named = isTenantKey(opts.scope) ? `(${opts.scope})` : label;
    const shown = opts.question ?? description; // a model-written question; the label stays the code's first line
    const finish = (d: Decision, why?: string) => {
      if (entry.done) return;
      entry.done = true;
      if (entry.ts) {
        closed.set(slot(opts.scope, entry.ts), label);
        if (closed.size > 50) closed.delete(closed.keys().next().value!);
      }
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (entry.ts && open.get(slot(opts.scope, entry.ts)) === entry) open.delete(slot(opts.scope, entry.ts));
      // The warm judge is shared and single-use: drop it only when no other chat approval is left to use it.
      if (--openChat === 0) discardJudge();
      if (why) console.log(`approval ${why}: ${named}`);
      resolve(d);
    };
    const entry: Open = { resolve: finish, label, call, background, ts: 0, done: false, shown, askedAt: Date.now(), source: opts.source, scope: opts.scope, typedYes: !!opts.typedYes };
    const onAbort = () => finish({ approved: false });
    const timer = setTimeout(
      () => finish({ approved: false, expired: true }, `expired after ${formatWait(minutes)}${background ? " (background)" : ""}`),
      minutes * 60_000,
    );
    signal?.addEventListener("abort", onAbort);
    console.log(`approval requested${background ? " (background)" : ""}: ${named}`);
    // At most one open question per conversation for one action: a newer question about the same call closes the older one (declined.ts sameCall).
    for (const o of open.values()) if (o.scope === opts.scope && !o.done && !o.typedYes && !opts.typedYes && o.call.tool === call.tool && sameCall(call.tool, o.call.input, call.input)) o.resolve({ approved: false, superseded: true });
    openChat++;
    prepareJudge(); // warm the judge while the owner reads the question
    // The message is the model's question, as written: no header, no footer. A 👍 / 👎 or a reply on it answers it (open is keyed by its timestamp).
    send(shown)
      .then((ts) => {
        if (entry.done) return;
        entry.ts = ts;
        open.set(slot(opts.scope, ts), entry);
      })
      .catch(() => finish({ approved: false }));
  });
}
