import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { audit } from "./audit.ts";
import { allows } from "./capabilities.ts";
import { oneShot } from "./haiku.ts";
import { isRefusal, LOGIN, mayRun, type Payer } from "./payer.ts";
import { applyPlan } from "./dreamapply.ts";
import { OWNER_SCOPE, planOps, type NoteFile, type Plan, type Scope } from "./dreamplan.ts";
import { clockLine } from "./brief.ts";
import { fence } from "./fence.ts";
import { foldEdits, messagesSince, withoutDeleted, type Sent } from "./messages.ts";
import { NOTES_DIR } from "./notes.ts";
import { isPaused, localDay } from "./pause.ts";
import { dreamSystem } from "./persona.ts";
import { OWNER, settings } from "./settings.ts";
import { readJson, writeJson } from "./state.ts";
import { LIMITS } from "./sanitize.ts";

// The dream: once a day, before the daily brief, a model with NO tools reads what the owner said
// since the last dream (their messages and reactions) next to the current notes, and proposes
// changes to the notes as JSON: things worth remembering, and a tidy-up (merge duplicates,
// drop what has expired). It cannot touch anything itself. Code decides what is applied:
//   - a new fact needs a verbatim quote from the owner's own words that day (checked here);
//   - a merge may only shorten what it merges; an expired note is checked against its date;
//   - setup and voice notes are not the dream's to change;
//   - a cap on changes per run, and a snapshot first so "undo the dream" puts everything back.
// It works silently: what it did is in the log (and the snapshot lets the owner say "undo the dream"). Nothing it reads is mail: the owner's messages
// are the only ground for a note, so a crafted email cannot plant a memory.

const STATE = "state/dream.json";
const MAX_PROMPT_NOTES_CHARS = 80_000;
const MAX_PROMPT_CONVERSATION_CHARS = 40_000;

// ---- what the model sees ----

const hhmm = (iso: string) => `${iso.slice(5, 10)} ${new Date(iso).toTimeString().slice(0, 5)}`;

// Pure: the conversation since the last dream as lines. Only the person's own typed or spoken words (the owner's, or a tenant's, `who`)
// can ground a note (ownerText). Their reactions are shown as signals, but the message they were on may
// quote mail, and the assistant's replies only make sense of "yes, do that": neither is evidence.
// A message she deleted is not evidence at all, and an edited one counts once, as edited.
export function conversationLines(messages: readonly Sent[], who: string = OWNER): { lines: string[]; ownerText: string } {
  const lines: string[] = [];
  const owner: string[] = [];
  for (const m of foldEdits(withoutDeleted(messages))) {
    if (m.kind === "owner") { lines.push(`[${hhmm(m.at)}] ${who}: ${m.text.replace(/\n+/g, " / ")}`); owner.push(m.text); }
    else if (m.kind === "reaction") { lines.push(`[${hhmm(m.at)}] ${who} reacted ${m.text.replace(/\n+/g, " / ")}`); } // shows what was reacted to, which may quote mail: never evidence
    else if (m.kind === "chat") lines.push(`[${hhmm(m.at)}] assistant (context only): ${m.text.slice(0, LIMITS.line).replace(/\n+/g, " / ")}`);
  }
  return { lines, ownerText: owner.join("\n") };
}

// The prompt, for any scope: the notes as they are, and what was said since the last dream.
function buildPrompt(now: Date, kept: string, said: string, notes: readonly NoteFile[], lines: readonly string[]): string {
  const conv = lines.join("\n");
  const cut = conv.length > MAX_PROMPT_CONVERSATION_CHARS ? conv.slice(-MAX_PROMPT_CONVERSATION_CHARS) : conv;
  const current = notes.map((n) => `### ${n.file}\n${n.raw.trim()}`).join("\n\n").slice(0, MAX_PROMPT_NOTES_CHARS);
  return [
    clockLine(now),
    `${kept}\n${fence("current_notes", current || "(none yet)")}`,
    `${said}\n${fence("conversation", cut || "(nothing)")}`,
    `Propose the changes to the notes, if any.`,
  ].join("\n\n");
}

// The owner's, or (`who`) a tenant's: the same prompt about her.
export const dreamPrompt = (now: Date, notes: readonly NoteFile[], messages: readonly Sent[], who: string = OWNER): string =>
  buildPrompt(now, `The notes you keep about ${who} right now (one file per fact; MEMORY.md is the index and is updated for you):`, `What ${who} said and did since the last dream, oldest first:`, notes, conversationLines(messages, who).lines);

// A group's log holds what members wrote ("Eve: ...", kind member) and the assistant's replies (kind chat).
// Anyone's own words in the group can ground a note there: that is whose memory it is. The assistant's
// replies are context only.
export function groupConversation(messages: readonly Sent[]): { lines: string[]; memberText: string } {
  const lines: string[] = [];
  const member: string[] = [];
  for (const m of foldEdits(withoutDeleted(messages))) {
    if (m.kind === "member") { lines.push(`[${hhmm(m.at)}] ${m.text.replace(/\n+/g, " / ")}`); member.push(m.text); }
    else if (m.kind === "chat") lines.push(`[${hhmm(m.at)}] assistant (context only): ${m.text.slice(0, LIMITS.line).replace(/\n+/g, " / ")}`);
  }
  return { lines, memberText: member.join("\n") };
}

export const groupDreamPrompt = (now: Date, notes: readonly NoteFile[], messages: readonly Sent[], name: string): string =>
  buildPrompt(now, `The notes you keep for the group chat "${name}" right now (one file per fact):`, `What the group's members wrote in "${name}" since the last dream, oldest first:`, notes, groupConversation(messages).lines);

const SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["ops"],
    properties: {
      ops: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["op", "file"],
          properties: {
            op: { type: "string", enum: ["write", "delete"] },
            file: { type: "string" },
            description: { type: "string" },
            text: { type: "string" },
            expires: { type: "string" },
            evidence: { type: "string" },
            consolidates: { type: "array", items: { type: "string" } },
            reason: { type: "string" },
          },
        },
      },
    },
  },
};

export type Runner = (prompt: string, system?: string) => Promise<unknown>;

// The model that proposes the changes: no tools, one JSON answer, on whoever pays (payer.ts: the login for the owner's and a group's dream, the instance key and her
// cost file for a friend's). A refusal of the API is thrown (errors.ts), any other failure too.
export const runnerFor = (payer: Payer = LOGIN): Runner => async (prompt, system = dreamSystem("owner")) => {
  const r = await oneShot({ system, prompt, payer, schema: SCHEMA, model: settings.model, options: { maxTurns: 3, maxBudgetUsd: 0.6 } });
  if (!r.ok) throw r.error ?? new Error("the dream run failed");
  return r.output;
};

export const readNoteFiles = (dir: string = NOTES_DIR): NoteFile[] => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").sort().map((file) => ({ file, raw: readFileSync(join(dir, file), "utf8") }));
  } catch {
    return [];
  }
};

// ---- the run itself, the same for the owner's notes and for a group's ----

// Asks the model for changes, lets code decide which to keep, snapshots and applies them.
export async function dreamOver(scope: Scope, prompt: string, system: string, evidenceText: string, now: Date, run: Runner): Promise<{ plan: Plan; snapshot?: string }> {
  const notes = readNoteFiles(scope.notesDir);
  const raw = await run(prompt, system);
  const plan = planOps(raw, { ownerText: evidenceText, notes, today: localDay(now), now, scope });
  return { plan, snapshot: applyPlan(plan, now, scope) };
}

export const describePlan = (plan: Plan): string[] => {
  const icon = { add: "➕ saved", update: "✏️ updated", merge: "🔀 merged into" } as const;
  return plan.actions.map((a) => (a.kind === "delete" ? `➖ forgot ${a.file} (${a.why})` : `${icon[a.kind]} ${a.file}: ${a.description}`));
};


// ---- the daily run ----

interface DreamState {
  day?: string; // local day of the last attempt
  lastRunAt?: string; // when the last real run started: what it covered ends here
}

export function createDreamer(deps: { run?: Runner } = {}) {
  let inFlight: Promise<void> | undefined;

  async function once(now: Date): Promise<void> {
    const today = localDay(now);
    const state = readJson<DreamState>(STATE, {});
    if (state.day === today) return;
    if (!allows({ kind: "owner" }, "dream")) return;
    const payer = mayRun({ kind: "owner" }, "dream", { paused: () => isPaused(now) }); // paused, a usage limit or the day's budget spent: no attempt, the day stays open
    if (isRefusal(payer)) return;
    const runner = deps.run ?? runnerFor(payer);
    writeJson(STATE, { ...state, day: today }); // before the run: a crash must not mean a retry on every tick
    const messages = messagesSince(state.lastRunAt);
    const { ownerText } = conversationLines(messages);
    if (!messages.some((m) => m.kind === "owner")) {
      audit("dream_run", "nothing-new", "dream");
      return;
    }
    try {
      const { plan, snapshot: snap } = await dreamOver(OWNER_SCOPE, dreamPrompt(now, readNoteFiles(), messages), dreamSystem("owner"), ownerText, now, runner);
      writeJson(STATE, { day: today, lastRunAt: now.toISOString() });
      for (const r of plan.rejected) console.log(`dream: rejected ${r.file || "(no file)"}: ${r.why}`);
      audit("dream_run", snap ? "changed" : "no-change", "dream", { actions: plan.actions.length, rejected: plan.rejected.length });
      console.log(`dream: ${plan.actions.length} change(s), ${plan.rejected.length} rejected`);
      if (snap) console.log(`dream: ${describePlan(plan).join("; ")}`); // silent: logged here and in audit.jsonl, undoable from chat
    } catch (e) {
      console.error("dream: failed:", (e as Error).message);
      audit("dream_run", "failed", "dream", { error: (e as Error).message.slice(0, LIMITS.preview) });
    }
  }

  // One run at a time; a second caller waits for the first.
  return { run: (now = new Date()) => (inFlight ??= once(now).finally(() => (inFlight = undefined))) };
}
