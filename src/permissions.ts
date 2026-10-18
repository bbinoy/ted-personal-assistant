import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { audit, type Source } from "./audit.ts";
import { isJudgeable, judgeAction, mayAutoApprove, type Verdict } from "./autojudge.ts";
import type { Decision } from "./approvals.ts";
import { describeCall } from "./format.ts";
import { isGmailTool, isInboxArchive } from "./gmailrules.ts";
import { classify, isReadTool } from "./policy.ts";
import type { DraftView } from "./proposals.ts";
import { actionOf, entryFor, mailView, type MailView, type ViewKind } from "./toolmanifest.ts";
import { LIMITS } from "./sanitize.ts";
import { OWNER, settings } from "./settings.ts";

// Permissions as code: policy.ts decides allow / ask / deny; "ask" goes to the owner's phone (the Approve callback).

// `o.typedYes`: a card payment, which only a typed yes from the owner's chat approves (approvals.ts); a group or an unattended run refuses it.
export type Approve = (
  description: string,
  call: { tool: string; input: Record<string, unknown> },
  signal: AbortSignal,
  o?: { typedYes?: boolean },
) => Promise<Decision>;

// A group run never asks the owner for anything.
export const DENY_ALL: Approve = async () => ({ approved: false });

// A group asks in its own group, and any member may answer there (approvals.ts scopes it). Set by main.ts; until then (and in tests)
// a group asks nobody. Which tools a group run has at all is policy.ts, unchanged: today none of them asks.
let groupApprover: (groupId: string) => Approve = () => DENY_ALL;
export const setGroupApprover = (fn: typeof groupApprover) => void (groupApprover = fn);
export const approveInGroup = (groupId: string): Approve => groupApprover(groupId);

// Pulls id-like fields (id, conversationId, messageId...) out of tool input for the audit log.
export function idsOf(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const ids = Object.fromEntries(
    Object.entries(input).filter(([k, v]) => /(^id$|Id$)/.test(k) && (typeof v === "string" || typeof v === "number")),
  );
  return Object.keys(ids).length ? { ids } : undefined;
}

// What the owner just said in chat, and the two messages before it, for the approval judge (a send is judged against what was said
// about it, which may have been a message ago: "reply to Armon that Tuesday works" ... "send it"). A module-level value because
// the warm chat process is built before the message arrives; chat turns run one at a time.
let chatOwnerMessages: string[] = [];
export const setChatOwnerMessage = (text: string) => void (chatOwnerMessages = [...chatOwnerMessages, text].slice(-3));
// What the assistant last told the owner in chat (a draft it showed, a plan it announced): context for the judge, so that a plain "yes, send"
// is read against what it answers. Never consent by itself (autojudge.ts says so to the judge).
let chatAssistantMessage = "";
export const setChatAssistantMessage = (text: string) => void (chatAssistantMessage = text.slice(0, LIMITS.quote));
const MAIL_OUT = new Set(["send", "reply", "forward"]); // actions that put mail in front of other people, judged against the owner's words
// An action the owner approved is done: the same call again (same tool, same arguments) within half an hour is refused
// without a question, because repeating it would send, create or change it twice (a model once retried a send after a
// slow status check). A DECLINED call can still be asked again.
const DONE_WINDOW_MS = 30 * 60_000;
const done = new Map<string, number>();
// A call whose approval could not be confirmed (no question could be written, a reply could not be read) may be asked again by the
// agent, but only this many times in total, so the loop cannot spin.
const MAX_FAILED_ASKS = 2;
const failures = new Map<string, number>();
// Keys sorted at every depth. (A JSON.stringify key-list replacer also filters NESTED keys, so two events that differ only
// in start.dateTime had the same key and the second was refused as "already done".)
const stable = (v: unknown): unknown => (Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, stable(x)])) : v);
export const callKey = (tool: string, input: Record<string, unknown>) => `${tool} ${JSON.stringify(stable(input))}`;
// Entries older than the window can never match again, so they are dropped as new ones come in (the map cannot grow without end).
const remember = (key: string) => {
  const now = Date.now();
  for (const [k, at] of done) if (now - at >= DONE_WINDOW_MS) done.delete(k);
  done.set(key, now);
};
// Only for actions that change something: opening a page again is harmless, and refusing it would just get in the way.
export const doneCount = () => done.size; // tests
const once = (tool: string) => tool !== "WebFetch" && !isReadTool(tool);
let draftReader: ((messageId: number) => Promise<DraftView | undefined>) | undefined;
// Set by main.ts: reads a draft back from Mailbird, for the approval of a send.
export const setDraftReader = (fn: typeof draftReader) => void (draftReader = fn);
// Gmail (MAIL_PROVIDER=gmail), set by main.ts: a draft read back by its id (the approval of send_message with a draftId), and the original
// message of a reply (its sender and recipients, so a reply that names none is shown with the people who really receive it).
export interface GmailReaders {
  draft: (draftId: string) => Promise<DraftView | undefined>;
  original: (messageId: string) => Promise<DraftView | undefined>;
}
let gmailReaders: GmailReaders | undefined;
export const setGmailReaders = (r: GmailReaders | undefined) => void (gmailReaders = r);

// What the mail client holds for a send of a draft, or the original of a Gmail reply (undefined: nothing to read, or it could not be read).
async function readBack(kind: ViewKind | undefined, input: Record<string, unknown>): Promise<DraftView | undefined> {
  const id = Number(input.messageId);
  if (kind === "mbSend" && draftReader && Number.isFinite(id)) return draftReader(id).catch(() => undefined);
  if (kind === "gmSend" && typeof input.draftId === "string" && gmailReaders) return gmailReaders.draft(input.draftId).catch(() => undefined);
  if (kind === "gmReply" && typeof input.messageId === "string" && gmailReaders) return gmailReaders.original(input.messageId).catch(() => undefined);
  return undefined;
}

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
  resolve?: () => Promise<Record<string, unknown> | string>; // the call as it must run, built only now that it is allowed (the card is opened here, after the owner said yes); a string: the call is refused with that reason
}
export interface CallGuard {
  decide: (tool: string, input: Record<string, unknown>) => Promise<GuardDecision>;
}

export function makeCanUseTool(approve: Approve, source: Source, memoryDir: string | undefined, judgeContext?: string, judge: typeof judgeAction = judgeAction, guard?: CallGuard, tenantTools?: ReadonlySet<string>): CanUseTool {
  return async (tool, input, { signal }) => {
    const g = guard ? await guard.decide(tool, input) : undefined;
    if (g?.kind === "deny") {
      audit(tool, "deny-guard", source);
      return { behavior: "deny", message: g.reason ?? `${tool} is blocked and cannot be used.` };
    }
    const base = classify(tool, input, source, memoryDir, tenantTools);
    const verdict = g?.kind === "allow" && base !== "deny" ? "allow" : g?.kind === "ask" && base !== "deny" ? "ask" : base;
    // The call as it must run: what the guard narrowed, or built only now (a card typed by code after the yes), else the model's own.
    const final = async (): Promise<{ input: Record<string, unknown> } | { deny: string }> => {
      if (!g?.resolve) return { input: g?.input ?? input };
      const r = await g.resolve();
      return typeof r === "string" ? { deny: r } : { input: r };
    };
    if (verdict === "allow") {
      // Reads log tool + decision only. Writes also log the ids they touch (ids, never
      // content), so "what did it archive?" can always be answered from the audit log.
      audit(tool, "allow", source, isReadTool(tool) ? undefined : idsOf(input));
      const f = await final();
      if ("deny" in f) return { behavior: "deny", message: f.deny };
      return { behavior: "allow", updatedInput: f.input };
    }
    if (verdict === "deny") {
      if (isInboxArchive(tool, input) && settings.mailProvider === "gmail") {
        // Gmail archive in log-only mode (GMAIL_ARCHIVE_LIVE=false): recorded like the heartbeat's, so the report and brief show it.
        audit("gmail_archive", "would-archive", source, { id: input.threadId });
        return { behavior: "deny", message: "Archiving is in log-only mode (GMAIL_ARCHIVE_LIVE=false): it was recorded as would-archive and the thread stays in the inbox. Carry on without archiving." };
      }
      audit(tool, "deny-policy", source, isGmailTool(tool) ? idsOf(input) : undefined);
      return { behavior: "deny", message: `${tool} is blocked by policy (or its input is) and cannot be used.` };
    }
    // A small model's second opinion, only for what code puts on the floor (autojudge.ts). In shadow
    // mode it only logs; the owner is asked either way.
    const key = callKey(tool, input);
    const onceOnly = g ? !!g.once && !g.payment : once(tool);
    const doneAt = onceOnly ? done.get(key) : undefined;
    if (doneAt !== undefined && Date.now() - doneAt < DONE_WINDOW_MS) {
      audit(tool, "deny-already-done", source);
      return { behavior: "deny", message: "That exact call was already approved and done a moment ago. Do not repeat it; check its result once if you need to be sure it went through." };
    }
    let description = g?.description ?? describeCall(tool, input);
    let view: MailView | undefined;
    if (MAIL_OUT.has(actionOf(tool))) {
      // Show what the mail client holds right now, not what the model says it is sending (a send of a draft), and the same view for
      // every provider. If that cannot be read, the owner would be approving blind, so the send does not happen.
      const draft = await readBack(entryFor(tool)?.view, input);
      view = mailView(tool, input, draft && { ...draft, bcc: draft.bcc ?? [], hasAttachments: draft.hasAttachments ?? false });
      if (!view || (view.action !== "forward" && view.to.length === 0)) {
        audit(tool, "deny-unreadable-draft", source);
        return { behavior: "deny", message: "That mail could not be read back, so it cannot be shown for approval and was not sent." };
      }
      description = describeCall(tool, input, view);
    }
    let judged: Verdict | undefined;
    const [ownerMessage, ...earlier] = [...chatOwnerMessages].reverse();
    // A chat send is judged against the owner's words; with none on record there is nothing to judge it against.
    if (settings.autoApprove !== "off" && (g?.kind !== "ask" || g.judge === true) && (g?.judge === true || isJudgeable(tool, input, source, view)) && (view === undefined || (source === "chat" && ownerMessage !== undefined))) {
      judged = await judge({ source, description, ownerMessage: source === "chat" ? ownerMessage : undefined, assistantSaid: source === "chat" && chatAssistantMessage ? chatAssistantMessage : undefined, earlier: source === "chat" ? earlier.reverse() : undefined, task: source === "chat" ? undefined : judgeContext });
      audit(tool, `judge-${judged.decision}`, source, { reason: judged.reason, mode: settings.autoApprove, ...g?.facts });
      if (mayAutoApprove(settings.autoApprove, source, judged)) {
        audit(tool, "auto-approved", source, { reason: judged.reason }); // silent on purpose: logged, never announced (npm run report shows them)
        if (onceOnly) remember(key);
        return { behavior: "allow", updatedInput: g?.input ?? input };
      }
    }
    if ((failures.get(key) ?? 0) >= MAX_FAILED_ASKS) {
      audit(tool, "deny-reask-cap", source);
      return { behavior: "deny", message: `Asking ${OWNER} about this exact call failed ${MAX_FAILED_ASKS} times, so it is not asked again. Do not retry it; tell ${OWNER} in your own words what you could not do, and drop it unless they bring it up again.` };
    }
    audit(tool, "ask-sent", source); // logged before the wait, so a stuck approval is visible
    const d = await approve(description, { tool, input: g?.redacted ?? input }, signal, g?.payment ? { typedYes: true } : undefined);
    if (d.failure) {
      failures.set(key, (failures.get(key) ?? 0) + 1);
      audit(tool, "ask-failed", source, { reason: d.failure });
      return { behavior: "deny", message: `The approval could not be confirmed: ${d.failure}. Nothing was executed.${d.feedback ? ` ${OWNER} had replied: ${JSON.stringify(d.feedback)}.` : ""} Decide yourself: ask ${OWNER} again in your own words (at most ${MAX_FAILED_ASKS - (failures.get(key) ?? 0)} more time(s) for this call), rephrase the request, or drop the action.` };
    }
    failures.delete(key);
    if (judged) audit(tool, "judge-vs-owner", source, { judge: judged.decision, ownerApproved: d.approved });
    audit(
      tool,
      d.approved ? (d.updatedInput ? "ask-approved-modified" : "ask-approved") : d.feedback ? "ask-feedback" : "ask-declined",
      source,
    );
    if (d.approved && onceOnly) remember(key);
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
