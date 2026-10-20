import { budgetSpent } from "./core/budget.ts";
import { lookState, notesChangedAt, type LookState } from "./conversation/ledger.ts";
import { createHeartbeatLook, type HeartbeatDeps } from "./heartbeat/look.ts";
import { listGroups } from "./conversation/groupstore.ts";
import { group, owner, tenant, type Conversation, type Pipeline } from "./conversation/conversation.ts";
import { allows } from "./policy/capabilities.ts";
import { isRefusal, mayRun, type Payer, type Refusal } from "./tenants/payer.ts";
import { ledgerEntries, logSignature } from "./core/messages.ts";
import { isPaused } from "./core/pause.ts";
import { listTenants } from "./tenants/tenants.ts";
import { settings } from "./core/settings.ts";

// The clock of every conversation's own initiative. On every tick (a free timer, no model), for the owner's chat, every group the owner is in and every tenant (TENANTS=on)
// whose next look has come (or where something was said or a note changed since the last look), ONE thing happens, the same for all of them: the HEARTBEAT RUN
// (heartbeat/look.ts). It is one Haiku run with the conversation's own persona, notes, tools and approver; it looks at the chat log and whatever the conversation can read
// (mail, calendar, tasks), acts through the normal floor, judge and phone, and answers with a message or [[silent]] and its next look (10..120 minutes). Which tools and
// skills it has, whether it may call the expert and whether there is anything to look at at all is the conversation's capability set (capabilities.ts), not its kind.
//   a tenant  is looked in on only with the capabilities `heartbeat` and `wake` (a friend has the first, not the second), while she is active, the key is out of a cooldown and
//             she is within her day's budget; the run is on the instance key, billed to her, her approvals go to her chat and the answer to her chat only
// Every model call of a look, a wake-up and a compaction asks payer.ts mayRun first (paused, the usage-limit cooldown, the day's budget; for a friend her own budget and the shared
// key) and runs on the Payer it returns: no per-conversation branches here.
// The model decides; THESE are the guards, in code: pause, the daily budget (budgetSpent: asking never uses up the owner's once-a-day notice; a tenant's own day is her access,
// tenantrun.ts), the next look clamped to 10..120 minutes, and a failed run is logged and silent. Quiet hours are the instruction's words, not a rule here.

interface WakeDeps {
  groupChats: boolean; // the messenger takes part in groups (capabilities.groups). Groups are woken only then: on Signal's Note to Self every message would go out as the owner
  pipeline: Pick<Pipeline, "enqueue" | "runTurn" | "record" | "sendWhile">;
  vouch: (groupId: string) => Promise<boolean>; // is the owner in this group? (a group we cannot vouch for is never woken)
  run: HeartbeatDeps["run"]; // a conversation's heartbeat run (agent.ts runHeartbeat, with that conversation's approver)
  compact?: { due: (conv: Conversation) => boolean; run: (conv: Conversation) => Promise<void> }; // quiet-time compaction (chatsession.ts): `due` is a cheap look at the session file, `run` re-checks inside the queue
  groups?: () => string[]; // known group ids
  key?: () => string | undefined; // where the instance key comes from for a friend's unattended work (default settings.tenantApiKey; tests)
  tenantIds?: () => string[]; // active tenants (default: the registry)
  notesChangedAt?: (dir: string) => number;
  now?: () => Date;
  guards?: { paused: (now: Date) => boolean; budgetSpent: () => boolean }; // tests; default: the real pause switch and daily budget
}

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

  const heartbeat = createHeartbeatLook({ pipeline, run: deps.run, may, why, notesChangedAt: changed });

  // One conversation, one look. Returns what happened (for the log and tests).
  async function look(conv: Conversation, now: Date): Promise<string> {
    if (!allows(conv, "heartbeat") || !allows(conv, "wake")) return "not-allowed"; // its capability set decides (a tenant's record); nothing for it without both
    return heartbeat.look(conv, stateOf(conv), now);
  }

  // Every conversation looks on its own: a slow brief or a failing group never delays another conversation.
  const busy = new Set<string>();
  async function tick(now = clock()): Promise<void> {
    if (paused(now)) return;
    const convs: Conversation[] = [owner()]; // (each conversation asks mayRun: the instance's day budget is the owner's and the groups', a friend's is her own)
    if (settings.wakeups && deps.groupChats) {
      const ids = (deps.groups ?? (() => listGroups().map((g) => g.id)))();
      const vouched = await Promise.all(ids.map((id) => deps.vouch(id).catch(() => false))); // in parallel; a lookup is cached for minutes
      ids.forEach((id, i) => vouched[i] && convs.push(group(id)));
      if (settings.tenants) {
        for (const id of (deps.tenantIds ?? (() => listTenants().filter((r) => r.status === "active").map((r) => r.id)))()) {
          try {
            const conv = tenant(id);
            if (allows(conv, "heartbeat")) convs.push(conv); // the tick is her heartbeat: without it nothing of hers is touched
          } catch (e) {
            console.error("wake: a tenant could not be looked at:", (e as Error).message);
          }
        }
      }
      for (const key of states.keys()) if (!convs.some((c) => c.key === key)) states.delete(key); // groups and tenants that are gone
    }
    await Promise.all(
      convs.map(async (conv) => {
        if (paused(clock())) return;
        quietCompact(conv);
        if (busy.has(conv.key)) return;
        busy.add(conv.key);
        try {
          await look(conv, clock());
        } catch (e) {
          console.error(`wake: ${conv.kind} look failed:`, (e as Error).message);
        } finally {
          busy.delete(conv.key);
        }
      }),
    );
  }

  return { tick, look, idle };
}