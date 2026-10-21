import { audit, readAudit, wordless, type Source } from "../core/audit.ts";
import { isTenantKey } from "../core/ownerkey.ts";
import { settings } from "../core/settings.ts";
import { argsForAudit } from "./auditargs.ts";
import { noteDeclined } from "./declined.ts";
import { judgeAnswer } from "./approvalmodel.ts";
import type { OpenView } from "./approvalprompt.ts";
import { addExpired, addPending, clearPending, finishItem, interrupt, markDeferred, markExecuting, markSent, recordDone, setRetry, openItems as allItems, sweepExpired, takeExpired, takeItems, type Pending } from "./pending.ts";
import { compactFooter, detailsHash, doneLine, expiryLine, failedLine, labelOf, queuedResult, renderBatch, renderList } from "./pendingbatch.ts";
import { approverName } from "./pendingexec.ts";
import { parseNumbered } from "./pendingparse.ts";
import { recentIn } from "./recentchat.ts";

// The approval inbox, end to end (docs/SAFETY.md, Approvals). An unattended run that needs a yes no longer waits for it: its call is PARKED here (queueCall), the tool call returns
// to the run at once and the run goes on. The parked calls of one look are asked as ONE numbered message when the look ends (or when the first is a few minutes old), held for the
// morning in quiet hours (notices.ts); the owner answers by number ("1,3 yes", read by code, pendingparse.ts) or by replying to the message; a yes runs EXACTLY the recorded call in a
// small follow-up run (run/pendingrun.ts, approvals/pendingexec.ts) and the result is reported in chat. Everything is audited. Foreground (chat) approvals do not come here.

const BATCH_WAIT_MS = 5 * 60_000; // a parked call is asked at the latest this long after it was parked, even if its look is still running

export interface PendingRuntime {
  send(scope: string, text: string): Promise<number>; // the conversation's chat; resolves the sent message's timestamp
  holding(scope: string, now: Date): boolean; // heartbeat/notices.ts holdingNow: is the conversation being left alone now (quiet hours, its /quiet)? The batch then waits in the inbox itself (never in the held posts: it must not go stale, be merged into a digest or count toward the day's cap)
  details?(scope: string, item: Pending): Promise<string | undefined>; // the call's code-rendered details read again now (permissions.ts renderDetails); compared with the hash taken at asking time
  execute(scope: string, item: Pending): Promise<{ ran: boolean; line: string; refused?: string }>; // the follow-up run of exactly this call (run/pendingrun.ts); `refused`: the run gate said not now (pause, budget, cooldown...), nothing was tried
  canRun?(scope: string): string | undefined; // the reason the run gate would refuse an approved item now, or undefined when it would run (the tick retries a refused item by this)
  now?: () => Date;
}
let rt: PendingRuntime | undefined;
export const setPendingRuntime = (r: PendingRuntime | undefined): void => void (rt = r);
const clock = (): Date => rt?.now?.() ?? new Date();
const running = new Set<string>(); // follow-up runs of THIS process: "scope#n"
const busy = (p: Pending): boolean => !!p.executing || !!p.retry; // approved already: running now, or waiting for the run gate
const openItems = (scope: string): Pending[] => allItems(scope).filter((p) => !busy(p)); // what a yes can still apply to

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
  detailsHash?: string;
  source: Source;
  urgent?: boolean;
}
// Park the call. Returns the text the run's tool call gets back (permissions.ts), or undefined when the inbox is full (the caller then denies the call).
export function queueCall(scope: string, q: QueueInput, now: Date = clock()): { n: number; message: string } | undefined {
  const r = addPending(scope, { tool: q.tool, input: structuredClone(q.input), label: q.label, question: q.question, footer: q.footer, detailsHash: q.detailsHash, source: q.source, urgent: q.urgent }, now.getTime());
  if ("full" in r) return void log({ tool: q.tool, scope, source: q.source }, "approval-queue-full");
  if ("blocked" in r) {
    // The same call was done (the next look proposes it anew), or expired unanswered a moment ago: it is not parked again, and the run is told why.
    const b = r.blocked;
    log({ tool: q.tool, scope, source: q.source }, "approval-queue-repeat-refused", { n: b.n, kind: b.kind });
    return { n: b.n, message: b.kind === "done" ? `That exact call was already done on ${new Date(b.at).toISOString().slice(0, 10)} (as #${b.n}). Do not repeat it.` : `That exact call was queued earlier (#${b.n}) and not answered in time, so it is not queued again for 24 hours. Do not retry it now.` };
  }
  if (!r.duplicate) log({ tool: q.tool, scope, source: q.source }, "approval-queued", { n: r.n, args: argsForAudit(q.input), question: q.question, details: q.label });
  arm(scope);
  return { n: r.n, message: queuedResult(r.n, approverName(scope)) };
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

// A plain line or message in the conversation's chat (the batch is held back by flushPending itself, in quiet hours).
async function deliver(scope: string, text: string): Promise<number> {
  if (!rt) throw new Error("approval inbox: no runtime set");
  return rt.send(scope, text);
}

const flushing = new Set<string>();
// Ask what is parked and not yet asked, as ONE numbered message, and tell what expired. `ended`: the look has finished (ask now); otherwise only when the first one is old enough.
export async function flushPending(scope: string, o: { ended: boolean }): Promise<"sent" | "held" | "none"> {
  if (!rt || flushing.has(scope)) return "none";
  flushing.add(scope);
  try {
    const now = clock();
    const waiting = openItems(scope).filter((p) => !p.sent);
    // Quiet hours or /quiet: the batch waits HERE, untouched (an urgent item breaks it). It is not a held post (notices.ts): those are dropped as stale when the owner writes, merged into a digest
    // and counted toward the day's cap. When quiet ends the tick asks, from the then current items, as its own message.
    if (rt.holding(scope, now) && !waiting.some((p) => p.urgent)) {
      const fresh = waiting.filter((p) => !p.deferred);
      if (fresh.length) {
        markDeferred(scope, fresh.map((p) => p.n));
        for (const p of fresh) log(p, "approval-batch-held", { n: p.n });
      }
      return waiting.length ? "held" : "none";
    }
    const lost = recoverStuck(scope);
    if (lost.length) {
      try {
        await deliver(scope, lost.join("\n"));
      } catch (e) {
        console.error("approval inbox: could not tell what was interrupted:", (e as Error).message); // (the list marks them)
      }
    }
    const dropped = sweepExpired(scope, now.getTime());
    for (const p of dropped) log(p, "approval-expired", { n: p.n, ageDays: settings.pendingActionDays });
    const told = takeExpired(scope);
    if (told.length) {
      try {
        await deliver(scope, expiryLine(told, settings.pendingActionDays));
      } catch (e) {
        console.error("approval inbox: could not tell what expired:", (e as Error).message);
        addExpired(scope, told); // not silent: said at the next flush
      }
    }
    // Approved items the run gate refused earlier: run now if it would let them (it was approved; this is not a new question).
    if (!rt.canRun?.(scope)) for (const p of allItems(scope).filter((x) => x.retry && !x.executing && !running.has(`${scope}#${x.n}`))) for (const m of markExecuting(scope, [p.n], now.getTime())) enqueueRun(m);
    const unsent = openItems(scope).filter((p) => !p.sent); // (read again: what was answered or dropped meanwhile is gone)
    if (unsent.length === 0) return "none";
    const oldest = Math.min(...unsent.map((p) => p.createdAt));
    if (!o.ended && !unsent.some((p) => p.deferred) && now.getTime() - oldest < BATCH_WAIT_MS) return arm(scope), "none"; // (not old enough yet: looked at again)
    const timer = timers.get(scope);
    if (timer) (clearTimeout(timer), timers.delete(scope));
    const ns = unsent.map((p) => p.n);
    try {
      const ts = await deliver(scope, renderBatch(unsent));
      markSent(scope, ns, { at: now.getTime(), ts }); // the message's timestamp: a reply that quotes it is an answer, also after a night's wait
      for (const p of unsent) log(p, "approval-batch-sent", { n: p.n, afterHold: !!p.deferred });
      return "sent";
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
  const everything = allItems(ctx.scope);
  if (everything.length === 0) return undefined;
  const items = openItems(ctx.scope);
  // Only what was SHOWN can be answered by "all" or a range: an item still waiting for its batch (or kept back for quiet hours) was never put in front of the owner. It can be named, and is then refused.
  const shown = items.filter((p) => p.sent);
  const unshown = items.filter((p) => !p.sent).map((p) => p.n);
  const ts = quote && quote.timestamp !== 0 ? quote.timestamp : undefined;
  const inBatch = ts === undefined ? [] : shown.filter((p) => p.sent?.ts === ts);
  // A quote of some other message says the reply is about that message, unless a batch went out held (its timestamp is not known) and this could be it.
  if (ts !== undefined && inBatch.length === 0 && shown.every((p) => p.sent?.ts !== undefined)) return undefined;
  const approved = everything.filter(busy); // approved already: running now, or waiting for the run gate: numbers too, but a second yes would do nothing
  const known = [...items.map((p) => p.n), ...approved.map((p) => p.n)].sort((x, y) => x - y);
  const all = inBatch.length ? inBatch.map((p) => p.n) : shown.map((p) => p.n); // what "all" stands for: the quoted batch, else everything shown
  const parsed = parseNumbered(text, known, all);
  if (parsed.kind === "clarify") return { outcome: "clarify", reply: parsed.why };
  if (parsed.kind === "bare") {
    if (inBatch.length === 0) return undefined; // a bare yes / ok that quotes none of the batch is about something else
    if (inBatch.length > 1) return { outcome: "clarify", reply: SEVERAL };
    return settle(ctx, [{ item: inBatch[0]!, yes: parsed.yes }], text);
  }
  if (parsed.kind === "answer") {
    const named = [...parsed.yes, ...parsed.no];
    const hidden = named.filter((n) => unshown.includes(n));
    if (hidden.length) return { outcome: "clarify", reply: `${hidden.map((n) => `#${n}`).join(", ")} ${hidden.length === 1 ? "hasn't" : "haven't"} been shown to you yet. Nothing was done.` };
    const by = new Map(shown.map((p) => [p.n, p]));
    const running = approved.filter((p) => named.includes(p.n));
    const note = running.length ? running.map((p) => (p.executing ? `${`#${p.n}`} is already running; I'll report when it's done.` : `#${p.n} is approved and waiting to run; I'll do it when it can.`)).join(" ") : "";
    const picks = [...parsed.yes.filter((n) => by.has(n)).map((n) => ({ item: by.get(n)!, yes: true })), ...parsed.no.filter((n) => by.has(n)).map((n) => ({ item: by.get(n)!, yes: false }))];
    if (picks.length === 0) return { outcome: "clarify", reply: note || undefined };
    const done = settle(ctx, picks, text);
    return note ? { ...done, reply: [done.reply, note].filter(Boolean).join(" ") } : done;
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
  const noN = picks.filter((p) => !p.yes).map((p) => p.item.n);
  const gone = new Map(takeItems(ctx.scope, noN).map((p) => [p.n, p]));
  const marked = new Map(markExecuting(ctx.scope, picks.filter((p) => p.yes).map((p) => p.item.n), clock().getTime()).map((p) => [p.n, p])); // (kept in the file until its run ends: a crash in between is noticed)
  const yes: Pending[] = [];
  const no: Pending[] = [];
  for (const p of picks) {
    const item = p.yes ? marked.get(p.item.n) : gone.get(p.item.n);
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

// One follow-up run at a time per conversation, in the order approved; the result is told in chat. Never throws. Before it runs, the call's details are read again: if they are not what the
// owner approved (a draft edited since), NOTHING runs and the current version is parked as a new item.
const chains = new Map<string, Promise<void>>();
function enqueueRun(item: Pending): void {
  const id = `${item.scope}#${item.n}`;
  running.add(id);
  const next = (chains.get(item.scope) ?? Promise.resolve()).then(async () => {
    let line: string;
    let ok = false;
    let said: string | undefined;
    let refused: string | undefined;
    try {
      if (!rt) throw new Error("not available");
      const changed = await drift(item);
      if (changed) said = changed;
      else {
        const r = await rt.execute(item.scope, item);
        ok = r.ran;
        line = r.line;
        refused = r.refused;
      }
    } catch (e) {
      line = (e as Error).message || "the run failed";
    }
    line ??= "";
    if (refused !== undefined) {
      // The run gate said not now: the item was approved, so it stays approved and waiting; the tick runs it when the gate allows (flushPending). Said once.
      const first = !item.retry?.told;
      setRetry(item.scope, item.n, true);
      log(item, "approval-queue-waiting", { n: item.n, scope: item.scope, why: refused });
      running.delete(id);
      if (first) await rt?.send(item.scope, `#${item.n} is approved but can't run right now (${refused}); I'll do it when it can.`).catch((e) => console.error("approval inbox: could not report:", (e as Error).message));
      return;
    }
    // A friend's words (what her follow-up run said) never reach the admin's audit log: only that it ran or not.
    if (said === undefined) log(item, ok ? "approval-queue-executed" : "approval-queue-failed", { n: item.n, scope: item.scope, ok, ...(isTenantKey(item.scope) ? {} : { result: line }) });
    if (ok) recordDone(item.scope, item.tool, item.input, item.n, clock().getTime());
    finishItem(item.scope, item.n);
    running.delete(id);
    try {
      await rt?.send(item.scope, said ?? (ok ? doneLine(item.n, line) : failedLine(item.n, line)));
    } catch (e) {
      console.error("approval inbox: could not report:", (e as Error).message);
    }
  });
  chains.set(item.scope, next);
  void next.finally(() => chains.get(item.scope) === next && chains.delete(item.scope));
}
export const forgetRuns = (): void => (chains.clear(), running.clear()); // tests: the process "restarts"
export const idle = (): Promise<void> => Promise.all([...chains.values()]).then(() => undefined); // tests

// Compare the details now with the ones the owner was shown. Returns the message to send instead of running (the call is not made), or undefined when they are the same.
async function drift(item: Pending): Promise<string | undefined> {
  if (!item.detailsHash || !rt?.details) return undefined;
  const fresh = await rt.details(item.scope, item).catch(() => undefined);
  if (fresh === undefined) {
    log(item, "approval-queue-changed", { n: item.n, scope: item.scope, unreadable: true });
    return `⚠️ #${item.n} was not run: what it refers to can no longer be read (the draft may be gone).`;
  }
  if (detailsHash(fresh) === item.detailsHash) return undefined;
  finishItem(item.scope, item.n); // (the old number is closed; the same call comes back under a new one)
  const r = addPending(item.scope, { tool: item.tool, input: item.input, label: labelOf(fresh), question: `#${item.n} changed since you approved it; here is the current version.`, footer: compactFooter(fresh), detailsHash: detailsHash(fresh), source: item.source, urgent: item.urgent }, clock().getTime());
  if ("full" in r || "blocked" in r) return `⚠️ #${item.n} changed since you approved it, so nothing was run, and the inbox is full. Ask again once there is room.`;
  markSent(item.scope, [r.n], { at: clock().getTime() });
  log(item, "approval-queue-changed", { n: item.n, scope: item.scope, newN: r.n });
  const fresher = allItems(item.scope).find((p) => p.n === r.n)!;
  return `⚠️ #${item.n} changed since you approved it, so nothing was run. Here is the current version as #${r.n}:\n${renderBatch([fresher]).split("\n").slice(1).join("\n")}`;
}

// An item still marked as running that this process is not running: the process stopped while doing it. If the audit log has a row saying it finished, it is simply done; otherwise it may not
// have run and is NEVER retried by itself (the call may have happened): it goes back to waiting for a yes and the owner is told once.
export function recoverStuck(scope: string, active: ReadonlySet<string> = running): string[] {
  const stuck = allItems(scope).filter((p) => p.executing && !active.has(`${scope}#${p.n}`));
  const lines: string[] = [];
  for (const p of stuck) {
    const at = p.executing!.at;
    const finished = readAudit((e) => (e.decision === "approval-queue-executed" || e.decision === "approval-queue-failed") && e.meta?.n === p.n && e.meta?.scope === scope && Date.parse(e.ts) >= at - 1000, `"${p.tool}"`).length > 0;
    if (finished) {
      finishItem(scope, p.n);
      continue;
    }
    interrupt(scope, [p.n]);
    log(p, "approval-queue-interrupted", { n: p.n, scope });
    lines.push(`#${p.n} may not have run (I restarted while doing it). Reply '#${p.n} yes' to try again.`);
  }
  return lines;
}

// ---- /approvals ----

export function listText(scope: string, now: number = clock().getTime()): string {
  const lost = recoverStuck(scope);
  sweepExpired(scope, now);
  const items = allItems(scope);
  const unsent = items.filter((p) => !p.sent).map((p) => p.n);
  if (unsent.length) markSent(scope, unsent, { at: now }); // listed: shown now, so the batch does not repeat it
  return [...lost, renderList(items, now)].join("\n\n");
}
export function clearText(scope: string): string {
  const gone = clearPending(scope);
  for (const p of gone) {
    log(p, "approval-queue-cleared", { n: p.n });
    noteDeclined(p.scope, p.tool, p.input, clock().getTime()); // an explicit dismissal is a no: final like any decline (declined.ts)
  }
  return gone.length ? `Dropped ${gone.length} waiting ${gone.length === 1 ? "action" : "actions"} (${gone.map((p) => `#${p.n}`).join(", ")}). Nothing was run. Counted as a no, so they are not proposed again for now.` : "Nothing was waiting.";
}
export const waitingCount = (scope: string): number => openItems(scope).length;
// At the start (main.ts): what was running when the process stopped is looked at and told, for each conversation that has a file.
export const recoverAtStart = (scopes: readonly string[]): Promise<unknown> => Promise.all(scopes.map((s) => flushPending(s, { ended: false }).catch(() => undefined)));
