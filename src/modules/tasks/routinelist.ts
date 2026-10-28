import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ConvRef } from "../../core/convpaths.ts";
import { isNotePath, parseNote, readNotes } from "../../memory/notes.ts";
import { parseRepeat } from "../../tasks/repeat.ts";
import { nextText, routineLines, type Routine } from "../../tasks/routines.ts";

// What is scheduled in a conversation: its routine notes, and only those (`routine-<slug>.md`: front matter `when:` = a repeat rule, body = what to do; tasks/routines.ts plans them, heartbeat/facts.ts hands the due one
// to the look). The daily brief, the evening wrap and the weekly review are such notes too (their body says to run the skill). A note whose `when:` cannot be read is not scheduled but listed in `broken`, so it is told
// to the model instead of silently never firing.

export const MAX_NOTE_ROUTINES = 20; // per conversation: a runaway list of notes must not become a runaway list of runs
const NO_WHEN = "has no `when:` line in its front matter";

export interface Scheduled { routines: Routine[]; broken: string[] }

export function scheduledIn(o: { notesDir: string; zone: string; now: Date }): Scheduled {
  const routines: Routine[] = [];
  const broken: string[] = [];
  for (const n of readNotes(o.now, o.notesDir, o.zone, "routine-").slice(0, MAX_NOTE_ROUTINES)) {
    const p = n.when ? parseRepeat(n.when) : undefined;
    if (p?.ok) routines.push({ name: n.file.replace(/\.md$/, ""), rule: p.rule, instruction: n.text });
    else broken.push(`${n.file} ${p && !p.ok ? `has a when: line that cannot be read (${p.error})` : NO_WHEN}`);
  }
  return { routines, broken };
}

// After a Write or Edit of a routine note: what the model is told at once (the PostToolUse hook, run/agentrun.ts) so a schedule that cannot run is never silent, and so it can tell the person how the
// schedule was read and when it runs first. Undefined for anything else.
export function routineNoteReply(tool: string, input: Record<string, unknown>, dir: string | undefined, zone: string | undefined, now: Date = new Date()): string | undefined {
  const path = input.file_path;
  if ((tool !== "Write" && tool !== "Edit") || !dir || !zone || typeof path !== "string" || !isNotePath(path, dir) || !basename(path).startsWith("routine-")) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const file = basename(path);
  const note = parseNote(file, raw);
  const p = note?.when ? parseRepeat(note.when) : undefined;
  if (!note || !p?.ok) return `This routine will NOT run: ${file} ${!note ? "has no text to do" : p && !p.ok ? `has a when: line that cannot be read (${p.error})` : NO_WHEN}. Fix it (front matter \`when: every weekday at 18:30\`, then the instruction as the body) and tell the person what you set.`;
  return `Routine saved: ${nextText({ name: file, rule: p.rule, instruction: note.text }, now, zone)} (${p.rule.zone ?? zone}). Tell the person this schedule and when it runs next, in your own words.`;
}

// "/status" and the doctor: one line per routine note with its schedule, next and last run, and one per note that cannot run.
export function scheduleLines(conv: ConvRef, o: Parameters<typeof scheduledIn>[0]): string[] {
  const { routines, broken } = scheduledIn(o);
  return [...routineLines(conv, routines, o.now, o.zone), ...broken.map((b) => `${b}; it never runs`)];
}
