import { settings } from "../core/settings.ts";
import { startTiming } from "../core/timing.ts";
import type { Batch, Conversation, PipelineDeps } from "./conversationmodel.ts";

// The queue of every conversation: who is waiting, who runs, which unattended look is out. This module owns the three maps (bursts, tails, looks) and nothing else writes them.
export function createQueue(deps: Pick<PipelineDeps, "now" | "wait" | "settleMs" | "settleMaxMs">) {
  const now = deps.now ?? Date.now;

  // Burst handling, the same for every conversation: after each message wait a short settling pause; a newer message
  // restarts it and takes over, so a burst is ONE turn. Messages that arrive while that turn is queued join it; ones that
  // arrive while a run is in progress wait in the queue and make the next turn. Messages are kept here, in the order they came.
  // The pause is capped: once the first message of a burst has waited settleMaxSeconds, the burst is processed even if
  // people are still typing (what arrives after that joins the next turn).
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const wait = deps.wait ?? sleep;
  const bursts = new Map<string, { epoch: number; pending: unknown[]; queued: boolean; firstAt?: number }>();
  // One turn at a time per conversation: two at once would share one session. Approval answers skip this
  // (see handleIncoming): the queue is blocked on the very turn that is waiting for them.
  const tails = new Map<string, Promise<unknown>>();
  function enqueue<T>(conv: Conversation, job: () => Promise<T>): Promise<T> {
    const run = (tails.get(conv.key) ?? Promise.resolve()).then(job);
    const tail = run.catch(() => {});
    tails.set(conv.key, tail);
    void tail.then(() => tails.get(conv.key) === tail && tails.delete(conv.key));
    return run;
  }

  // Is a turn of this conversation settling, queued or running (a chat turn, a reaction, a compaction, a post)? An unattended run (the heartbeat look) does not start then: it
  // would work from a log the turn is still changing and could contradict what the turn says. It is only delayed: the free tick looks again.
  const busy = (conv: Conversation): boolean => tails.has(conv.key) || !!bursts.get(conv.key)?.pending.length;

  // The LEASE of an unattended look (heartbeat/look.ts): a look runs outside the queue (it may wait hours on an approval), so what keeps it from fighting a chat turn over the same
  // mail is this. A look is only started while the conversation is not busy (above); once it runs, a message that arrives for the conversation OVERTAKES it: the look is called
  // off, unless it is parked on an approval (the owner's answer is what it waits for; it goes on), and either way it is told there was news, so its closing message-only post
  // (which may contradict what chat now does) is dropped as stale. Only a look that is running has an entry, so nothing outlives it.
  const looks = new Map<string, { news: boolean; abort: () => void; parked: () => boolean }>();
  function lease(conv: Conversation, abort: () => void, parked: () => boolean = () => false): { news: () => boolean; end: () => void } {
    const mine = { news: false, abort, parked };
    looks.set(conv.key, mine);
    return { news: () => mine.news, end: () => void (looks.get(conv.key) === mine && looks.delete(conv.key)) };
  }
  // `written`: a message someone wrote (it may call the look off); a bare reaction only makes it news. (The look's own guard, look.ts preemptible, may still decline to abort.)
  function overtake(conv: Conversation, written = true): void {
    const mine = looks.get(conv.key);
    if (!mine) return;
    mine.news = true;
    if (written && !mine.parked()) mine.abort();
  }

  // `arrivedAt`: when the message really came in, if earlier than this call (voice transcription, group lookup).
  async function burst<T>(conv: Conversation, item: T, settled: (b: Batch<T>) => Promise<void>, arrivedAt: number = now()): Promise<void> {
    const timing = startTiming(conv.kind, now, arrivedAt);
    const st = bursts.get(conv.key) ?? { epoch: 0, pending: [], queued: false };
    bursts.set(conv.key, st);
    if (!st.pending.length) st.firstAt = now();
    st.pending.push(item);
    const mine = ++st.epoch;
    const maxMs = deps.settleMaxMs ? deps.settleMaxMs() : settings.settleMaxSeconds * 1000;
    const left = Math.max(0, maxMs - (now() - (st.firstAt ?? now())));
    await wait(Math.min(deps.settleMs ? deps.settleMs() : settings.settleSeconds * 1000, left));
    if (st.epoch !== mine || st.queued || !st.pending.length) return; // a newer message took over, or a queued run will take this one too
    timing.mark("settle");
    try {
      await settled({
        stale: () => st.epoch !== mine,
        timing,
        run: (job) => {
          st.queued = true;
          const queuedAt = now();
          return enqueue(conv, async () => {
            timing.set("queue", now() - queuedAt);
            st.queued = false;
            st.firstAt = undefined;
            const items = st.pending.splice(0) as T[];
            if (items.length) await job(items);
          });
        },
      });
    } finally {
      // Drained: this burst's last message has been settled and its turn is over (or nobody answered it: a group message the gate let pass). Nothing is waiting, so the entry goes
      // (it would otherwise stay for ever, with the unanswered messages in it, and keep `busy` true). A newer message has bumped the epoch and keeps the entry for its own burst.
      if (st.epoch === mine && !st.queued && bursts.get(conv.key) === st) bursts.delete(conv.key);
    }
  }

  // A run is already queued for the current burst, so a message arriving now joins it (no verdict of its own is needed).
  const burstQueued = (conv: Conversation): boolean => !!bursts.get(conv.key)?.queued;

  // Messages still waiting for their turn (the settling pause, or queued behind a running turn): an edit replaces one and a delete
  // removes one. Matched by timestamp: the original's or an edit's, whichever the sender's app uses.
  const stampOf = (x: unknown) => (x as { timestamp: number }).timestamp;
  const pendingOf = (conv: Conversation, stamps: readonly number[]) => bursts.get(conv.key)?.pending.find((x) => stamps.includes(stampOf(x)));
  const authorOf = (x: unknown) => (x as { author?: string; from?: string; fromUuid?: string }).author ?? (x as { from?: string }).from ?? (x as { fromUuid?: string }).fromUuid;
  function dropPending(conv: Conversation, stamps: readonly number[]): void {
    const st = bursts.get(conv.key);
    if (st) st.pending = st.pending.filter((x) => !stamps.includes(stampOf(x)));
  }

  return { enqueue, busy, lease, overtake, burst, burstQueued, wait, pendingOf, authorOf, dropPending };
}

export type Queue = ReturnType<typeof createQueue>;
