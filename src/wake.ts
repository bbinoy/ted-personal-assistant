import { audit, type Source } from "./audit.ts";
import { inQuietHours } from "./actions.ts";
import { budgetSpent } from "./budget.ts";
import { askGate, idleFingerprint, logTail, NOTHING, notesText, type Gate } from "./gate.ts";
import { lookDue, lookState, notesChangedAt, recordWake, type LookState } from "./ledger.ts";
import { createHeartbeatLook } from "./heartbeat/look.ts";
import { groupContext, listGroups } from "./groupstore.ts";
import { realRunner, type PromptBuilder, type Runner } from "./group.ts";
import { wakePrompt } from "./wakeprompt.ts";
import { group, owner, tenant, type Conversation, type Pipeline } from "./conversation.ts";
import { allows } from "./capabilities.ts";
import { isRefusal, mayRun, type Payer, type Refusal } from "./payer.ts";
import { hasPresets, onLogin, speakerOf } from "./conversationmodel.ts";
import { ledgerEntries, logSignature } from "./messages.ts";
import { localDay } from "./pause.ts";
import { namesTimeInQuietHours } from "./notetimes.ts";
import { isPaused } from "./pause.ts";
import type { OwnerProfile } from "./profiles.ts";
import { listTenants } from "./tenants.ts";
import { briefOwed, briefTask, buildTask, presetRefusal, runBriefTask, type PresetIO, type Task } from "./tasks.ts";
import { settings } from "./settings.ts";
import { LIMITS } from "./sanitize.ts";
import type { RunProvenance } from "./autojudge.ts";
import { derivedTurn } from "./turnscope.ts";

// The clock of every conversation's own initiative. On every tick (a free timer, no model), for the owner's chat, every group the owner is in and every tenant
// (TENANTS=on) whose next look has come (or where something was said or a note changed since the last look):
//   the owner  the HEARTBEAT RUN (heartbeat/look.ts): one Haiku run that looks at the chat, mail, calendar and tasks, acts through the normal floor, judge and phone,
//              and answers with a message or [[silent]] and its next look (10..120 minutes). Code keeps pause, mayRun, the clamp, the night cap and the brief's schedule.
//   a group    the gate (gate.ts: Haiku, no tools) is asked whether to do something unprompted; if it says act, the group run (src/agent.ts runConversation) does it with the
//              gate's instructions: its own notes and web search, nothing of the owner's; the answer goes out through the shared pipeline (it may be [[silent]])
//   a tenant   the same gate and run on the instance key, with HER notes, session and cost file, her approvals in her chat, an answer to her chat only.
//              She is looked in on only with the capabilities `heartbeat` and `wake` (a friend has the first, not the second), while she is active, the key is out of a
//              cooldown and she is within her day's budget; the gate's own call is billed to her the same way
// Every model call of a look, a preset, a wake-up and a compaction asks payer.ts mayRun first (paused, the usage-limit cooldown, the day's budget; for a friend her
// own budget and the shared key) and runs on the Payer it returns: no per-conversation branches here.
// The owner's daily brief is a preset (tasks.ts) started here by a deterministic rule, not by a model: from BRIEF_START_HOUR on, when no brief is logged today (or an attempt came
// out incomplete), the brief runs (the dream first). Presets are not queued behind the chat (a brief takes minutes) and not awaited by the look either: they run as detached jobs, one per task at a time.
// The model decides; THESE are the guards, in code: pause, the daily budget (budgetSpent: asking never uses up the
// owner's once-a-day notice; a tenant's own day is her access, tenantrun.ts), quiet hours of a friend's private chat, the gate's next look clamped to 15..60 minutes (the owner's run: 10..120),
// the brief once a day and its attempt cap (tasks.ts presetRefusal), and a failed run is logged and silent. A gate that fails or says something odd means do nothing.

interface WakeDeps {
  groupChats: boolean; // the messenger takes part in groups (capabilities.groups). Groups are woken only then: on Signal's Note to Self every message would go out as the owner
  pipeline: Pick<Pipeline, "enqueue" | "runTurn" | "record" | "canSpeak">;
  vouch: (groupId: string) => Promise<boolean>; // is the owner in this group? (a group we cannot vouch for is never woken)
  runProfile: (profile: OwnerProfile, prompt: string, extra?: { onToolSuccess?: (tool: string, input: unknown) => void; provenance?: RunProvenance }) => Promise<{ text: string; costUsd?: number; structured?: unknown }>; // the owner's runs by profile (agent.ts runProfile): the heartbeat run and the brief
  presets?: { sendBrief: (markdown: string) => Promise<void>; notify: (text: string) => Promise<void>; beforeBrief?: () => Promise<void> }; // what the brief preset needs
  compact?: { due: (conv: Conversation) => boolean; run: (conv: Conversation) => Promise<void> }; // quiet-time compaction (chatsession.ts): `due` is a cheap look at the session file, `run` re-checks inside the queue
  runGroup?: Runner; // a group's or a tenant's run
  gate?: Gate;
  groups?: () => string[]; // known group ids
  key?: () => string | undefined; // where the instance key comes from for a friend's unattended work (default settings.tenantApiKey; tests)
  tenantIds?: () => string[]; // active tenants (default: the registry)
  context?: typeof groupContext;
  notesChangedAt?: (dir: string) => number;
  now?: () => Date;
  guards?: { paused: (now: Date) => boolean; budgetSpent: () => boolean }; // tests; default: the real pause switch and daily budget
}

const outcome = (res: { error?: unknown; spoke: boolean }): "posted" | "silent" | "failed" => (res.error ? "failed" : res.spoke ? "posted" : "silent");

const source = (conv: Conversation): Source => (onLogin(conv) ? "background" : "group");

export function createWakeups(deps: WakeDeps) {
  const { pipeline } = deps;
  const clock = deps.now ?? (() => new Date());
  const gate = deps.gate ?? askGate;
  const paused = deps.guards?.paused ?? isPaused;
  const spent = deps.guards?.budgetSpent ?? budgetSpent;
  const changed = deps.notesChangedAt ?? notesChangedAt;
  // May this conversation's unattended work run now, and on whom? (payer.ts: the pause switch, the usage-limit cooldown, the day's budget, a friend's own budget and the key.)
  const may = (conv: Conversation, what: string): Payer | Refusal => mayRun(conv, what, { key: deps.key, paused: () => paused(clock()), spent });
  const why = (r: Refusal): string => (r.refused === "cooldown" ? "cooldown" : r.refused === "paused" ? "guarded" : "blocked");

  // A group's or a friend's run, from the gate's instructions (the owner's initiative is the heartbeat run, heartbeat/look.ts).
  async function act(conv: Conversation, instructions: string, now: Date, payer: Payer): Promise<"posted" | "silent" | "failed"> {
    const speak = pipeline.canSpeak() && allows(conv, "voice");
    return pipeline.enqueue(conv, async () => {
      // Her session already holds her chat; the prompt carries the tail of her log, like the owner's. A group's is what its members wrote since the session last saw.
      const build: PromptBuilder = conv.tenantId
        ? () => ({ prompt: wakePrompt({ who: speakerOf(conv), where: "chat", now, instructions, lines: logTail(conv, 20), speak }) })
        : (since) => {
            const { lines, seenAt } = (deps.context ?? groupContext)(conv.groupId!, since);
            return { prompt: wakePrompt({ who: "", where: "group", now, instructions, lines, resumed: !!since, speak }), seenAt };
          };
      const run = async () => ({ text: await derivedTurn(conv.key, "gate", instructions, () => (deps.runGroup ?? realRunner)(build, { conv, now, apiKey: payer.kind === "instance" ? payer.apiKey : undefined })) }); // the gate wrote the task: derived, for the approval judge
      return outcome(await pipeline.runTurn(conv, { run, background: true, announce: false, kind: "chat" }));
    });
  }

  const presetIO = (conv: Conversation): PresetIO => ({
    runProfile: deps.runProfile,
    sendBrief: deps.presets?.sendBrief ?? (async () => {}),
    notify: deps.presets?.notify ?? (async () => {}),
    beforeBrief: deps.presets?.beforeBrief,
    record: (text) => pipeline.record(conv, "action", Date.now(), text),
  });

  // A preset runs outside the conversation's queue AND outside the look: it is started as a detached job (I/O-bound, so no
  // worker thread) and the look returns at once, so a brief that takes minutes never delays the next look at the
  // owner's chat. One job per task at a time (the running guard); its ledger lines are written when the run ends, a failure
  // is logged and audited, and `idle()` lets a test (or a shutdown) wait for the jobs.
  const running = new Map<string, Promise<string>>();
  function runPreset(conv: Conversation, task: Task, st: LookState, now: Date, after?: () => void): string {
    const refused = presetRefusal(task, st);
    if (refused) {
      audit("wake", `refused-${refused}`, source(conv));
      return `refused:${refused}`;
    }
    if (running.has(task.name)) return `${task.name}-running`;
    const io = presetIO(conv);
    const job = (async () => {
      try {
        const result = `brief-${await runBriefTask(io, task, st, now)}`;
        audit("wake", result, source(conv));
        return result;
      } catch (e) {
        console.error(`wake: ${task.name} failed:`, (e as Error).message);
        audit("wake", `${task.name}-failed`, source(conv));
        return `${task.name}-failed`;
      } finally {
        running.delete(task.name);
        after?.();
      }
    })();
    running.set(task.name, job);
    return `${task.name}-started`;
  }
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

  // The deterministic brief (no model decides): the start hour has passed with no brief logged today, or an attempt came
  // out incomplete. Not held back by quiet hours: a Mac that wakes late still gets that day's brief.
  async function backstop(conv: Conversation, st: LookState, now: Date): Promise<string | undefined> {
    if (!hasPresets(conv) || !briefOwed(st, now)) return undefined;
    const payer = may(conv, "brief");
    if (isRefusal(payer)) return why(payer); // paused, a usage limit (the next tick after it lifts retries) or the day's budget spent
    return runPreset(conv, briefTask(), st, now);
  }

  // The ledger's reading, remembered while the log file is unchanged (same stat) and the day is the same: an idle tick then costs one stat per conversation, not a read and parse of its whole log.
  const states = new Map<string, { sig: string; day: string; st: LookState }>();
  function stateOf(conv: Conversation, now: Date): LookState {
    const sig = logSignature(conv.logFile);
    const day = localDay(now);
    const hit = states.get(conv.key);
    if (hit && sig && hit.sig === sig && hit.day === day) return hit.st;
    const st = lookState(ledgerEntries(conv.logFile), now);
    if (sig) states.set(conv.key, { sig, day, st });
    else states.delete(conv.key);
    return st;
  }

  // The last quiet decision per conversation (in memory: a restart asks the model once more): what the model was shown, as a
  // fingerprint (gate.ts idleFingerprint), and the next look it chose. An unchanged fingerprint repeats that decision without a call.
  const quietLooks = new Map<string, { print: string; nextCheckMinutes: number }>();
  const heartbeat = createHeartbeatLook({ pipeline, runProfile: deps.runProfile, may, why, notesChangedAt: changed });

  // One conversation, one look. Returns what happened (for the log and tests).
  async function look(conv: Conversation, now: Date): Promise<string> {
    const st = stateOf(conv, now);
    const owed = await backstop(conv, st, now);
    if (owed) return owed;
    if (!allows(conv, "heartbeat") || !allows(conv, "wake")) return "not-allowed"; // a tenant's record decides; nothing for her without both
    if (onLogin(conv)) return heartbeat.look(conv, st, now); // the owner: the heartbeat run, which has its own guards and no quiet-hours rule in code
    const night = inQuietHours(now, settings.quietStartHour, settings.quietEndHour);
    if (conv.direct && night) return "quiet-hours"; // a friend's private chat
    const tagged = conv.kind === "group" && settings.groupParticipation === "tagged"; // there only a tag counts as news
    if (!lookDue(st, now, { notesChangedMs: changed(conv.notesDir), messagesCount: !tagged })) return "not-due";

    // A group has no quiet hours of its own, but its clock look is held back at night too unless its notes name a time inside
    // the quiet window (a schedule at 06:30 still gets its look). The notes are read once for the whole look.
    const notes = notesText(conv, now);
    if (!conv.direct && night && !namesTimeInQuietHours(notes, settings.quietStartHour, settings.quietEndHour)) return "quiet-hours";

    // A look is a model call on someone's account (a friend's: the instance key, billed to her): paused, in a cooldown, past the budget or no key set means no model call,
    // nothing recorded, and the next tick looks again.
    const access = may(conv, `${conv.kind} look`);
    if (isRefusal(access)) return why(access);

    // Nothing relevant changed since the model last found nothing to do: its answer would be the same, so keep that look time.
    const tail = logTail(conv);
    const print = idleFingerprint({ conv, now, tail }, "", notes);
    const quiet = quietLooks.get(conv.key);
    if (quiet && quiet.print === print) {
      recordWake(pipeline, conv, quiet.nextCheckMinutes, now);
      return "idle";
    }
    quietLooks.delete(conv.key);

    let out = NOTHING;
    let answered = false;
    try {
      out = await gate({ conv, trigger: "clock", now, tail, notes, payer: access });
      answered = true;
    } catch (e) {
      console.error(`wake: gate failed (${conv.kind}):`, (e as Error).message); // fail closed; the default delay stops a retry on every tick
    }
    // Written BEFORE acting: a crash in the run must not mean a retry on every tick.
    recordWake(pipeline, conv, out.nextCheckMinutes, now);
    if (!out.act) {
      if (answered) quietLooks.set(conv.key, { print, nextCheckMinutes: out.nextCheckMinutes }); // only a real answer counts as a quiet decision
      return "no";
    }
    const task = buildTask(out);
    if (!task) return "no-instructions"; // a free-form look must say what to do
    const again = may(conv, `${conv.kind} run`); // re-checked: the gate call itself took time and money (hers too)
    if (isRefusal(again)) return "guarded";
    const result = await act(conv, task.instructions, now, again).catch((e) => (console.error(`wake: ${conv.kind} run failed:`, (e as Error).message), "failed" as const));
    pipeline.record(conv, "action", Date.now(), `wake-up: ${task.instructions.slice(0, LIMITS.preview)} → ${result === "posted" ? "posted" : result === "silent" ? "stayed silent" : "failed"}`);
    audit("wake", result, source(conv));
    recordWake(pipeline, conv, out.nextCheckMinutes, now); // after the act: notes it wrote are not news
    return result;
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