import { budgetSpent } from "../core/budget.ts";
import { lookState, notesChangedAt, type LookState } from "../conversation/ledger.ts";
import { createHeartbeatLook, type HeartbeatDeps } from "./look.ts";
import { listGroups } from "../conversation/groupstore.ts";
import { group, owner, tenant, type Conversation, type Pipeline } from "../conversation/conversation.ts";
import { allows } from "../policy/capabilities.ts";
import { isRefusal, mayRun, type Payer, type Refusal } from "../tenants/payer.ts";
import { ledgerEntries, logSignature } from "../core/messages.ts";
import { isPaused } from "../core/pause.ts";
import { listTenants } from "../tenants/tenants.ts";
import { settings } from "../core/settings.ts";
import { runGate } from "../core/rungate.ts";
import { noticeBudget, noticeDamaged, releaseHeld } from "./notices.ts";
import { closeIdleConvDbs } from "../core/convdb.ts";
import { fireReminders } from "./remindtick.ts";
import { claimPreps } from "./preptick.ts";

// The clock of every conversation's own initiative. On every tick (a free timer, no model), for the owner's chat, every group the owner is in and every tenant (TENANTS=on)
// whose next look has come (or where something was said or a note changed since the last look), ONE thing happens, the same for all of them: the HEARTBEAT RUN
// (heartbeat/look.ts). It is one Haiku run with the conversation's own persona, notes, tools and approver; it looks at the chat log and whatever the conversation can read
// (mail, calendar, tasks), acts through the normal floor, judge and phone, and answers with a message or [[silent]] and its next look (10..120 minutes). Which tools and
// skills it has, whether it may call the expert and whether there is anything to look at at all is the conversation's capability set (capabilities.ts), not its kind.
//   a tenant  is looked in on only with the capabilities `heartbeat` and `wake` (a friend has both, unless the instance switches one off), while she is active, the key is out of a cooldown and
//             she is within her day's budget; the run is on the instance key, billed to her, her approvals go to her chat and the answer to her chat only
// Every model call of a look, a wake-up and a compaction asks payer.ts mayRun first (paused, the usage-limit cooldown, the day's budget; for a friend her own budget and the shared
// key) and runs on the Payer it returns: no per-conversation branches here.
// The model decides; THESE are the guards, in code: pause, the daily budget (budgetSpent: asking never uses up the owner's once-a-day notice; a tenant's own day is her access,
// tenantrun.ts), the next look clamped to 10..120 minutes, and a failed run is logged and silent. Quiet hours and the day's cap are code too, in the look's post (notices.ts holds
// an unprompted post and the tick delivers what was held as one message); the owner hears of a spent budget once a day; looks that keep failing are the log's and the doctor's (the owner's own, after a long awake stretch, a fact for her next look: notices.ts).

interface WakeDeps {
  groupChats: boolean; // the messenger takes part in groups (capabilities.groups). Groups are woken only then: on Signal's Note to Self every message would go out as the owner
  pipeline: Pick<Pipeline, "enqueue" | "runTurn" | "record" | "sendWhile" | "busy"> & Partial<Pick<Pipeline, "lease">>;
  stagger?: (conv: Conversation) => number; // ms a conversation waits before its FIRST look since the process started, so a restart that finds every one due does not start them all at once (default none; main.ts startupStagger)
  sleep?: (ms: number) => Promise<void>; // (tests)
  awaitingApproval?: HeartbeatDeps["awaitingApproval"]; // (tests) default: a question of the conversation open in the chat (approvals.ts)
  vouch: (groupId: string) => Promise<boolean>; // is the owner in this group? (a group we cannot vouch for is never woken)
  run: HeartbeatDeps["run"]; // a conversation's heartbeat run (agent.ts runHeartbeat, with that conversation's approver)
  compact?: { due: (conv: Conversation) => boolean; run: (conv: Conversation) => Promise<void> }; // quiet-time compaction (chatsession.ts): `due` is a cheap look at the session file, `run` re-checks inside the queue
  groups?: () => string[]; // known group ids
  key?: () => string | undefined; // where the instance key comes from for a friend's unattended work (default settings.tenantApiKey; tests)
  tenantIds?: () => string[]; // active tenants (default: the registry)
  notesChangedAt?: (dir: string) => number;
  now?: () => Date;
  guards?: { paused: (now: Date) => boolean; budgetSpent: () => boolean }; // tests; default: the real pause switch and daily budget
  clocks?: HeartbeatDeps["clocks"]; // tests; default: Date.now and performance.now (look.ts: a run that spanned a sleep)
}

// The wait before a conversation's first look after a start: random within the tick interval, at most 5 minutes (a spread of work, not a delay of any one look). The owner's
// look does not wait at all: it goes first (and first in the run gate, rungate.ts), so the daily brief is not held up by the groups' looks after a night of sleep.
export const startupStagger = (conv?: Conversation): number => conv?.kind === "owner" ? 0 : Math.random() * Math.min(settings.heartbeatMinutes * 60_000, 5 * 60_000);

export function createWakeups(deps: WakeDeps) {
  const { pipeline } = deps;
  const clock = deps.now ?? (() => new Date());
  const paused = deps.guards?.paused ?? isPaused;
  const spent = deps.guards?.budgetSpent ?? budgetSpent;
  const changed = deps.notesChangedAt ?? notesChangedAt;
  // May this conversation's unattended work run now, and on whom? (payer.ts: the pause switch, the usage-limit cooldown, the day's budget, a friend's own budget and the key.)
  const may = (conv: Conversation, what: string): Payer | Refusal => mayRun(conv, what, { key: deps.key, paused: () => paused(clock()), spent });
  const why = (r: Refusal): string => (r.refused === "cooldown" ? "cooldown" : r.refused === "paused" ? "guarded" : "blocked");

  // Background jobs of the clock side (a conversation's quiet compaction): one per key at a time; `idle()` lets a test (or a shutdown) wait for them.
  const running = new Map<string, Promise<string>>();
  const idle = async (): Promise<string[]> => Promise.all([...running.values()]);

  // A grown conversation that has gone quiet is compacted here, in the background, so the next message does not wait for it.
  // It takes its place in the conversation's queue (a message that arrives meanwhile waits behind it, and no two runs touch the
  // session file); the tick does not wait for it, and the tick's guards (paused, over budget) have already passed.
  function quietCompact(conv: Conversation): void {
    const key = `compact:${conv.key}`;
    if (!deps.compact || running.has(key) || !deps.compact.due(conv)) return;
    if (runGate.full) return; // the run gate (rungate.ts) has no free place: a compaction that waits holds the conversation's queue, so it is left for a later tick
    if (isRefusal(may(conv, "compaction"))) return; // billed like any call: stops with the pause switch, the cooldown and the budget (hers: the key and her own budget)
    const run = deps.compact.run;
    const job = pipeline.enqueue(conv, () => run(conv)).then(
      () => "compact-done",
      (e) => (console.error(`wake: ${conv.kind} compaction failed:`, (e as Error).message), "compact-failed"),
    );
    running.set(key, job);
    void job.finally(() => running.delete(key));
  }

  // The ledger's reading, remembered while the log file is unchanged (same stat): an idle tick then costs one stat per conversation, not a read and parse of its whole log.
  const states = new Map<string, { sig: string; st: LookState }>();
  function stateOf(conv: Conversation): LookState {
    const sig = logSignature(conv.logFile);
    const hit = states.get(conv.key);
    if (hit && sig && hit.sig === sig) return hit.st;
    const st = lookState(ledgerEntries(conv.logFile));
    if (sig) states.set(conv.key, { sig, st });
    else states.delete(conv.key);
    return st;
  }

  const heartbeat = createHeartbeatLook({ pipeline, run: deps.run, may, why, notesChangedAt: changed, awaitingApproval: deps.awaitingApproval, clocks: deps.clocks });

  // One conversation, one look. Returns what happened (for the log and tests).
  async function look(conv: Conversation, now: Date): Promise<string> {
    if (!allows(conv, "heartbeat") || !allows(conv, "wake")) return "not-allowed"; // its capability set decides (a tenant's record); nothing for it without both
    return heartbeat.look(conv, stateOf(conv), now);
  }

  // Every conversation looks on its own: a slow brief or a failing group never delays another conversation.
  const busy = new Set<string>();
  const started = new Set<string>(); // conversations that have had their first look since the process started (or since the Mac last slept: slept())
  let epoch = 0; // raised when the Mac sleeps: a conversation still napping before its first look is dropped (it is still due; the next tick starts it)
  const nap = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));
  async function tick(now = clock()): Promise<void> {
    if (paused(now)) return;
    if (spent()) noticeBudget(now); // the owner's one notice of the day: background work stops until midnight (budget.ts overBudget says whether it is the first)
    noticeDamaged(now); // a conversation whose assistant.db was set aside: the owner is told once a day until a person looks (core/convdb.ts)
    closeIdleConvDbs(now.getTime()); // connections nobody used for a while (a store reopens one at its next use)
    const convs: Conversation[] = [owner()]; // (each conversation asks mayRun: the instance's day budget is the owner's and the groups', a friend's is her own)
    const remind: Conversation[] = [convs[0]!]; // who has reminders: every conversation with tasks and a database, whatever its heartbeat or WAKEUPS say (they cost no model); the pause switch above still stops them
    const wake = settings.wakeups && deps.groupChats;
    if (deps.groupChats) {
      const ids = (deps.groups ?? (() => listGroups().map((g) => g.id)))();
      const vouched = await Promise.all(ids.map((id) => deps.vouch(id).catch(() => false))); // in parallel; a lookup is cached for minutes
      ids.forEach((id, i) => {
        if (!vouched[i]) return;
        const g = group(id);
        remind.push(g);
        if (wake) convs.push(g);
      });
    }
    if (settings.tenants) {
      for (const id of (deps.tenantIds ?? (() => listTenants().filter((r) => r.status === "active").map((r) => r.id)))()) {
        try {
          const conv = tenant(id);
          if (allows(conv, "tasks")) remind.push(conv);
          if (wake && allows(conv, "heartbeat")) convs.push(conv); // the tick is her heartbeat: without it nothing of hers is looked at
        } catch (e) {
          console.error("wake: a tenant could not be looked at:", (e as Error).message);
        }
      }
    }
    if (wake) for (const key of states.keys()) if (!convs.some((c) => c.key === key)) states.delete(key); // groups and tenants that are gone
    await Promise.all(remind.map(async (conv) => void (paused(clock()) || (await fireReminders(pipeline, conv, clock(), { looks: convs.includes(conv) && allows(conv, "heartbeat") && allows(conv, "wake") }))))); // reminders that have come due (heartbeat/remindtick.ts): claimed for the conversation's look, which says them; the fixed line only without a look
    await Promise.all(
      convs.map(async (conv) => {
        if (paused(clock())) return;
        quietCompact(conv);
        claimPreps(conv, clock()); // meetings the look recorded that start within PREP_MINUTES (preptick.ts): claimed, which makes the look due now; the look prepares and says them
        if (busy.has(conv.key)) return;
        busy.add(conv.key);
        const mine = epoch;
        try {
          await releaseHeld(pipeline, conv, clock()); // what quiet hours or the day's cap held back goes out now, as one message
          if (!started.has(conv.key)) {
            started.add(conv.key);
            const ms = deps.stagger?.(conv) ?? 0;
            if (ms > 0) await nap(ms);
            if (paused(clock()) || mine !== epoch) return;
          }
          await look(conv, clock());
        } catch (e) {
          console.error(`wake: ${conv.kind} look failed:`, (e as Error).message);
        } finally {
          busy.delete(conv.key);
        }
      }),
    );
  }

  // The Mac slept (heartbeat.ts): the connections of every look in flight are dead, so they are stopped (those still waiting for a place in the run gate never start), and
  // the conversations take their staggered first look again, as after a restart (stagger above), so waking up does not start a dozen runs together. Everything stopped is still due and
  // is started again by the normal due-check. Returns how many runs were stopped.
  function slept(): number {
    epoch++;
    started.clear();
    return heartbeat.abortAll("the Mac slept");
  }

  return { tick, look, idle, slept };
}