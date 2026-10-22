import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emit } from "../core/events.ts";
import { allows } from "../policy/capabilities.ts";
import { owner as ownerConversation, group as groupConversation, tenant as tenantConversation, type Conversation } from "./conversationmodel.ts";
import { oneShot } from "../tenants/haiku.ts";
import { isRefusal, LOGIN, mayRun, type Payer, type Refusal } from "../tenants/payer.ts";
import { applyPlan, baseOf } from "../memory/dreamapply.ts";
import { planOps, type NoteFile, type Plan, type Scope } from "../memory/dreamplan.ts";
import { dreamScope, dreamStateConv, readDream, writeDream, type DreamState } from "../modules/memory/dreamscope.ts";
import { clockLine } from "../core/brief.ts";
import { fence } from "../core/fence.ts";
import { listGroups } from "./groupstore.ts";
import { likedLines } from "./feedback.ts";
import { foldEdits, messagesSince, withoutDeleted, type Sent } from "../core/messages.ts";
import { NOTES_DIR, STATUS_PREFIX } from "../memory/notes.ts";
import { isPaused, localDay } from "../core/pause.ts";
import { dreamSystem } from "../run/persona.ts";
import { preset } from "../core/preset.ts";
import { OWNER, settings } from "../core/settings.ts";
import { listTenants, speakerOf } from "../tenants/tenants.ts";
import { LIMITS, oneLine } from "../core/sanitize.ts";

// The dream: once a day, on the first tick at or after DREAM_HOUR (dreamTrigger, a plain tick job: nothing else starts it), a model with NO tools reads what a conversation's person said since the last dream (their messages and
// reactions) next to that conversation's notes, and proposes changes to the notes as JSON: things worth remembering, and a tidy-up (merge duplicates,
// drop what has expired). It cannot touch anything itself. Code decides what is applied:
//   - a new fact needs a verbatim quote from the person's own words that day (checked here);
//   - a merge may only shorten what it merges; an expired note is checked against its date;
//   - setup and voice notes are not the dream's to change;
//   - a cap on changes per run, and a snapshot first so "undo the dream" puts everything back.
// ONE dreamer for every conversation (createDreamer): the owner's chat, each group and each friend. What differs is data: whose notes (dreamScope), the
// note categories they have (the preset), whose words count as evidence (a private chat's person, or a group's members), who pays (payer.ts mayRun) and the
// state in the conversation's own assistant.db. A conversation is dreamt when its capability set has `dream` (capabilities.ts), once it has enough new lines
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
// that": neither is evidence. So a 👍 or 👎 never creates a note by itself. What a 👎 can lead to is an OFFER (feedback.ts) and the owner's 👍 or "yes" on it; that saves a
// confirmed note (origin: owner) at once, so it is a note by the time the dream reads, not a line of evidence. A message she deleted is not evidence at all, and an edited one counts once, as edited. `count`: how many lines of evidence
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
export function dreamPrompt(now: Date, subject: string, notes: readonly NoteFile[], lines: readonly string[], liked: readonly string[] = []): string {
  const conv = lines.join("\n");
  const cut = conv.length > MAX_PROMPT_CONVERSATION_CHARS ? conv.slice(-MAX_PROMPT_CONVERSATION_CHARS) : conv;
  const current = notes.map((n) => `### ${n.file}\n${n.raw.trim()}`).join("\n\n").slice(0, MAX_PROMPT_NOTES_CHARS);
  return [
    clockLine(now),
    `The notes you keep about ${subject} right now (one file per fact; MEMORY.md is the index and is updated for you):\n${fence("current_notes", current || "(none yet)")}`,
    `What ${subject} said and did since the last dream, oldest first:\n${fence("conversation", cut || "(nothing)")}`,
    ...(liked.length ? [`Notes or kinds of action whose unprompted messages ${subject} gave a thumbs-up, with how often (a reason to KEEP a related note, never to add or change one; a thumbs-up is not evidence):\n${fence("liked", liked.join("\n"))}`] : []),
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
  const r = await oneShot({ system, prompt, payer, schema: SCHEMA, model: settings.model, gate: "dream", options: { maxTurns: 3, maxBudgetUsd: 0.6 } });
  if (!r.ok) throw r.error ?? new Error("the dream run failed");
  return r.output;
};

export const readNoteFiles = (dir: string = NOTES_DIR): NoteFile[] => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md" && !f.startsWith(STATUS_PREFIX)).sort().map((file) => ({ file, raw: readFileSync(join(dir, file), "utf8") }));
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
  return { plan, snapshot: applyPlan(plan, now, scope, baseOf(notes)) }; // `notes`: as read before the model ran; a note edited meanwhile is not overwritten
}

export const describePlan = (plan: Plan): string[] => {
  const icon = { add: "➕ saved", update: "✏️ updated", merge: "🔀 merged into" } as const;
  return plan.actions.map((a) => (a.kind === "delete" ? `➖ forgot ${a.file} (${a.why})` : `${icon[a.kind]} ${a.file}: ${a.description}`));
};

// ---- the daily run ----

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
  busy?: (conv: Conversation) => boolean; // a turn of it is settling, queued or running (pipeline.busy): the conversation is skipped for now (its day stays open, the hourly retry comes back)
  run?: (payer: Payer, conv: Conversation) => Runner; // the model (default runnerFor(payer); tests)
}

export function createDreamer(deps: DreamerDeps = {}) {
  let inFlight: Promise<void> | undefined;
  const scopeOf = deps.scopeOf ?? dreamScope;
  const promptOf =
    deps.promptOf ??
    ((conv, now, notes, lines) => ({
      prompt: dreamPrompt(now, subjectOf(conv), notes, lines, conv.kind === "group" ? [] : likedLines(conv)),
      system: dreamSystem({ subject: subjectOf(conv), kind: conv.kind, categories: scopeOf(conv).categories }),
    }));
  const payerOf = deps.payer ?? ((conv, now) => mayRun(conv, "dream", { key: deps.key, paused: () => isPaused(now) })); // paused, a usage limit, the day's budget, her cooldown or no key: no attempt, the day stays open

  // One conversation. Returns whether it was dreamt (the nightly cap on groups counts these).
  async function one(conv: Conversation, now: Date): Promise<boolean> {
    if (!allows(conv, "dream")) return false; // its record: active, with the capability; the instance's DREAM switch
    if (deps.busy?.(conv)) return false; // someone is talking to it: the dream is for the quiet, and does not tidy notes under a turn that is using them
    const stateConv = dreamStateConv(conv);
    const today = localDay(now);
    const state: DreamState = readDream(stateConv);
    if (state.day === today) return false;
    const rhythm = preset().rhythm.dream;
    const said = conversationLines(messagesSince(state.lastRunAt, conv.logFile), subjectOf(conv), conv.kind === "group" ? "member" : "owner");
    if (said.count < (conv.kind === "group" ? rhythm.minNewLines.group : rhythm.minNewLines.direct)) return false; // next to nothing said since the last time: left alone, without even marking the day
    const payer = payerOf(conv, now);
    if (isRefusal(payer)) return false;
    writeDream(stateConv, { ...state, day: today }); // before the run: a crash must not mean a retry on every tick
    const tag = { kind: conv.kind, ...(conv.tenantId ? { tenant: conv.tenantId } : {}) };
    try {
      const scope = scopeOf(conv);
      const { prompt, system } = promptOf(conv, now, readNoteFiles(scope.notesDir), said.lines);
      const { plan, snapshot } = await dreamOver(scope, prompt, system, said.text, now, deps.run?.(payer, conv) ?? runnerFor(payer));
      writeDream(stateConv, { day: today, lastRunAt: now.toISOString() });
      const label = conv.kind === "owner" ? "dream" : `${conv.kind} dream (${conv.tenantId ?? subjectOf(conv)})`;
      if (conv.kind !== "tenant") for (const r of plan.rejected) console.log(`${label}: rejected ${r.file || "(no file)"}: ${r.why}`);
      emit({ type: "dream", result: snapshot ? "changed" : "no-change", source: "dream", conv: conv.key, friend: false, meta: { ...tag, actions: plan.actions.length, rejected: plan.rejected.length }, text: `Tidied my notes in the nightly dream (${plan.actions.length} change${plan.actions.length === 1 ? "" : "s"})` });
      console.log(`${label}: ${plan.actions.length} change(s), ${plan.rejected.length} rejected`);
      if (snapshot && conv.kind !== "tenant") console.log(`${label}: ${describePlan(plan).join("; ")}`); // silent: logged here and in audit.jsonl, undoable from chat; a friend's notes' words stay out of the log
    } catch (e) {
      console.error(`dream (${conv.kind}${conv.tenantId ? ` ${conv.tenantId}` : ""}): failed:`, (e as Error).message);
      emit({ type: "dream", result: "failed", source: "dream", conv: conv.key, friend: false, meta: { ...tag, error: (e as Error).message.slice(0, LIMITS.preview) } });
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

// The daily trigger: a tick job that runs `run` (the dreamers) on the first tick at or after `hour` (local), and looks again at most once an hour for the rest of the day (a
// conversation that had too little to dream about may have more later; one already dreamt today is skipped by its own state). Before the hour nothing runs, so a
// dream never starts in the middle of the owner's evening. Plain code: no model decides when.
export function dreamTrigger(run: () => unknown, o: { hour?: () => number; everyMs?: number; enabled?: () => boolean } = {}) {
  const hour = o.hour ?? (() => settings.dreamHour);
  const everyMs = o.everyMs ?? 60 * 60_000;
  let tried: { day: string; at: number } | undefined;
  return (now: Date = new Date()): unknown => {
    if ((o.enabled ?? (() => settings.dream))() === false || now.getHours() < hour()) return undefined;
    const day = localDay(now);
    if (tried && tried.day === day && now.getTime() - tried.at < everyMs) return undefined;
    tried = { day, at: now.getTime() };
    return run();
  };
}
