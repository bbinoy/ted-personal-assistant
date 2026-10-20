import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { audit, wordless, type Source } from "./audit.ts";
import { isJudgeable, judgeAction, mayAutoApprove, mayFix, notifyNote, provenanceFor, type CarriedApproval, type RunProvenance, type Verdict } from "./autojudge.ts";
import type { Taint } from "./chatsession.ts";
import type { Decision } from "./approvals.ts";
import { describeCall } from "./format.ts";
import type { MailView } from "./mailview.ts";
import { mailSlot } from "./modules/index.ts";
import { classify, denial, isReadTool } from "./policy.ts";
import { entryFor, mailToolsOf, mailView, readsUntrusted } from "./toolmanifest.ts";
import { OWNER_KEY } from "./send.ts";
import { OWNER, settings } from "./settings.ts";

// Permissions as code: policy.ts decides allow / ask / deny; "ask" goes to the owner's phone (the Approve callback).

// `o.typedYes`: a card payment, which only a typed yes from the owner's chat approves (approvals.ts); a group or an unattended run refuses it.
export type Approve = (
  description: string,
  call: { tool: string; input: Record<string, unknown> },
  signal: AbortSignal,
  o?: { typedYes?: boolean },
) => Promise<Decision>;

// A conversation nobody can be asked in (not set up, a person who is gone).
export const DENY_ALL: Approve = async () => ({ approved: false });

// One approver per conversation, keyed by Conversation.key (the owner's chat, a group id, "tenant:<id>"): a question goes to the
// chat that triggered the action and only an answer there applies (approvals.ts scopes it); in a group any member may answer.
// `background`: an unattended run of that conversation's own (a wake-up, the brief, the mail handler). Set by main.ts (approvers.ts);
// until then (and in tests) nobody is asked. Which tools a run has at all is policy.ts.
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
// Keys sorted at every depth. (A JSON.stringify key-list replacer also filters NESTED keys, so two events that differ only
// in start.dateTime had the same key and the second was refused as "already done".)
const stable = (v: unknown): unknown => (Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, stable(x)])) : v);
export const callKey = (tool: string, input: Record<string, unknown>) => `${tool} ${JSON.stringify(stable(input))}`;
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
}

// Said to the model when the check itself failed (an error anywhere on the way): the call is not run.
const FAILED_CLOSED = "That call could not be checked, so it was not run. Do not retry it; tell the owner in your own words what you could not do.";

export function makeCanUseTool(approve: Approve, source: Source, memoryDir: string | undefined, judge: typeof judgeAction = judgeAction, guard?: CallGuard, tools?: ReadonlySet<string>, tenant = false, setup: JudgeSetup = {}): CanUseTool {
  let untrusted = !!setup.untrusted;
  const isUntrusted = () => untrusted || !!setup.taint?.read();
  const markUntrusted = () => {
    untrusted = true;
    setup.taint?.mark();
  };
  const conversation = setup.conversation ?? OWNER_KEY;
  const log: typeof audit = tenant ? (tool, decision, src, meta) => audit(tool, decision, src, wordless(meta)) : audit; // a tenant's rows carry no words: the audit log is the admin's (audit.ts)
  // The judge's `fix` verdicts of THIS run (this closure lives as long as the run), per tool: how many, and for which exact arguments.
  const fixes = new Map<string, { n: number; keys: Set<string> }>();
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
  async function decide(tool: string, input: Record<string, unknown>, { signal }: { signal: AbortSignal }): Promise<PermissionResult> {
    const g = guard ? await guard.decide(tool, input) : undefined;
    if (g?.kind === "deny") {
      log(tool, "deny-guard", source);
      return { behavior: "deny", message: g.reason ?? `${tool} is blocked and cannot be used.` };
    }
    const base = classify(tool, input, source, memoryDir, tools);
    const verdict = g?.kind === "allow" && base !== "deny" ? "allow" : g?.kind === "ask" && base !== "deny" ? "ask" : base;
    // The call as it must run: what the guard narrowed, or built only now (a card typed by code after the yes), else the model's own.
    const final = async (): Promise<{ input: Record<string, unknown> } | { deny: string }> => {
      if (!g?.resolve) return { input: g?.input ?? input };
      const r = await g.resolve();
      return typeof r === "string" ? { deny: r } : { input: r };
    };
    if (verdict === "allow") {
      if (readsUntrusted(tool)) markUntrusted();
      // Reads log tool + decision only (a public lookup adds its inputs). Writes also log the ids they touch (ids, never
      // content), so "what did it archive?" can always be answered from the audit log.
      log(tool, "allow", source, publicArgs(tool, input) ?? (isReadTool(tool) ? undefined : idsOf(input)));
      const f = await final();
      if ("deny" in f) return { behavior: "deny", message: f.deny };
      return { behavior: "allow", updatedInput: f.input };
    }
    if (verdict === "deny") {
      // A tool module may have more to say about its own denied tool (Gmail archive in log-only mode: recorded like the heartbeat's, so the report and
      // the brief show it, and the model is told to carry on).
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
    let description = g?.description ?? describeCall(tool, input);
    let view: MailView | undefined;
    if (MAIL_OUT.has(entryFor(tool)?.view ?? "")) {
      // Show what the mail client holds right now, not what the model says it is sending (a send of a draft), and the same view for
      // every provider. If that cannot be read, the owner would be approving blind, so the send does not happen.
      const draft = await (mailToolsOf(tool) ?? mailSlot())?.readBack(entryFor(tool)?.view, input, setup.conversation);
      view = mailView(tool, input, draft && { ...draft, bcc: draft.bcc ?? [], hasAttachments: draft.hasAttachments ?? false });
      if (!view || (view.action !== "forward" && view.to.length === 0)) {
        log(tool, "deny-unreadable-draft", source);
        return { behavior: "deny", message: "That mail could not be read back, so it cannot be shown for approval and was not sent." };
      }
      description = describeCall(tool, input, view);
    }
    let judged: Verdict | undefined;
    // The same for every call in every place: the floor (a guard step, or isJudgeable), then the judge, told by code whose words or which standing task led
    // here. With nothing on record there is nothing to judge the action against and the owner is asked.
    const provenance = provenanceFor(setup.provenance?.(), source, setup.browseTask);
    if (settings.autoApprove !== "off" && provenance && !g?.payment && (g?.kind !== "ask" || g.judge === true) && (g?.judge === true || isJudgeable(tool, input, view))) {
      judged = await judge({ description: description + notifyNote(tool, input), provenance, untrustedInput: isUntrusted(), approved: g?.carried });
      // A `fix` only ever denies, with a hint (nobody is asked, nothing runs). It is ask where code says so: a send, delete, payment or guard step
      // (mayFix), a third fix for the tool in this run, or the same arguments again, so a confused model cannot loop. 
      const fx = fixes.get(tool) ?? { n: 0, keys: new Set<string>() };
      if (judged.decision === "fix") {
        const why = !mayFix(tool, { guardStep: g?.kind === "ask", payment: g?.payment }) ? "not-fixable" : fx.n >= MAX_FIXES ? "fix-cap" : fx.keys.has(key) ? "same-arguments" : undefined;
        if (!why) {
          fixes.set(tool, { n: fx.n + 1, keys: fx.keys.add(key) });
          log(tool, "judge-fix", source, { reason: judged.reason, mode: settings.autoApprove, count: fx.n + 1, ...g?.facts });
          return { behavior: "deny", message: `Not run, nobody was asked: ${JSON.stringify(judged.reason)}. Correct the arguments and call the tool again, once. If you cannot tell the right value, ask ${OWNER} in chat instead of guessing.` };
        }
        judged = { decision: "ask", reason: judged.reason };
        log(tool, "judge-ask", source, { reason: judged.reason, mode: settings.autoApprove, fix: why, ...g?.facts, ...(g?.carried ? { carried: g.carried.id } : {}) });
      } else log(tool, `judge-${judged.decision}`, source, { reason: judged.reason, mode: settings.autoApprove, ...g?.facts, ...(g?.carried ? { carried: g.carried.id } : {}) });
      if (mayAutoApprove(settings.autoApprove, judged)) {
        log(tool, "auto-approved", source, { reason: judged.reason }); // silent on purpose: logged, never announced (npm run report shows them)
        if (g?.carried) log(tool, "covered-by-approval", source, { approval: g.carried.id, approvedAt: new Date(g.carried.at).toISOString(), host: g.carried.host, approvedStep: g.carried.step, approvedControl: g.carried.label });
        if (onceOnly) remember(memo);
        if (readsUntrusted(tool)) markUntrusted();
        return { behavior: "allow", updatedInput: g?.input ?? input };
      }
    }
    if ((failures.get(memo)?.n ?? 0) >= MAX_FAILED_ASKS) {
      log(tool, "deny-reask-cap", source);
      return { behavior: "deny", message: `Asking ${OWNER} about this exact call failed ${MAX_FAILED_ASKS} times, so it is not asked again. Do not retry it; tell ${OWNER} in your own words what you could not do, and drop it unless they bring it up again.` };
    }
    log(tool, "ask-sent", source); // logged before the wait, so a stuck approval is visible
    const d = await approve(description, { tool, input: g?.redacted ?? input }, signal, g?.payment ? { typedYes: true } : undefined);
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
    );
    if (d.approved && onceOnly) remember(memo);
    if (d.approved && readsUntrusted(tool)) markUntrusted();
    if (d.approved && !d.updatedInput && d.question) g?.approved?.(d.question);
    if (d.approved && g?.payment && g.resolve) {
      const f = await final(); // the card is opened only now, after the owner's typed yes
      return "deny" in f ? { behavior: "deny", message: f.deny } : { behavior: "allow", updatedInput: f.input };
    }
    if (d.approved) return { behavior: "allow", updatedInput: g?.input ?? (g?.redacted ? input : (d.updatedInput ?? input)) }; // g.input: the call as code must run it (a saved detail typed by code), never the owner's edit
    return {
      behavior: "deny",
      message: d.feedback
        ? `${OWNER} did NOT approve this call. Instead they replied: ${JSON.stringify(d.feedback)}. Act on that reply. If it changes the request, propose the adjusted call; do not repeat the original unchanged.`
        : `${OWNER} declined, or did not answer in time. Do not retry.`,
    };
  };
}
