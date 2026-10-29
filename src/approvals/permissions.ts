import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Source } from "../core/audit.ts";
import { auditSource, type RunKind } from "../core/runkind.ts";
import { emit, type Why } from "../core/events.ts";
import { createdNote, isJudgeable, judgeAction, mayAutoApprove, mayFix, notifyNote, provenanceFor, recipientsOutside, type CarriedApproval, type Provenance, type RunProvenance, type Verdict } from "./autojudge.ts";
import type { Taint } from "../run/chatsession.ts";
import type { Decision } from "./approvals.ts";
import { objectLines, UNNAMED } from "./describe.ts";
import { clearDeclined, declinedAgo, declinedLine, declinedMinutes, noteDeclined } from "./declined.ts";
import { describeCall } from "./format.ts";
import type { MailView } from "../policy/mailview.ts";
import { mailSlot, registered } from "../modules/index.ts";
import { archivedBy, restoredBy } from "../modules/archivecap.ts";
import { tasksNote } from "../modules/tasks/taskfacts.ts";
import { classify, denial, isReadTool } from "../policy/policy.ts";
import { entryFor, mailToolsOf, mailView, readsUntrusted } from "../policy/toolmanifest.ts";
import { UNSCOPED_KEY } from "../core/ownerkey.ts";
import { callKey } from "../core/callkey.ts";
import { OWNER, settings } from "../core/settings.ts";
import { journalable, whyOf } from "./journalrender.ts";

// Permissions as code: policy.ts decides allow / ask / deny; "ask" goes to the owner's phone (the Approve callback).

// `o.typedYes`: a card payment, which only a typed yes from the owner's chat approves (approvals.ts); a group refuses it, and an unattended run never gets this far.
export type Approve = (
  description: string,
  call: { tool: string; input: Record<string, unknown> },
  signal: AbortSignal,
  o?: { typedYes?: boolean; provenance?: Provenance; untrusted?: boolean }, // (the context the judge read, shared with the question: judgecontext.ts)
) => Promise<Decision>;

// A conversation nobody can be asked in (not set up, a person who is gone).
export const DENY_ALL: Approve = async () => ({ approved: false });

// One approver per conversation, keyed by Conversation.key (the owner's chat, a group id, "tenant:<id>"): a question goes to the
// chat that triggered the action and only an answer there applies (approvals.ts scopes it); in a group any member may answer.
// `background`: an unattended run of that conversation's own (a look, its expert, a routine, meeting prep): it never asks anyone (UNATTENDED_SKIP below), so its
// approver asks nobody either (approvers.ts). Set by main.ts (approvers.ts); until then (and in tests) nobody is asked. Which tools a run has at all is policy.ts.
export interface ApproverOptions {
  background?: boolean;
}
let approvers: (key: string, o?: ApproverOptions) => Approve = () => DENY_ALL;
export const setApprovers = (fn: typeof approvers) => void (approvers = fn);
export const approveIn = (key: string, o?: ApproverOptions): Approve => approvers(key, o);

// Pulls id-like fields (id, conversationId, messageId...) out of tool input for the audit log.
export function idsOf(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const ids = Object.fromEntries(
    Object.entries(input).filter(([k, v]) => /(^id$|Id$)/.test(k) && (typeof v === "string" || typeof v === "number")),
  );
  return Object.keys(ids).length ? { ids } : undefined;
}

// The inputs of the calls that only look things up in public data (the weather tools, a web search, a page fetch), for the audit log:
// "which coordinates did it use?", "what did it search?". Anything else logs no content (mail, calendar, notes, the browser).
const PUBLIC_LOOKUPS = /^(mcp__weather__|WebSearch$|WebFetch$)/;
export function publicArgs(tool: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!PUBLIC_LOOKUPS.test(tool)) return undefined;
  const args = Object.fromEntries(Object.entries(input).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 300) : v]));
  return Object.keys(args).length ? { args } : undefined;
}

const MAIL_OUT = new Set(["mbSend", "gmSend", "gmReply", "gmForward", "ggSend"]); // the mail views of the calls that put mail in front of other people (not the bare action "send": mcp__send__send is the conversation's own), judged against the owner's words
// An action the owner approved is done: the same call again (same tool, same arguments) in the same conversation within half an hour is refused
// without a question, because repeating it would send, create or change it twice (a model once retried a send after a
// slow status check). A DECLINED call can still be asked again. Per conversation: another conversation's identical call is its own business, and its model is not
// told something was "already approved" that it never saw.
const DONE_WINDOW_MS = 30 * 60_000;
const done = new Map<string, number>();
// A call whose approval could not be confirmed (no question could be written, a reply could not be read) may be asked again by the
// agent, but only this many times in total, so the loop cannot spin.
const MAX_FAILED_ASKS = 2;
const failures = new Map<string, { n: number; at: number }>();
// The judge's `fix` verdicts (a call held back for wrong arguments) per tool and run: at most this many, then the owner is asked (autojudge.ts).
const MAX_FIXES = 2;
export { callKey }; // (core/callkey.ts: the journal pairs a decision with its success by the same key)
// The state above is kept per conversation: the call's key behind the conversation it runs for.
const scoped = (conversation: string, key: string) => `${conversation}\u0000${key}`;
// Entries older than the window can never match again, so they are dropped as new ones come in (neither map can grow without end).
const remember = (key: string) => {
  const now = Date.now();
  for (const [k, at] of done) if (now - at >= DONE_WINDOW_MS) done.delete(k);
  done.set(key, now);
};
const failed = (key: string) => {
  const now = Date.now();
  for (const [k, f] of failures) if (now - f.at >= DONE_WINDOW_MS) failures.delete(k);
  failures.set(key, { n: (failures.get(key)?.n ?? 0) + 1, at: now });
};
// A call the person approved WITH an edit: what changed, kept until the call's result is handed to the run (editedNote), so the run says it in its own words. Code never writes that chat text.
const edited = new Map<string, string>();
export const editedNote = (conversation: string, tool: string, input: Record<string, unknown>): string | undefined => {
  const k = scoped(conversation, callKey(tool, input));
  const what = edited.get(k);
  edited.delete(k);
  return what && `${OWNER} approved this call with a change, so it ran with these values: ${what}. They were not told this yet; say it in your reply, in a few words.`;
};
// Only for actions that change something: opening a page again is harmless, and refusing it would just get in the way.
export const doneCount = () => done.size; // tests
export const failureCount = () => failures.size; // tests
const once = (tool: string) => tool !== "WebFetch" && !isReadTool(tool);

// A run that needs rules a flag cannot say per call (the browse run: which element a click is, which address is fine) passes a guard.
// It sees every call first: deny it, allow it, turn it into a question with code-built text (`ask`), or leave it to the manifest
// (`defer`; `description` is then what the owner and the judge read).
export interface GuardDecision {
  kind: "deny" | "allow" | "ask" | "defer";
  reason?: string;
  description?: string;
  once?: boolean; // an approved call is not repeated
  judge?: boolean; // ask: goes to the approval judge first (a browse commit step); only its "auto" skips the owner. Without it the owner is always asked
  redacted?: Record<string, unknown>; // ask: the call as the question writer, the approval card and the audit see it (a typed secret cut to its length); the real input still runs
  facts?: Record<string, unknown>; // ask: what the judge's audit row records about the step (host, role, name)
  input?: Record<string, unknown>; // the call as it must run, when the guard narrowed it (the browse screenshot); the allowed call runs with this input
  payment?: boolean; // ask: a card payment. Never judged, never auto-approved; only the owner's typed yes approves it (approvals.ts), and it is not remembered as done (the guard keeps its own once-only)
  carried?: CarriedApproval; // ask + judge: the owner's earlier approved question of this run, offered by code (same run, conversation and host, not expired, no payment); the judge reads it as fenced data
  approved?: (question: string) => void; // ask: told the owner's question after they approve it (the guard keeps it for the rest of the run)
  allowed?: (by: "judge" | "owner") => void; // defer: told when this very call was let through by the judge's auto or by the owner's yes (the guard learns which site the run has been cleared for)
  skipped?: { reason: string; host: string }; // allow: the judge was skipped on purpose and code says why (a navigate to a site the run was already cleared for); recorded as judge-skipped
  resolve?: () => Promise<Record<string, unknown> | string>; // the call as it must run, built only now that it is allowed (the card is opened here, after the owner said yes); a string: the call is refused with that reason
}
export interface CallGuard {
  decide: (tool: string, input: Record<string, unknown>) => Promise<GuardDecision>;
}

// What the approval judge is told about the run, set by code from how the run was started (never by the model): `provenance`: whose words or which fixed or derived
// text started it (autojudge.ts RunProvenance; read at every call, since a warm process is built before the message that uses it arrives); `browseTask`: the task the
// assistant wrote for its browser worker, shown next to the provenance the sub-run inherited; `untrusted`: the run reads raw mail or web pages from its first call (the
// mail handler, the browse worker); `taint`: the session it continues has read some (chatsession.ts), which keeps the flag on in the turns after it. Either way the
// flag also turns on once the run has read mail or a page. `conversation`: the conversation the run acts for (Conversation.key; the owner's by default): the anti-repeat
// state below is kept per conversation.
export interface JudgeSetup {
  provenance?: () => RunProvenance | undefined;
  browseTask?: string;
  untrusted?: boolean;
  taint?: Taint;
  conversation?: string;
  run?: string; // this run's id: the journal pairs a call's why with its success within the run only (agentrun.ts)
  seenMail?: { forget: (ids: readonly string[]) => void }; // the look's seen-mail tracker: mail an archive the run cap refused named is not worked through, so it is not marked seen
  notesSeen?: () => readonly string[]; // the notes this run has read so far, in order, for the journal's "per your notes: ..."
  // A run with experts (heartbeat/delegation.ts): the briefs the run wrote for them so far (read at every call: the judge reads them next to the provenance when the call is a
  // subagent's), and the type of a subagent by its id (for the audit log).
  expertBriefs?: () => readonly string[];
  agentTypeOf?: (agentID: string | undefined) => string | undefined;
  restoreFree?: boolean; // the owner's own chat: putting mail back in the inbox (archivecap.ts restoredBy) undoes an archive and runs without the judge
}

// UNATTENDED RUNS NEVER ASK (the owner, 22 Oct: "act when it's sure and stay silent if it's not"). A run that answers no live message of a person (a heartbeat look of the
// owner, a group or a friend, its expert, the routines it delegates, meeting prep, the browse worker of such a run) puts no question to anyone: a call that would lead to one
// (the judge's ask, a floor that forces ask, a recent decline, a fix that may not be applied) is declined back to the run with this fixed text, audited `background-skip` with
// the reason class only. No question, no approval-inbox item, no "waiting" line. Whether a run is unattended is one fact of the run (core/runkind.ts RunKind.attended), the same for
// the owner's look, a group's and a friend's.
export const UNATTENDED_SKIP = "Not done: not certain enough to act without asking, and background work never asks. Do not retry it: turn what needs the owner into what is allowed (a draft, or an add_task item) so the brief lists it; mention it only if it truly matters, as information.";
// A card payment in an unattended run: refused like a never-allowed call, nobody is asked (only the owner's typed yes in her own chat pays).
const PAYMENT_UNATTENDED = "A payment is never made by background work, and nobody is asked from here. Do not retry it: add_task an item for the owner so the brief lists it.";

// Said to the model when the check itself failed (an error anywhere on the way): the call is not run.
const FAILED_CLOSED = "That call could not be checked, so it was not run. Do not retry it; tell the owner in your own words what you could not do.";

// The ONE place the code-rendered details of a call are built, for the ask path below (shown to the owner, judged). A mail send is shown as the mail client holds it right now, not as the model says it is sending (a send of a draft), the same view for
// every provider; if that cannot be read the owner would be approving blind, so there is no view and no details (`unreadable`). A call on an object by its id names the object (describe.ts);
// a guard-built step and a payment have their own text (`own`) and no object line.
export async function renderCall(conversation: string | undefined, tool: string, input: Record<string, unknown>, own?: { description?: string; payment?: boolean }): Promise<{ description: string; view?: MailView } | { unreadable: true }> {
  let description = own?.description ?? describeCall(tool, input);
  let view: MailView | undefined;
  if (MAIL_OUT.has(entryFor(tool)?.view ?? "")) {
    const draft = await (mailToolsOf(tool) ?? mailSlot())?.readBack(entryFor(tool)?.view, input, conversation);
    view = mailView(tool, input, draft && { ...draft, bcc: draft.bcc ?? [], hasAttachments: draft.hasAttachments ?? false });
    if (!view || (view.action !== "forward" && view.to.length === 0)) return { unreadable: true };
    description = describeCall(tool, input, view);
  }
  if (!own?.payment && !own?.description) description += await objectLines(conversation ?? UNSCOPED_KEY, tool, input);
  return { description, view };
}

export function makeCanUseTool(approve: Approve, run: RunKind, memoryDir: string | undefined, judge: typeof judgeAction = judgeAction, guard?: CallGuard, tools?: ReadonlySet<string>, tenant = false, setup: JudgeSetup = {}): CanUseTool {
  let untrusted = !!setup.untrusted;
  const isUntrusted = () => untrusted || !!setup.taint?.read();
  const markUntrusted = () => {
    untrusted = true;
    setup.taint?.mark();
  };
  const conversation = setup.conversation ?? UNSCOPED_KEY;
  const source = auditSource(run); // (the audit label)
  const unattended = !run.attended;
  // Every row goes through the event stream (core/events.ts); a tenant's rows carry no words there (the audit log is the admin's). `ev`: on the steps that let a call run, the call and why, which the journal keeps until it succeeds.
  type Log = (tool: string, decision: string, src: Source, meta?: Record<string, unknown>, ev?: { call?: { input: Record<string, unknown>; final?: Record<string, unknown> }; why?: Why }) => void;
  const baseLog: Log = (tool, decision, src, meta, ev) => emit({ type: "tool", tool, decision, source: src, conv: conversation, ...(setup.run ? { run: setup.run } : {}), friend: tenant, ...(meta ? { meta } : {}), ...ev });
  const log = baseLog;
  // The judge's `fix` verdicts of THIS run (this closure lives as long as the run), per tool: how many, and for which exact arguments.
  const fixes = new Map<string, { n: number; keys: Set<string> }>();
  const unnamedSent = new Set<string>(); // calls already sent back once to be looked up (so a call that cannot be named is then asked, not looped)
  const runGates = registered().flatMap((m) => (m.floor?.perRun ? [m.floor.perRun()] : [])); // the modules' limits for THIS run (the archive cap)
  // Fails closed: whatever throws on the way (the guard, the audit log, the read-back of a draft, the judge's set-up, the approver) ends in a deny, never an allow.
  return async (tool, input, o) => {
    try {
      return await decide(tool, input, o);
    } catch (e) {
      console.error(`permissions: ${tool}: the check failed (${(e as Error)?.name ?? "error"}), denied`);
      try {
        log(tool, "deny-error", source, { error: (e as Error)?.name ?? "error" });
      } catch {
        /* the log may be what failed */
      }
      return { behavior: "deny", message: FAILED_CLOSED };
    }
  };
  async function decide(tool: string, input: Record<string, unknown>, { signal, agentID }: { signal: AbortSignal; agentID?: string }): Promise<PermissionResult> {
    // A call of an expert subagent (the SDK gives its id): its audit rows say which agent type made it, and the judge reads the run's briefs for the experts next to the provenance.
    const agentType = agentID ? (setup.agentTypeOf?.(agentID) ?? "subagent") : undefined;
    const log: Log = agentType ? (t, decision, src, meta, ev) => baseLog(t, decision, src, { ...meta, agent_type: agentType }, ev) : baseLog;
    const g = guard ? await guard.decide(tool, input) : undefined;
    if (g?.kind === "deny") {
      log(tool, "deny-guard", source);
      return { behavior: "deny", message: g.reason ?? `${tool} is blocked and cannot be used.` };
    }
    const base = classify(tool, input, run, memoryDir, tools);
    // A limit about the run, not the call (the archive cap): a module's gate may refuse a call the manifest would let through.
    if (base !== "deny") {
      const limit = runGates.map((gate) => gate(tool, input)).find((m) => m !== undefined);
      if (limit !== undefined) setup.seenMail?.forget(archivedBy(tool, input) ?? []); // (the cap refused these: the next look takes them)
      if (limit !== undefined) {
        log(tool, "deny-run-cap", source, idsOf(input));
        return { behavior: "deny", message: limit };
      }
    }
    // Bringing mail back ("restore 3", "bring back the Digitec mail") in the owner's own chat: the reverse of an archive, so no judge and no question; audited and journaled like an allow.
    if (base === "ask" && !g && setup.restoreFree && restoredBy(tool, input)) {
      log(tool, "allow", source, { ...idsOf(input), free: "restore" }, journalable(tool, input) ? { call: { input }, why: whyOf({ conv: conversation, step: "allow", notes: setup.notesSeen?.(), input, provenance: setup.provenance?.() }) } : undefined);
      return { behavior: "allow", updatedInput: input };
    }
    const verdict = g?.kind === "allow" && base !== "deny" ? "allow" : g?.kind === "ask" && base !== "deny" ? "ask" : base;
    // The call as it must run: what the guard narrowed, or built only now (a card typed by code after the yes), else the model's own.
    const final = async (): Promise<{ input: Record<string, unknown> } | { deny: string }> => {
      if (!g?.resolve) return { input: g?.input ?? input };
      const r = await g.resolve();
      return typeof r === "string" ? { deny: r } : { input: r };
    };
    if (verdict === "allow") {
      if (readsUntrusted(tool, undefined, conversation)) markUntrusted();
      // Reads log tool + decision only (a public lookup adds its inputs). Writes also log the ids they touch (ids, never
      // content), so "what did it archive?" can always be answered from the audit log.
      if (g?.skipped) log(tool, "judge-skipped", source, { reason: g.skipped.reason, host: g.skipped.host });
      const reads = isReadTool(tool);
      log(tool, "allow", source, publicArgs(tool, input) ?? (reads ? undefined : idsOf(input)), reads || g?.resolve || !journalable(tool, input) ? undefined : { call: { input, ...(g?.input ? { final: g.input } : {}) }, why: whyOf({ conv: conversation, step: "allow", notes: setup.notesSeen?.(), input, provenance: setup.provenance?.() }) });
      const f = await final();
      if ("deny" in f) return { behavior: "deny", message: f.deny };
      return { behavior: "allow", updatedInput: f.input };
    }
    if (verdict === "deny") {
      // A tool module may have more to say about its own denied tool (a record for the audit log, or a message for the model).
      const d = denial(tool, input);
      if (d?.record) {
        log(d.record.tool, d.record.decision, source, d.record.meta);
        return { behavior: "deny", message: d.message ?? `${tool} is blocked by policy (or its input is) and cannot be used.` };
      }
      log(tool, "deny-policy", source, d?.withIds ? idsOf(input) : undefined);
      return { behavior: "deny", message: d?.message ?? `${tool} is blocked by policy (or its input is) and cannot be used.` };
    }
    const key = callKey(tool, input);
    const memo = scoped(conversation, key);
    const onceOnly = g ? !!g.once && !g.payment : once(tool);
    const doneAt = onceOnly ? done.get(memo) : undefined;
    if (doneAt !== undefined && Date.now() - doneAt < DONE_WINDOW_MS) {
      log(tool, "deny-already-done", source);
      return { behavior: "deny", message: "That exact call was already approved and done a moment ago. Do not repeat it; check its result once if you need to be sure it went through." };
    }
    const rendered = await renderCall(setup.conversation, tool, input, g);
    if ("unreadable" in rendered) {
      log(tool, "deny-unreadable-draft", source);
      return { behavior: "deny", message: "That mail could not be read back, so it cannot be shown for approval and was not sent." };
    }
    let description = rendered.description;
    const view: MailView | undefined = rendered.view;
    // A decline is final until the person asks again in a new message (declined.ts): the question and the judge are told, and the judge cannot loosen it.
    const declinedMs = g?.payment ? undefined : declinedAgo(conversation, tool, input, Date.now(), g?.description);
    if (declinedMs !== undefined) description += `\n${declinedLine(declinedMs)}`;
    // A delete or change of an object the run never saw by name is not asked by its id: the run looks it up first (a read), so the question can name it. The second time, the owner is asked.
    if (!g && declinedMs === undefined && description.includes(UNNAMED) && !unnamedSent.has(key)) {
      unnamedSent.add(key);
      log(tool, "judge-fix", source, { reason: "unnamed-object", count: unnamedSent.size });
      return { behavior: "deny", message: "Not run, nobody was asked: this call names an object only by its id, and no question can be put to the person about an id. Look the object up first with a read tool (for a calendar event: get_event, or list_events for that day), so you know its title and time, then call this again. Name it by title and time in anything you say to the person." };
    }
    let judgeSaid: Verdict["decision"] | undefined;
    let judged: Verdict | undefined;
    let skipWhy: string | undefined; // why an unattended run's call is skipped (the audit's reason class): the judge's ask, a fix that may not be applied, a decline that stands
    // The same for every call in every place: the floor (a guard step, or isJudgeable), then the judge, told by code whose words or which standing task led
    // here. With nothing on record there is nothing to judge the action against and the owner is asked.
    const provenance = provenanceFor(setup.provenance?.(), source, setup.browseTask, agentID ? setup.expertBriefs?.() : undefined);
    // A floor in code on top of isJudgeable, for what third-party text may have steered: a send to someone the person's words and the thread do not account for, in a run that
    // has read untrusted mail or pages. The owner is asked.
    const outside = view && isUntrusted() && MAIL_OUT.has(entryFor(tool)?.view ?? "") ? recipientsOutside(view, input, provenance) : [];
    if (outside.length) log(tool, "judge-floor", source, { reason: "untrusted-recipient", recipients: outside.length });
    if (settings.autoApprove !== "off" && provenance && !g?.payment && !outside.length && (g?.kind !== "ask" || g.judge === true) && (g?.judge === true || isJudgeable(tool, input, view))) {
      judged = await judge({ description: description + notifyNote(tool, input) + createdNote(tool, input, conversation) + tasksNote(tool, conversation), provenance, untrustedInput: isUntrusted(), approved: g?.carried });
      if (declinedMs !== undefined && judged.decision !== "ask") {
        judgeSaid = judged.decision;
        judged = { decision: "ask", reason: judged.reason };
      }
      // A `fix` only ever denies, with a hint (nobody is asked, nothing runs). It is ask where code says so: a send, delete, payment or guard step
      // (mayFix), a third fix for the tool in this run, or the same arguments again, so a confused model cannot loop. 
      const fx = fixes.get(tool) ?? { n: 0, keys: new Set<string>() };
      if (judged.decision === "fix") {
        const why = !mayFix(tool, { guardStep: g?.kind === "ask", payment: g?.payment, input }) ? "not-fixable" : fx.n >= MAX_FIXES ? "fix-cap" : fx.keys.has(key) ? "same-arguments" : undefined;
        if (!why) {
          fixes.set(tool, { n: fx.n + 1, keys: fx.keys.add(key) });
          log(tool, "judge-fix", source, { reason: judged.reason, mode: settings.autoApprove, count: fx.n + 1, ...g?.facts });
          return { behavior: "deny", message: `Not run, nobody was asked: ${JSON.stringify(judged.reason)}. Correct the arguments and call the tool again, once. ${unattended ? "If you cannot tell the right value, leave it: background work never asks." : `If you cannot tell the right value, ask ${OWNER} in chat instead of guessing.`}` };
        }
        judged = { decision: "ask", reason: judged.reason };
        skipWhy = "fix";
        log(tool, "judge-ask", source, { reason: judged.reason, mode: settings.autoApprove, fix: why, ...g?.facts, ...(g?.carried ? { carried: g.carried.id } : {}) });
      } else log(tool, `judge-${judged.decision}`, source, { reason: judged.reason, mode: settings.autoApprove, ...g?.facts, ...(g?.carried ? { carried: g.carried.id } : {}) });
      if (judged.decision === "ask") skipWhy = declinedMs !== undefined ? "redeclined" : skipWhy === "fix" ? "fix" : "judge";
      if (mayAutoApprove(settings.autoApprove, judged)) {
        log(tool, "auto-approved", source, { reason: judged.reason }, !journalable(tool, input) ? undefined : { call: { input, ...(g?.input ? { final: g.input } : {}) }, why: whyOf({ conv: conversation, step: "auto-approved", notes: setup.notesSeen?.(), input, provenance, judge: judged.reason }) }); // silent on purpose: logged, never announced (npm run report shows them)
        if (g?.carried) log(tool, "covered-by-approval", source, { approval: g.carried.id, approvedAt: new Date(g.carried.at).toISOString(), host: g.carried.host, approvedStep: g.carried.step, approvedControl: g.carried.label });
        if (onceOnly) remember(memo);
        if (readsUntrusted(tool, undefined, conversation)) markUntrusted();
        g?.allowed?.("judge");
        return { behavior: "allow", updatedInput: g?.input ?? input };
      }
    }
    if (declinedMs !== undefined) log(tool, "redeclined", source, { minutes: declinedMinutes(declinedMs), ...(judgeSaid ? { judge: judgeSaid } : {}) });
    // An unattended run asks nobody: what would be a question is declined back to it (UNATTENDED_SKIP). A payment is refused outright.
    // The floor's reason class, when no judge verdict led here: no provenance, the judge switched off, a floor in code, a guard step that is never judged, or a call
    // isJudgeable keeps from the judge (a send, a delete, an unknown tool, a create with no title...).
    const floorWhy = (): string => (!provenance ? "no-provenance" : settings.autoApprove === "off" ? "judge-off" : outside.length ? "untrusted-recipient" : g?.kind === "ask" && g.judge !== true ? "guard-step" : "never-judged");
    if (unattended) {
      if (g?.payment) {
        log(tool, "deny-payment-unattended", source);
        return { behavior: "deny", message: PAYMENT_UNATTENDED };
      }
      log(tool, "background-skip", source, { skip: skipWhy ?? (declinedMs !== undefined ? "redeclined" : floorWhy()) });
      return { behavior: "deny", message: UNATTENDED_SKIP };
    }
    if ((failures.get(memo)?.n ?? 0) >= MAX_FAILED_ASKS) {
      log(tool, "deny-reask-cap", source);
      return { behavior: "deny", message: `Asking ${OWNER} about this exact call failed ${MAX_FAILED_ASKS} times, so it is not asked again. Do not retry it; tell ${OWNER} in your own words what you could not do, and drop it unless they bring it up again.` };
    }
    log(tool, "ask-sent", source); // logged before the wait, so a stuck approval is visible
    const d = await approve(description, { tool, input: g?.redacted ?? input }, signal, { ...(g?.payment ? { typedYes: true } : {}), provenance, untrusted: isUntrusted() });
    if (d.superseded) {
      log(tool, "ask-superseded", source);
      return { behavior: "deny", message: "That question was closed because a newer question about the same action was asked. Nothing was executed; wait for the answer to the newer one." };
    }
    if (d.failure) {
      failed(memo);
      log(tool, "ask-failed", source, { reason: d.failure });
      return { behavior: "deny", message: `The approval could not be confirmed: ${d.failure}. Nothing was executed.${d.feedback ? ` ${OWNER} had replied: ${JSON.stringify(d.feedback)}.` : ""} Decide yourself: ask ${OWNER} again in your own words (at most ${MAX_FAILED_ASKS - (failures.get(memo)?.n ?? 0)} more time(s) for this call), rephrase the request, or drop the action.` };
    }
    failures.delete(memo);
    if (judged) log(tool, "judge-vs-owner", source, { judge: judged.decision, ownerApproved: d.approved });
    log(
      tool,
      d.approved ? (d.updatedInput ? "ask-approved-modified" : "ask-approved") : d.feedback ? "ask-feedback" : "ask-declined",
      source,
      undefined,
      d.approved && !g?.resolve && journalable(tool, input) ? { call: { input, final: g?.input ?? (g?.redacted ? input : (d.updatedInput ?? input)) }, why: whyOf({ conv: conversation, step: "approved", notes: setup.notesSeen?.(), input, provenance }) } : undefined,
    );
    if (d.approved) clearDeclined(conversation, tool, input, Date.now(), g?.description);
    else if (!d.feedback && !d.expired && !signal.aborted && !g?.payment) noteDeclined(conversation, tool, input, Date.now(), g?.description); // a plain no (not a reply, not silence, not an aborted turn)
    if (d.approved && onceOnly) remember(memo);
    if (d.approved && readsUntrusted(tool, undefined, conversation)) markUntrusted();
    if (d.approved && !d.updatedInput && d.question) g?.approved?.(d.question);
    if (d.approved && !d.updatedInput) g?.allowed?.("owner");
    if (d.approved && g?.payment && g.resolve) {
      const f = await final(); // the card is opened only now, after the owner's typed yes
      return "deny" in f ? { behavior: "deny", message: f.deny } : { behavior: "allow", updatedInput: f.input };
    }
    if (d.approved && d.updatedInput && d.changes?.length && !g?.input && !g?.redacted) {
      if (edited.size > 50) edited.delete(edited.keys().next().value!);
      edited.set(scoped(conversation, callKey(tool, d.updatedInput)), d.changes.map((c) => `${c.field} = ${c.value}`).join(", "));
    }
    if (d.approved) return { behavior: "allow", updatedInput: g?.input ?? (g?.redacted ? input : (d.updatedInput ?? input)) }; // g.input: the call as code must run it (a saved detail typed by code), never the owner's edit
    return {
      behavior: "deny",
      message: d.feedback
        ? `${OWNER} did NOT approve this call, and its question is closed. They replied: ${JSON.stringify(d.feedback)}. Nothing was executed. Make a new proposal now, in this turn, with the arguments changed as that reply asks (call the tool again; a fresh question is asked), if you still want to act; do not repeat the original unchanged, and do not ask ${OWNER} in chat what they just told you.`
        : d.expired
          ? `${OWNER} did not answer in time. Nothing was done. Do not retry it now; mention it in your next message to ${OWNER} if it still matters.`
          : `${OWNER} declined. Do not retry.`,
    };
  };
}
