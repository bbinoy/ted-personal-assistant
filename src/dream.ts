import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { audit } from "./audit.ts";
import { allows } from "./policy/capabilities.ts";
import { owner as ownerConversation, group as groupConversation, speakerOf, tenant as tenantConversation, type Conversation } from "./conversationmodel.ts";
import { oneShot } from "./haiku.ts";
import { isRefusal, LOGIN, mayRun, type Payer, type Refusal } from "./payer.ts";
import { applyPlan } from "./dreamapply.ts";
import { planOps, type NoteFile, type Plan, type Scope } from "./dreamplan.ts";
import { dreamScope, dreamStateFile } from "./dreamscope.ts";
import { clockLine } from "./brief.ts";
import { fence } from "./fence.ts";
import { listGroups } from "./groupstore.ts";
import { foldEdits, messagesSince, withoutDeleted, type Sent } from "./messages.ts";
import { NOTES_DIR } from "./notes.ts";
import { isPaused, localDay } from "./pause.ts";
import { dreamSystem } from "./persona.ts";
import { preset } from "./preset.ts";
import { OWNER, settings } from "./settings.ts";
import { readJson, writeJson } from "./state.ts";
import { listTenants } from "./tenants/tenants.ts";
import { LIMITS, oneLine } from "./sanitize.ts";

// The dream: once a day, before the daily brief, a model with NO tools reads what a conversation's person said since the last dream (their messages and
// reactions) next to that conversation's notes, and proposes changes to the notes as JSON: things worth remembering, and a tidy-up (merge duplicates,
// drop what has expired). It cannot touch anything itself. Code decides what is applied:
//   - a new fact needs a verbatim quote from the person's own words that day (checked here);
//   - a merge may only shorten what it merges; an expired note is checked against its date;
//   - setup and voice notes are not the dream's to change;
//   - a cap on changes per run, and a snapshot first so "undo the dream" puts everything back.
// ONE dreamer for every conversation (createDreamer): the owner's chat, each group and each friend. What differs is data: whose notes (dreamScope), the
// note categories they have (the preset), whose words count as evidence (a private chat's person, or a group's members), who pays (payer.ts mayRun) and the
// state file in the conversation's own folder. A conversation is dreamt when its capability set has `dream` (capabilities.ts), once it has enough new lines
// (the preset's rhythm.dream) and its payer may run. It works silently: what it did is in the log (a friend's: counts only, in her audit row words stay out)
// and the snapshot lets "undo the dream" put the notes back. Nothing it reads is mail: the person's messages are the only ground for a note, so a crafted
// email cannot plant a memory.

const MAX_PROMPT_NOTES_CHARS = 80_000;
const MAX_PROMPT_CONVERSATION_CHARS = 40_000;

// ---- what the model sees ----

const hhmm = (iso: string) => `${iso.slice(5, 10)} ${new Date(iso).toTimeString().slice(0, 5)}`;

// Pure: the conversation since the last dream as lines, for any conversation. Only the words of the person (or the members) the notes are about can ground a
// note (`text`): "owner" is a private chat's person (the owner, or a friend, named `who`), "member" is what the members of a group wrote (their lines start with
// their names). Their reactions are shown as signals, but the message they were on may quote mail, and the assistant's replies only make sense of "yes, do
// that": neither is evidence. A message she deleted is not evidence at all, and an edited one counts once, as edited. `count`: how many lines of evidence
// there are (the dream's threshold).
export function conversationLines(messages: readonly Sent[], who: string = OWNER, evidence: "owner" | "member" = "owner"): { lines: string[]; text: string; count: number } {
  const lines: string[] = [];
  const said: string[] = [];
  for (const m of foldEdits(withoutDeleted(messages))) {
    if (m.kind === evidence) { lines.push(`[${hhmm(m.at)}] ${evidence === "owner" ? `${who}: ` : ""}${m.text.replace(/\n+/g, " / ")}`); said.push(m.text); }
    else if (m.kind === "reaction" && evidence === "owner") lines.push(`[${hhmm(m.at)}] ${who} reacted ${m.text.replace(/\n+/g, " / ")}`); // shows what was reacted to, which may quote mail: never evidence
    else if (m.kind === "chat") lines.push(`[${hhmm(m.at)}] assistant (context only): ${m.text.slice(0, LIMITS.line).replace(/\n+/g, " / ")}`);
  }
  return { lines, text: said.join("\n"), count: said.length };
}

// The prompt, for any conversation: its notes as they are, and what was said since the last dream. `subject`: whose notes they are.
export function dreamPrompt(now: Date, subject: string, notes: readonly NoteFile[], lines: readonly string[]): string {
  const conv = lines.join("\n");
  const cut = conv.length > MAX_PROMPT_CONVERSATION_CHARS ? conv.slice(-MAX_PROMPT_CONVERSATION_CHARS) : conv;
  const current = notes.map((n) => `### ${n.file}\n${n.raw.trim()}`).join("\n\n").slice(0, MAX_PROMPT_NOTES_CHARS);
  return [
    clockLine(now),
    `The notes you keep about ${subject} right now (one file per fact; MEMORY.md is the index and is updated for you):\n${fence("current_notes", current || "(none yet)")}`,
    `What ${subject} said and did since the last dream, oldest first:\n${fence("conversation", cut || "(nothing)")}`,
    `Propose the changes to the notes, if any.`,
  ].join("\n\n");
}

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
export const runnerFor = (payer: Payer = LOGIN): Runner => async (prompt, system = dreamSystem({ subject: OWNER, kind: "owner", categories: preset().notes.dream })) => {
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

// ---- the run itself, the same for every conversation ----

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

type Kind = Conversation["kind"];

// The conversations to look at: the owner's chat, every group that has a folder, every friend of the registry (when TENANTS is on). Each is gated by its own capabilities.
export function dreamConversations(kinds: readonly Kind[] = ["owner", "group", "tenant"]): Conversation[] {
  const out: Conversation[] = [];
  if (kinds.includes("owner")) out.push(ownerConversation());
  if (kinds.includes("group")) for (const g of listGroups()) out.push(groupConversation(g.id));
  if (kinds.includes("tenant") && settings.tenants) for (const r of listTenants()) out.push(tenantConversation(r.id));
  return out;
}

// Whose notes they are, as the prompts say it: the owner's name, a friend's, or the group chat's.
const NAME_MAX = 40;
function subjectOf(conv: Conversation): string {
  if (conv.kind === "group") return `the group chat "${oneLine("group name", (listGroups().find((g) => g.id === conv.groupId)?.name || "a group").replace(/["<>]/g, " "), NAME_MAX)}"`;
  if (conv.kind === "tenant") return oneLine("name", speakerOf(conv).replace(/["<>]/g, " "), NAME_MAX) || "a friend";
  return OWNER;
}

export interface DreamerDeps {
  conversations?: () => Conversation[]; // default: dreamConversations()
  scopeOf?: (conv: Conversation) => Scope; // where its notes, snapshots and categories are (default dreamscope.ts)
  promptOf?: (conv: Conversation, now: Date, notes: readonly NoteFile[], lines: readonly string[]) => { prompt: string; system: string }; // default: the preset's one dream prompt
  payer?: (conv: Conversation, now: Date) => Payer | Refusal; // who pays and may it run (default payer.ts mayRun)
  key?: () => string | undefined; // where a friend's instance key comes from (default settings.tenantApiKey; tests)
  run?: (payer: Payer, conv: Conversation) => Runner; // the model (default runnerFor(payer); tests)
}

export function createDreamer(deps: DreamerDeps = {}) {
  let inFlight: Promise<void> | undefined;
  const scopeOf = deps.scopeOf ?? dreamScope;
  const promptOf =
    deps.promptOf ??
    ((conv, now, notes, lines) => ({
      prompt: dreamPrompt(now, subjectOf(conv), notes, lines),
      system: dreamSystem({ subject: subjectOf(conv), kind: conv.kind, categories: scopeOf(conv).categories }),
    }));
  const payerOf = deps.payer ?? ((conv, now) => mayRun(conv, "dream", { key: deps.key, paused: () => isPaused(now) })); // paused, a usage limit, the day's budget, her cooldown or no key: no attempt, the day stays open

  // One conversation. Returns whether it was dreamt (the nightly cap on groups counts these).
  async function one(conv: Conversation, now: Date): Promise<boolean> {
    if (!allows(conv, "dream")) return false; // its record: active, with the capability; the instance's DREAM switch
    const stateFile = dreamStateFile(conv);
    const today = localDay(now);
    const state = readJson<DreamState>(stateFile, {});
    if (state.day === today) return false;
    const rhythm = preset().rhythm.dream;
    const said = conversationLines(messagesSince(state.lastRunAt, conv.logFile), subjectOf(conv), conv.kind === "group" ? "member" : "owner");
    if (said.count < (conv.kind === "group" ? rhythm.minNewLines.group : rhythm.minNewLines.direct)) return false; // next to nothing said since the last time: left alone, without even marking the day
    const payer = payerOf(conv, now);
    if (isRefusal(payer)) return false;
    writeJson(stateFile, { ...state, day: today }); // before the run: a crash must not mean a retry on every tick
    const tag = { kind: conv.kind, ...(conv.tenantId ? { tenant: conv.tenantId } : {}) };
    try {
      const scope = scopeOf(conv);
      const { prompt, system } = promptOf(conv, now, readNoteFiles(scope.notesDir), said.lines);
      const { plan, snapshot } = await dreamOver(scope, prompt, system, said.text, now, deps.run?.(payer, conv) ?? runnerFor(payer));
      writeJson(stateFile, { day: today, lastRunAt: now.toISOString() });
      const label = conv.kind === "owner" ? "dream" : `${conv.kind} dream (${conv.tenantId ?? subjectOf(conv)})`;
      if (conv.kind !== "tenant") for (const r of plan.rejected) console.log(`${label}: rejected ${r.file || "(no file)"}: ${r.why}`);
      audit("dream_run", snapshot ? "changed" : "no-change", "dream", { ...tag, actions: plan.actions.length, rejected: plan.rejected.length });
      console.log(`${label}: ${plan.actions.length} change(s), ${plan.rejected.length} rejected`);
      if (snapshot && conv.kind !== "tenant") console.log(`${label}: ${describePlan(plan).join("; ")}`); // silent: logged here and in audit.jsonl, undoable from chat; a friend's notes' words stay out of the log
    } catch (e) {
      console.error(`dream (${conv.kind}${conv.tenantId ? ` ${conv.tenantId}` : ""}): failed:`, (e as Error).message);
      audit("dream_run", "failed", "dream", { ...tag, error: (e as Error).message.slice(0, LIMITS.preview) });
    }
    return true;
  }

  async function once(now: Date): Promise<void> {
    let groups = 0;
    for (const conv of (deps.conversations ?? (() => dreamConversations()))()) {
      try {
        if (conv.kind === "group" && groups >= preset().rhythm.dream.maxGroupsPerNight) continue;
        if (await one(conv, now) && conv.kind === "group") groups++;
      } catch (e) {
        console.error(`dream (${conv.key}): failed:`, (e as Error).message); // one conversation failing never keeps another from being dreamt
      }
    }
  }

  // One run at a time; a second caller waits for the first.
  return { run: (now = new Date()) => (inFlight ??= once(now).finally(() => (inFlight = undefined))) };
}
