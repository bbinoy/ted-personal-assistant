import { audit } from "./audit.ts";
import type { OwnerProfile, ProfileName } from "./profiles.ts";
import { briefDelivery, briefInstructions, currentBriefPrompt, markBriefDone, runBriefAttempt, type BriefOutcome } from "./brief.ts";
import { buildDigest, readTriageSince } from "./digest.ts";
import type { GateOutput, TaskName } from "./gate.ts";
import { ledger, type LookState } from "./ledger.ts";
import { recentNotices } from "./messages.ts";
import { radarInstructions, radarPrompt } from "./radar.ts";
import { acceptMessages, MIN_GAP_MINUTES, WINDOW_MINUTES } from "./radar-rules.ts";
import { settings } from "./settings.ts";
import { LIMITS } from "./sanitize.ts";
import type { RunProvenance } from "./autojudge.ts";

// The one Task type: everything the gate can start. `profile` is HOW the run may work (agent.ts PROFILES: policy source,
// system prompt, skills, turns, budget, output schema), fixed in code. `after` is what happens with the result.
// The gate chooses only the name (and, for a free-form task, the instructions); it can never edit a profile.
//   task    free-form instructions written by the gate. Owner: the "background" profile (reads and web search; the rest asks
//           on the phone). Group: the "group" profile. After: the answer is posted to the conversation (may be [[silent]]).
//   brief   OWNER ONLY. The daily-brief skill, "brief" profile; after: capture the sent email, post the Signal summary, save
//           memory/last-brief.md; retries up to BRIEF_MAX_ATTEMPTS a day if incomplete.
//   radar   OWNER ONLY. The radar skill, "radar" profile; after: post its messages (structured output), capped.
type After = "post" | "brief" | "radar";
export interface Task {
  name: TaskName;
  instructions: string;
  profile: ProfileName;
  after: After;
  retries?: number; // brief: extra attempts after an incomplete one, same day
}

// Pure. The gate's output as a task, or nothing. Fails closed: a preset is only for a conversation that has them (conversationmodel.ts hasPresets: the
// owner's chat; the radar only when it is enabled); any other that asks for one, or an unknown name, gets the plain task if the gate wrote instructions, else nothing.
export function buildTask(presets: boolean, out: Pick<GateOutput, "task" | "instructions">, o: { radar?: boolean } = {}): Task | undefined {
  const radar = o.radar ?? settings.proactive;
  if (presets) {
    if (out.task === "brief") return { name: "brief", instructions: briefInstructions(), profile: "brief", after: "brief", retries: settings.briefMaxAttempts - 1 };
    if (out.task === "radar" && radar) return { name: "radar", instructions: radarInstructions(WINDOW_MINUTES), profile: "radar", after: "radar" };
  }
  const instructions = out.instructions?.trim();
  if (!instructions) return undefined;
  return { name: "task", instructions, profile: presets ? "background" : "group", after: "post" };
}

// ---- when the brief is owed, in code ----

const briefCap = () => settings.briefMaxAttempts;

// Is today's brief still to come (not delivered, attempts left, past the start hour)? The radar and the mail alerts wait for it.
// Only for a bounded window: before the backstop hour (which runs the brief whatever the notes say), or, with the backstop off
// (hour 24), for BRIEF_PENDING_GRACE_HOURS after the start hour. After that nothing is waiting for a brief, so an urgent mail
// is alerted and the radar may run, unless an attempt has already started (then it is pending until it is done or given up).
export const briefPending = (st: LookState, now: Date): boolean => {
  if (st.briefDone || st.briefAttempts >= briefCap() || now.getHours() < settings.briefStartHour) return false;
  const until = settings.briefBackstopHour < 24 ? settings.briefBackstopHour : settings.briefStartHour + settings.briefPendingGraceHours;
  return now.getHours() < until || st.briefAttempts > 0;
};

// The deterministic part of the brief's schedule, whatever the gate says: a failed or incomplete attempt is retried (up to the
// cap, after a short gap), and a day with no brief at all gets one at the backstop hour.
export function briefOwed(st: LookState, now: Date): "backstop" | "retry" | undefined {
  if (st.briefDone || st.briefAttempts >= briefCap()) return undefined;
  if (st.briefAttempts === 0) return now.getHours() >= settings.briefBackstopHour ? "backstop" : undefined;
  const last = st.lastBriefAttemptAt ? Date.parse(st.lastBriefAttemptAt) : 0;
  return now.getTime() - last >= settings.briefRetryGapMinutes * 60_000 ? "retry" : undefined;
}

// Why a chosen preset must not run now (the gate only chooses; these are code).
export function presetRefusal(task: Task, st: LookState, now: Date): string | undefined {
  if (task.name === "brief") return st.briefDone ? "brief-done" : st.briefAttempts >= (task.retries ?? 0) + 1 ? "attempt-cap" : undefined;
  if (task.name === "radar") {
    if (!settings.proactive) return "radar-off";
    if (briefPending(st, now)) return "brief-first";
    if (st.lastRadarAt && now.getTime() - Date.parse(st.lastRadarAt) < MIN_GAP_MINUTES * 60_000) return "too-soon";
    if (st.radarPostsToday >= settings.maxProactivePerDay) return "post-cap";
  }
  return undefined;
}

// ---- running the presets (the HOW) ----

export interface PresetIO {
  runProfile: (profile: OwnerProfile, prompt: string, extra?: { onToolSuccess?: (tool: string, input: unknown) => void; provenance?: RunProvenance }) => Promise<{ text: string; costUsd?: number; structured?: unknown }>;
  sendBrief: (markdown: string) => Promise<void>; // the Signal summary
  notify: (text: string) => Promise<void>; // a message to the owner
  record: (text: string) => void; // an "action" line in the owner's log (the ledger)
  beforeBrief?: () => Promise<void>; // the dream runs before the brief
}

export async function runBriefTask(io: PresetIO, task: Task, st: LookState, now: Date): Promise<BriefOutcome> {
  const attempt = st.briefAttempts + 1;
  const cap = (task.retries ?? 0) + 1;
  await io.beforeBrief?.().catch(() => {});
  io.record(ledger.briefStarted(attempt)); // counted before the run: a crash must not allow endless retries
  console.log(`brief: starting (gate, attempt ${attempt}/${cap})`);
  let completed = false;
  const outcome = await runBriefAttempt(
    { run: (p, cb) => io.runProfile("brief", p, { onToolSuccess: cb, provenance: { kind: "standing", task: task.instructions } }).then((r) => ({ text: r.text, costUsd: r.costUsd ?? 0 })), sendBrief: io.sendBrief, notify: io.notify, delivery: briefDelivery() },
    currentBriefPrompt(now, undefined, task.instructions),
    attempt,
    () => ((completed = true), markBriefDone(now, attempt)),
  );
  const final = completed ? "delivered" : outcome; // a failing Signal summary after a saved brief is not a second brief
  io.record(ledger.briefEnded(attempt, final));
  if (final !== "delivered" && attempt >= cap) await io.notify(`The daily brief failed ${cap} times today, so I'm giving up until tomorrow. Check logs/agent.log.`).catch(() => {});
  return final;
}

export async function runRadarTask(io: PresetIO, task: Task, st: LookState, now: Date): Promise<"posted" | "quiet" | "failed"> {
  io.record(ledger.radarStarted()); // before the run: a crash must not mean a retry on every look
  try {
    const since = st.lastRadarAt ?? new Date(now.getTime() - settings.radarMinutes * 60_000).toISOString();
    const started = Date.now();
    const { structured, costUsd } = await io.runProfile("radar", radarPrompt(now, since, WINDOW_MINUTES, buildDigest(readTriageSince(since), since), recentNotices(now), Object.keys(st.radarKeys), task.instructions), { provenance: { kind: "standing", task: task.instructions } });
    const seen = Number((structured as { eventsSeen?: unknown } | undefined)?.eventsSeen ?? 0);
    if (!(seen > 0)) console.error("radar: the run reports it read no calendar events (calendar empty, or it did not look)");
    // Message-rate rules: the cap on the radar's OWN messages per day (mail alerts do not count; read from its ledger lines), 3 per run, no repeated key (the ledger).
    const messages = acceptMessages(structured, { sent: st.radarPostsToday, keys: st.radarKeys }, settings.maxProactivePerDay);
    const sentKeys: string[] = [];
    for (const m of messages) {
      try {
        await io.notify(m.text);
        sentKeys.push(m.key);
        audit("radar_message", m.kind, "radar", { key: m.key });
      } catch (e) {
        console.error("radar: could not send a message:", (e as Error).message);
      }
    }
    const next = (structured as { nextStartMinutes?: unknown } | undefined)?.nextStartMinutes;
    const at = typeof next === "number" && Number.isFinite(next) && next > 0 ? new Date(now.getTime() + next * 60_000) : undefined;
    const hhmm = at ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` : undefined;
    io.record(ledger.radarRan(sentKeys.length, seen, hhmm, sentKeys));
    console.log(`radar: ${Math.round((Date.now() - started) / 1000)}s, $${(costUsd ?? 0).toFixed(3)}, ${sentKeys.length} message(s) sent, ${seen} event(s) read`);
    audit("radar_run", sentKeys.length ? "spoke" : "quiet", "radar", { costUsd, messages: sentKeys.length, eventsSeen: seen });
    return sentKeys.length ? "posted" : "quiet";
  } catch (e) {
    console.error("radar: run failed:", (e as Error).message);
    audit("radar_run", "failed", "radar", { error: (e as Error).message.slice(0, LIMITS.preview) });
    io.record(ledger.radarFailed((e as Error).message));
    return "failed";
  }
}
