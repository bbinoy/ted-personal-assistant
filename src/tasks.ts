import type { OwnerProfile, ProfileName } from "./profiles.ts";
import { briefDelivery, briefInstructions, currentBriefPrompt, markBriefDone, runBriefAttempt, type BriefOutcome } from "./brief.ts";
import { ledger, type LookState } from "./ledger.ts";
import { settings } from "./settings.ts";
import type { RunProvenance } from "./autojudge.ts";

// The one Task type: what a look can start. `profile` is HOW the run may work (agent.ts PROFILES: policy source, system prompt, skills, turns, budget, output
// schema), fixed in code. The gate chooses only the instructions of a free-form task and can never edit a profile.
//   task    free-form instructions written by the gate, for a group or a friend: the "group" profile; after: the answer is posted (may be [[silent]]).
//   brief   OWNER ONLY, started by the deterministic backstop (wake.ts). The daily-brief skill, "brief" profile; after: capture the sent email, post the
//           Signal summary, save memory/last-brief.md; retries up to BRIEF_MAX_ATTEMPTS a day if incomplete.
// (The owner's other unattended work is the heartbeat run, heartbeat/look.ts.)
export interface Task {
  name: "task" | "brief";
  instructions: string;
  profile: ProfileName;
  after: "post" | "brief";
  retries?: number; // brief: extra attempts after an incomplete one, same day
}

// Pure. The brief as a task.
export const briefTask = (): Task => ({ name: "brief", instructions: briefInstructions(), profile: "brief", after: "brief", retries: settings.briefMaxAttempts - 1 });

// Pure. The gate's free-form task for a group or a friend, or nothing when it wrote no instructions.
export function buildTask(out: { instructions?: string }): Task | undefined {
  const instructions = out.instructions?.trim();
  return instructions ? { name: "task", instructions, profile: "group", after: "post" } : undefined;
}

// ---- when the brief is owed, in code ----

const briefCap = () => settings.briefMaxAttempts;

// The deterministic part of the brief's schedule: a failed or incomplete attempt is retried (up to the
// cap, after a short gap), and a day with no brief at all gets one from the start hour.
export function briefOwed(st: LookState, now: Date): "backstop" | "retry" | undefined {
  if (st.briefDone || st.briefAttempts >= briefCap()) return undefined;
  if (st.briefAttempts === 0) return settings.briefBackstopHour < 24 && now.getHours() >= settings.briefStartHour ? "backstop" : undefined; // (the gate no longer schedules the brief: it is due from its start hour)
  const last = st.lastBriefAttemptAt ? Date.parse(st.lastBriefAttemptAt) : 0;
  return now.getTime() - last >= settings.briefRetryGapMinutes * 60_000 ? "retry" : undefined;
}

// Why a chosen preset must not run now (the gate only chooses; these are code).
export function presetRefusal(task: Task, st: LookState): string | undefined {
  if (task.name === "brief") return st.briefDone ? "brief-done" : st.briefAttempts >= (task.retries ?? 0) + 1 ? "attempt-cap" : undefined;
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
