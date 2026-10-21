import { audit, wordless, type Source } from "../core/audit.ts";
import { isTenantKey } from "../core/ownerkey.ts";
import { OWNER, settings } from "../core/settings.ts";
import { noteDeclined } from "./declined.ts";
import { judgeAnswer } from "./approvalmodel.ts";
import type { OpenView } from "./approvalprompt.ts";
import { addExpired, addPending, clearPending, markSent, openItems, sweepExpired, takeExpired, takeItems, type Pending } from "./pending.ts";
import { doneLine, expiryLine, failedLine, queuedResult, renderBatch, renderList } from "./pendingbatch.ts";
import { parseNumbered } from "./pendingparse.ts";
import { recentIn } from "./recentchat.ts";

// The approval inbox, end to end (docs/SAFETY.md, Approvals). An unattended run that needs a yes no longer waits for it: its call is PARKED here (queueCall), the tool call returns
// to the run at once and the run goes on. The parked calls of one look are asked as ONE numbered message when the look ends (or when the first is a few minutes old), held for the
// morning in quiet hours (notices.ts); the owner answers by number ("1,3 yes", read by code, pendingparse.ts) or by replying to the message; a yes runs EXACTLY the recorded call in a
// small follow-up run (run/pendingrun.ts, approvals/pendingexec.ts) and the result is reported in chat. Everything is audited. Foreground (chat) approvals do not come here.

const BATCH_WAIT_MS = 5 * 60_000; // a parked call is asked at the latest this long after it was parked, even if its look is still running

export interface PendingRuntime {
  send(scope: string, text: string): Promise<number>; // the conversation's chat; resolves the sent message's timestamp
  hold(scope: string, text: string, urgent: boolean, now: Date): boolean; // heartbeat/notices.ts submitPost: true = held (quiet hours, the day's cap) and delivered later with the rest
  execute(scope: string, item: Pending): Promise<{ ran: boolean; line: string }>; // the follow-up run of exactly this call (run/pendingrun.ts)
  now?: () => Date;
}
let rt: PendingRuntime | undefined;
export const setPendingRuntime = (r: PendingRuntime | undefined): void => void (rt = r);
const clock = (): Date => rt?.now?.() ?? new Date();

// A friend's rows carry no words (audit.ts): the admin's audit log is not hers to put words in.
const rows = (scope: string, meta: Record<string, unknown>) => (isTenantKey(scope) ? wordless(meta) : meta);
const log = (p: Pick<Pending, "tool" | "scope" | "source">, decision: string, meta: Record<string, unknown> = {}): void => audit(p.tool, decision, p.source, rows(p.scope, meta));

// ---- parking ----

export interface QueueInput {
  tool: string;
  input: Record<string, unknown>;
  label: string;
  question: string;
  footer: string;
  source: Source;
  urgent?: boolean;
}
// Park the call. Returns the text the run's tool call gets back (permissions.ts), or undefined when the inbox is full (the caller then denies the call).
export function queueCall(scope: string, q: QueueInput, now: Date = clock()): { n: number; message: string } | undefined {
  const r = addPending(scope, { tool: q.tool, input: structuredClone(q.input), label: q.label, question: q.question, footer: q.footer, source: q.source, urgent: q.urgent }, now.getTime());
  if ("full" in r) return void log({ tool: q.tool, scope, source: q.source }, "approval-queue-full");
  if (!r.duplicate) log({ tool: q.tool, scope, source: q.source }, "approval-queued", { n: r.n, args: q.input, question: q.question, details: q.label });
  arm(scope);
  return { n: r.n, message: queuedResult(r.n, OWNER) };
}

// A look that is still running when the first parked call is a few minutes old asks them anyway.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
function arm(scope: string): void {
  if (timers.has(scope)) return;
  const t = setTimeout(() => {
    timers.delete(scope);
    void flushPending(scope, { ended: false }).catch((e) => console.error("approval inbox: could not ask:", (e as Error).message));
  }, BATCH_WAIT_MS);
  t.unref();
  timers.set(scope, t);
}

// ---- asking ----

// Deliver a text now or, in quiet hours / past the day's cap, via notices.ts's hold.
async function deliver(scope: string, text: string, urgent: boolean, now: Date): Promise<{ held: boolean; ts?: number }> {
  if (!rt) throw new Error("approval inbox: no runtime set");
  if (rt.hold(scope, text, urgent, now)) return { held: true };
  return { held: false, ts: await rt.send(scope, text) };
}

const flushing = new Set<string>();
// Ask what is parked and not yet asked, as ONE numbered message, and tell what expired. `ended`: the look has finished (ask now); otherwise only when the first one is old enough.
export async function flushPending(scope: string, o: { ended: boolean }): Promise<"sent" | "held" | "none"> {
  if (!rt || flushing.has(scope)) return "none";
  flushing.add(scope);
  try {
    const now = clock();
    const dropped = sweepExpired(scope, now.getTime());
    for (const p of dropped) log(p, "approval-expired", { n: p.n, ageDays: settings.pendingActionDays });
    const told = takeExpired(scope);
    if (told.length) {
      try {
        await deliver(scope, expiryLine(told, settings.pendingActionDays), false, now);
      } catch (e) {
        console.error("approval inbox: could not tell what expired:", (e as Error).message);
        addExpired(scope, told); // not silent: said at the next flush
      }
    }
    const unsent = openItems(scope).filter((p) => !p.sent);
    if (unsent.length === 0) return "none";
    const oldest = Math.min(...unsent.map((p) => p.createdAt));
    if (!o.ended && now.getTime() - oldest < BATCH_WAIT_MS) return arm(scope), "none"; // (not old enough yet: looked at again)
    const timer = timers.get(scope);
    if (timer) (clearTimeout(timer), timers.delete(scope));
    const ns = unsent.map((p) => p.n);
    try {
      const r = await deliver(scope, renderBatch(unsent), unsent.some((p) => p.urgent), now);
      markSent(scope, ns, { at: now.getTime(), ...(r.held ? { held: true as const } : { ts: r.ts }) });
      for (const p of unsent) log(p, r.held ? "approval-batch-held" : "approval-batch-sent", { n: p.n });
      return r.held ? "held" : "sent";
    } catch (e) {
      console.error("approval inbox: could not ask:", (e as Error).message);
      arm(scope); // not lost: asked again in a few minutes
      return "none";
    }
  } finally {
    flushing.delete(scope);
  }
}

// ---- answering ----

export interface PendingAnswer {
  outcome: "approved" | "declined" | "clarify";
  reply?: string;
}
export interface PendingDeps {
  judge?: typeof judgeAnswer;
  recent?: (reply: string) => { from: "owner" | "assistant"; text: string }[];
}

const SEVERAL = "Which ones? Say e.g. '1,3 yes', 'all yes' or '2 no'; nothing was done.";

// Is this message an answer to the approval inbox of its conversation? undefined = it is not (the usual approval and chat paths go on). A bare unquoted yes / ok never is (SAFETY.md);
// an edit of a message never reaches here (intake.ts skips edits for every approval answer). `quote`: the message it replies to, if any.
export async function answerPending(text: string, quote: { timestamp: number } | undefined, ctx: { scope: string; by?: string; voice?: boolean }, deps: PendingDeps = {}): Promise<PendingAnswer | undefined> {
  const items = openItems(ctx.scope);
  if (items.length === 0) return undefined;
  const open = items.map((p) => p.n);
  const ts = quote && quote.timestamp !== 0 ? quote.timestamp : undefined;
  const inBatch = ts === undefined ? [] : items.filter((p) => p.sent?.ts === ts);
  // A quote of some other message says the reply is about that message, unless a batch went out held (its timestamp is not known) and this could be it.
  if (ts !== undefined && inBatch.length === 0 && items.every((p) => p.sent?.ts !== undefined || !p.sent)) return undefined;
  const parsed = parseNumbered(text, open);
  if (parsed.kind === "clarify") return { outcome: "clarify", reply: parsed.why };
  if (parsed.kind === "bare") {
    if (inBatch.length === 0) return undefined; // a bare yes / ok that quotes none of the batch is about something else
    if (inBatch.length > 1) return { outcome: "clarify", reply: SEVERAL };
    return settle(ctx, [{ item: inBatch[0]!, yes: parsed.yes }], text);
  }
  if (parsed.kind === "answer") {
    const by = new Map(items.map((p) => [p.n, p]));
    return settle(ctx, [...parsed.yes.map((n) => ({ item: by.get(n)!, yes: true })), ...parsed.no.map((n) => ({ item: by.get(n)!, yes: false }))], text);
  }
  // Free words that quote the batch: the answer model reads them (the same one as for every approval), and only a plain yes / no per item counts.
  if (inBatch.length === 0 || !text.trim()) return undefined;
  const views: OpenView[] = inBatch.map((p, i) => ({ id: `A${i + 1}`, background: true, ageMs: clock().getTime() - p.createdAt, question: `${p.label}: ${p.question}` }));
  const j = await (deps.judge ?? judgeAnswer)(text, views, (deps.recent ?? ((r) => recentIn(ctx.scope, r)))(text), { id: undefined, voice: ctx.voice });
  const ids = new Map(inBatch.map((p, i) => [`A${i + 1}`, p]));
  const parts = !j ? [] : j.outcome === "multi" ? (j.answers ?? []) : j.outcome === "approve" || j.outcome === "decline" ? [{ target: j.target, outcome: j.outcome }] : [];
  const picks = parts.flatMap((a) => {
    const item = ids.get(a.target);
    return item && (a.outcome === "approve" || a.outcome === "decline") ? [{ item, yes: a.outcome === "approve" }] : [];
  });
  if (!j || j.outcome === "unrelated") return undefined;
  if (picks.length === 0 || picks.length !== parts.length) return { outcome: "clarify", reply: SEVERAL };
  return settle(ctx, picks, text);
}

// Apply the decisions: a no is final (declined.ts), a yes starts the follow-up run of exactly that call. The reply says what was understood.
function settle(ctx: { scope: string; by?: string }, picks: readonly { item: Pending; yes: boolean }[], reply: string): PendingAnswer {
  const taken = new Map(takeItems(ctx.scope, picks.map((p) => p.item.n)).map((p) => [p.n, p]));
  const yes: Pending[] = [];
  const no: Pending[] = [];
  for (const p of picks) {
    const item = taken.get(p.item.n);
    if (!item) continue; // resolved meanwhile
    log(item, p.yes ? "approval-queue-approved" : "approval-queue-declined", { n: item.n, by: ctx.by, reply });
    if (p.yes) yes.push(item);
    else {
      noteDeclined(item.scope, item.tool, item.input, clock().getTime());
      no.push(item);
    }
  }
  if (yes.length + no.length === 0) return { outcome: "clarify", reply: "Those were already settled. /approvals shows what is still open." };
  for (const item of yes) enqueueRun(item);
  const said = [yes.length ? `On it: ${yes.map((p) => `#${p.n}`).join(", ")}.` : "", no.length ? `Dropped: ${no.map((p) => `#${p.n}`).join(", ")}.` : ""].filter(Boolean).join(" ");
  return { outcome: yes.length ? "approved" : "declined", reply: said };
}

// One follow-up run at a time per conversation, in the order approved; the result is told in chat. Never throws.
const chains = new Map<string, Promise<void>>();
function enqueueRun(item: Pending): void {
  const next = (chains.get(item.scope) ?? Promise.resolve()).then(async () => {
    let line: string;
    let ok = false;
    try {
      if (!rt) throw new Error("not available");
      const r = await rt.execute(item.scope, item);
      ok = r.ran;
      line = r.line;
    } catch (e) {
      line = (e as Error).message || "the run failed";
    }
    log(item, ok ? "approval-queue-executed" : "approval-queue-failed", { n: item.n, result: line });
    try {
      await rt?.send(item.scope, ok ? doneLine(item.n, line) : failedLine(item.n, line));
    } catch (e) {
      console.error("approval inbox: could not report:", (e as Error).message);
    }
  });
  chains.set(item.scope, next);
  void next.finally(() => chains.get(item.scope) === next && chains.delete(item.scope));
}
export const idle = (): Promise<void> => Promise.all([...chains.values()]).then(() => undefined); // tests

// ---- /approvals ----

export function listText(scope: string, now: number = clock().getTime()): string {
  sweepExpired(scope, now);
  const items = openItems(scope);
  const unsent = items.filter((p) => !p.sent).map((p) => p.n);
  if (unsent.length) markSent(scope, unsent, { at: now }); // listed: shown now, so the batch does not repeat it
  return renderList(items, now);
}
export function clearText(scope: string): string {
  const gone = clearPending(scope);
  for (const p of gone) log(p, "approval-queue-cleared", { n: p.n });
  return gone.length ? `Dropped ${gone.length} waiting ${gone.length === 1 ? "action" : "actions"} (${gone.map((p) => `#${p.n}`).join(", ")}). Nothing was run.` : "Nothing was waiting.";
}
export const waitingCount = (scope: string): number => openItems(scope).length;
