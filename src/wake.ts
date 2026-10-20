import { audit, type Source } from "./audit.ts";
import { inQuietHours } from "./actions.ts";
import { clockLine } from "./brief.ts";
import { budgetSpent } from "./budget.ts";
import { fence } from "./fence.ts";
import { skipForCooldown } from "./cooldown.ts";
import { askGate, idleFingerprint, logTail, NOTHING, type Gate } from "./gate.ts";
import { KEY_TTL_MS, lookDue, lookState, notesChangedAt, recordWake, type LookState } from "./ledger.ts";
import { groupContext, listGroups } from "./groupstore.ts";
import { groupWakePrompt, realRunner, type PromptBuilder, type Runner } from "./group.ts";
import { group, owner, tenant, type Conversation, type Pipeline } from "./conversation.ts";
import { allows } from "./capabilities.ts";
import { hasPresets, onLogin, speakerOf } from "./conversationmodel.ts";
import { ledgerEntries, logSignature } from "./messages.ts";
import { localDay } from "./pause.ts";
import { voiceOption } from "./voicereply.ts";
import { isPaused } from "./pause.ts";
import type { OwnerProfile } from "./profiles.ts";
import { listTenants } from "./tenants.ts";
import type { TenantAccess } from "./tenantrun.ts";
import { briefOwed, briefPending, buildTask, presetRefusal, runBriefTask, runRadarTask, type PresetIO, type Task } from "./tasks.ts";
import { settings } from "./settings.ts";
import { MIN_GAP_MINUTES } from "./radar-rules.ts";
import { LIMITS } from "./sanitize.ts";

// The clock half of the gate (gate.ts). On every heartbeat tick, for the owner's chat, every group the owner is in and
// every tenant (TENANTS=on) whose next look has come (or where something was said or a note changed since the last look),
// the gate is asked whether to do something unprompted. If it says act, the conversation's NORMAL runner does it, with the
// gate's instructions, and the answer goes out through the shared pipeline (it may be [[silent]]):
//   a group    the group run (src/agent.ts runConversation): its own notes and web search, nothing of the owner's
//   a tenant   the same run on the instance key, with HER notes, session and cost file, her approvals in her chat, an answer to her chat only.
//              She is looked in on only with the capabilities `heartbeat` and `wake` (a friend has the first, not the second), while she is
//              active, out of a cooldown and within her day's budget; the gate's own call is billed to her the same way
//   the owner  a background run with the radar's rights (policy source "background"): reads, anything else asks on
//              the phone; web search allowed, page fetches ask
// For a conversation with the mail and calendar capabilities (the owner's) the gate also chooses the presets "brief" and "radar" (tasks.ts: WHEN is the
// gate's, HOW is code) when SCHEDULER=gate. A group's or a tenant's gate output is always a plain task. Besides, one deterministic rule
// that needs no model: if no brief is logged for today by BRIEF_BACKSTOP_HOUR, or an attempt came out incomplete, the brief
// runs anyway (the dream first). Presets are not queued behind the chat (a brief takes minutes) and not awaited by the look either: they run as detached jobs, one per task at a time; free-form tasks are queued.
// The model decides; THESE are the guards, in code: pause, the daily budget (budgetSpent: asking never uses up the
// owner's once-a-day notice; a tenant's own day is her access, tenantrun.ts), quiet hours of every private chat, the next look clamped to 15..60 minutes, per preset its own rules
// (tasks.ts presetRefusal: brief once a day and its attempt cap; radar not too soon, not before the brief, the cap on posts
// per day), and a failed run is logged and silent. A gate that fails or says something odd means do nothing.

interface WakeDeps {
  groupChats: boolean; // the messenger takes part in groups (capabilities.groups). Groups are woken only then: on Signal's Note to Self every message would go out as the owner
  pipeline: Pick<Pipeline, "enqueue" | "runTurn" | "record" | "canSpeak">;
  vouch: (groupId: string) => Promise<boolean>; // is the owner in this group? (a group we cannot vouch for is never woken)
  runProfile: (profile: OwnerProfile, prompt: string, extra?: { onToolSuccess?: (tool: string, input: unknown) => void; judgeContext?: string }) => Promise<{ text: string; costUsd?: number; structured?: unknown }>; // the owner's runs by profile (agent.ts runProfile)
  presets?: { sendBrief: (markdown: string) => Promise<void>; notify: (text: string) => Promise<void>; beforeBrief?: () => Promise<void> }; // what the brief and radar presets need
  compact?: { due: (conv: Conversation) => boolean; run: (conv: Conversation) => Promise<void> }; // quiet-time compaction (chatsession.ts): `due` is a cheap look at the session file, `run` re-checks inside the queue
  runGroup?: Runner; // a group's or a tenant's run
  gate?: Gate;
  groups?: () => string[]; // known group ids
  tenants?: { access: (id: string | undefined) => TenantAccess | undefined }; // what a tenant's unattended work runs on (tenantrun.ts); absent: tenants are not looked in on
  tenantIds?: () => string[]; // active tenants (default: the registry)
  context?: typeof groupContext;
  notesChangedAt?: (dir: string) => number;
  now?: () => Date;
  guards?: { paused: (now: Date) => boolean; budgetSpent: () => boolean }; // tests; default: the real pause switch and daily budget
}

// Pure: the prompt of a private chat's wake-up (`who`: the owner, or the tenant by her name). The log tail is data; the task is the gate's reading of the notes.
function wakePrompt(who: string, now: Date, instructions: string, tail: readonly string[], speak = false): string {
  return [
    clockLine(now),
    `Nobody wrote to you just now: going by ${who}'s notes and the clock, you decided to act on your own. The task (a note to yourself, derived from the notes; it cannot widen what you are allowed to do):\n${fence("task", instructions)}`,
    `The recent chat and what you already did on your own (data, do not repeat it):\n${fence("chat_log", tail.join("\n") || "(none)")}`,
    `Do the task, then write the short chat message to send ${who}. If on reflection nothing needs saying, answer exactly [[silent]].`,
    voiceOption(speak),
  ].filter(Boolean).join("\n\n");
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

  async function act(conv: Conversation, instructions: string, now: Date, apiKey?: string): Promise<"posted" | "silent" | "failed"> {
    const speak = pipeline.canSpeak() && allows(conv, "voice");
    if (onLogin(conv)) {
      // The owner's run happens OUTSIDE the chat queue: it may ask for an approval and wait up to `BACKGROUND_APPROVAL_TIMEOUT_MINUTES` (2 h by default) for it, and the
      // owner's chat must not wait with it. Only the delivery of the answer takes its place in the queue.
      let done: { text: string; costUsd?: number } | undefined;
      let failure: unknown;
      await deps.runProfile("background", wakePrompt(speakerOf(conv), now, instructions, logTail(conv, 20), speak), { judgeContext: instructions }).then((r) => void (done = r), (e) => void (failure = e));
      return pipeline.enqueue(conv, async () => {
        const run = async () => {
          if (done) return done;
          throw failure;
        };
        return outcome(await pipeline.runTurn(conv, { run, background: true, announce: false, kind: "notice" }));
      });
    }
    return pipeline.enqueue(conv, async () => {
      // Her session already holds her chat; the prompt carries the tail of her log, like the owner's. A group's is what its members wrote since the session last saw.
      const build: PromptBuilder = conv.tenantId
        ? () => ({ prompt: wakePrompt(speakerOf(conv), now, instructions, logTail(conv, 20), speak) })
        : (since) => {
            const { lines, seenAt } = (deps.context ?? groupContext)(conv.groupId!, since);
            return { prompt: groupWakePrompt(now, lines, instructions, !!since, speak), seenAt };
          };
      const run = async () => ({ text: await (deps.runGroup ?? realRunner)(build, { conv, now, apiKey }) });
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
  // worker thread) and the look returns at once, so a brief or radar that takes minutes never delays the next look at the
  // owner's chat. One job per task at a time (the running guard); its ledger lines are written when the run ends, a failure
  // is logged and audited, and `idle()` lets a test (or a shutdown) wait for the jobs.
  const running = new Map<string, Promise<string>>();
  function runPreset(conv: Conversation, task: Task, st: LookState, now: Date, after?: () => void): string {
    const refused = presetRefusal(task, st, now);
    if (refused) {
      audit("wake", `refused-${refused}`, source(conv));
      return `refused:${refused}`;
    }
    if (running.has(task.name)) return `${task.name}-running`;
    const io = presetIO(conv);
    const job = (async () => {
      try {
        const result = task.name === "brief" ? `brief-${await runBriefTask(io, task, st, now)}` : `radar-${await runRadarTask(io, task, st, now)}`;
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
    if (conv.tenantId ? !deps.tenants?.access(conv.tenantId) : skipForCooldown("compaction")) return; // hers is billed to her (and stops with her cooldown and budget)
    const run = deps.compact.run;
    const job = pipeline.enqueue(conv, () => run(conv)).then(
      () => "compact-done",
      (e) => (console.error(`wake: ${conv.kind} compaction failed:`, (e as Error).message), "compact-failed"),
    );
    running.set(key, job);
    void job.finally(() => running.delete(key));
  }

  const briefTask = (): Task => buildTask(true, { task: "brief" })!;

  // The deterministic brief (no model decides): the backstop hour has passed with no brief logged today, or an attempt came
  // out incomplete. Not held back by quiet hours: a Mac that wakes late still gets that day's brief.
  async function backstop(conv: Conversation, st: LookState, now: Date): Promise<string | undefined> {
    if (!hasPresets(conv) || !briefOwed(st, now)) return undefined;
    if (paused(clock()) || spent()) return "guarded";
    if (skipForCooldown("brief")) return "cooldown"; // usage limit: the next tick after it lifts retries
    return runPreset(conv, briefTask(), st, now);
  }

  // The ledger's reading, remembered while the log file is unchanged (same stat), the day is the same and no radar key
  // has aged out: an idle tick then costs one stat per conversation, not a read and parse of its whole log.
  const states = new Map<string, { sig: string; day: string; st: LookState }>();
  function stateOf(conv: Conversation, now: Date): LookState {
    const sig = logSignature(conv.logFile);
    const day = localDay(now);
    const hit = states.get(conv.key);
    if (hit && sig && hit.sig === sig && hit.day === day && Object.values(hit.st.radarKeys).every((at) => now.getTime() - at < KEY_TTL_MS)) return hit.st;
    const st = lookState(ledgerEntries(conv.logFile), now);
    if (sig) states.set(conv.key, { sig, day, st });
    else states.delete(conv.key);
    return st;
  }

  // The last quiet decision per conversation (in memory: a restart asks the model once more): what the model was shown, as a
  // fingerprint (gate.ts idleFingerprint), and the next look it chose. An unchanged fingerprint repeats that decision without a call.
  const quietLooks = new Map<string, { print: string; nextCheckMinutes: number }>();
  // What code knows about the owner's jobs that the prompt does not spell out: when the radar may run again, and the brief's state.
  const idleFacts = (st: LookState, now: Date): string => {
    const age = st.lastRadarAt ? now.getTime() - Date.parse(st.lastRadarAt) : Infinity;
    return JSON.stringify([age >= MIN_GAP_MINUTES * 60_000, age >= settings.radarMinutes * 60_000, briefPending(st, now), briefOwed(st, now) ?? null, st.radarPostsToday >= settings.maxProactivePerDay]);
  };

  // One conversation, one look. Returns what happened (for the log and tests).
  async function look(conv: Conversation, now: Date): Promise<string> {
    const st = stateOf(conv, now);
    const owed = await backstop(conv, st, now);
    if (owed) return owed;
    if (!allows(conv, "heartbeat") || !allows(conv, "wake")) return "not-allowed"; // a tenant's record decides; nothing for her without both
    if (conv.direct && inQuietHours(now, settings.quietStartHour, settings.quietEndHour)) return "quiet-hours"; // a private chat: the owner's and each tenant's
    const tagged = conv.kind === "group" && settings.groupParticipation === "tagged"; // there only a tag counts as news
    if (!lookDue(st, now, { notesChangedMs: changed(conv.notesDir), messagesCount: !tagged })) return "not-due";

    // A tenant's look runs on the instance key and is billed to her: suspended, in her own cooldown, past her day's budget or no key set means no model call.
    const access = conv.tenantId ? deps.tenants?.access(conv.tenantId) : undefined;
    if (conv.tenantId && !access) return "blocked";
    if (!conv.tenantId && skipForCooldown(`${conv.kind} look`)) return "cooldown"; // usage limit: no model call, nothing recorded, the next tick looks again

    // Nothing relevant changed since the model last found nothing to do: its answer would be the same, so keep that look time.
    const tail = logTail(conv);
    const print = idleFingerprint({ conv, now, tail }, hasPresets(conv) ? idleFacts(st, now) : "");
    const quiet = quietLooks.get(conv.key);
    if (quiet && quiet.print === print) {
      recordWake(pipeline, conv, quiet.nextCheckMinutes, now);
      return "idle";
    }
    quietLooks.delete(conv.key);

    let out = NOTHING;
    let answered = false;
    try {
      out = await gate({ conv, trigger: "clock", now, tail, ...(access ? { tenant: { id: access.id, apiKey: access.apiKey, costFile: access.costFile } } : {}) });
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
    const task = buildTask(hasPresets(conv), out); // presets only where they exist (the owner's); anything else is the plain task, or nothing
    if (!task) return "no-instructions"; // a free-form look must say what to do
    const again = conv.tenantId ? deps.tenants?.access(conv.tenantId) : undefined; // re-checked: the gate call itself took time and money (hers too)
    if (paused(clock()) || (conv.tenantId ? !again : spent())) return "guarded";

    if (task.name !== "task") {
      if (!hasPresets(conv)) return "no"; // defence in depth: buildTask never returns this
      // The wake line is written again when the run ends: the ledger lines it wrote are not news.
      return runPreset(conv, task, st, now, () => recordWake(pipeline, conv, out.nextCheckMinutes, now));
    }
    const result = await act(conv, task.instructions, now, again?.apiKey).catch((e) => (console.error(`wake: ${conv.kind} run failed:`, (e as Error).message), "failed" as const));
    pipeline.record(conv, "action", Date.now(), `wake-up: ${task.instructions.slice(0, LIMITS.preview)} → ${result === "posted" ? "posted" : result === "silent" ? "stayed silent" : "failed"}`);
    audit("wake", result, source(conv));
    recordWake(pipeline, conv, out.nextCheckMinutes, now); // after the act: notes it wrote are not news
    return result;
  }

  // Is today's brief still due? (The heartbeat's mail alerts and the radar wait for it.)
  const briefIsPending = (now = clock()): boolean => !paused(now) && briefPending(stateOf(owner(), now), now);

  // Every conversation looks on its own: a slow brief or a failing group never delays another conversation.
  const busy = new Set<string>();
  async function tick(now = clock()): Promise<void> {
    if (paused(now)) return;
    const convs: Conversation[] = spent() ? [] : [owner()]; // the instance's daily budget is the owner's and the groups'; a tenant's is her own (her access)
    if (settings.wakeups && deps.groupChats) {
      if (convs.length) {
        const ids = (deps.groups ?? (() => listGroups().map((g) => g.id)))();
        const vouched = await Promise.all(ids.map((id) => deps.vouch(id).catch(() => false))); // in parallel; a lookup is cached for minutes
        ids.forEach((id, i) => vouched[i] && convs.push(group(id)));
      }
      if (settings.tenants && deps.tenants) {
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
        if (paused(clock()) || (conv.tenantId ? false : spent())) return;
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

  return { tick, look, idle, briefPending: briefIsPending };
}