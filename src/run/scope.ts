import type { Conversation } from "../conversation/conversationmodel.ts";
import { onLogin } from "../core/ownerkey.ts";
import { speakerOf, zoneOf } from "../tenants/tenants.ts";
import { readNotes } from "../memory/notes.ts";
import { capabilitiesOf } from "../policy/capabilities.ts";
import { entryFor } from "../policy/toolmanifest.ts";
import { PROFILES } from "./profiles.ts";
import { OWNER } from "../core/settings.ts";
import { PLUGIN, skillsFor } from "../modules/skills.ts";

// What a heartbeat run is made of for ONE conversation, read from its capability set (capabilities.ts capabilitiesOf) and nothing else: the owner, a group and a friend
// are asked the same way and differ only in data. A conversation that can read mail, a calendar or tasks is told to be proactive and may delegate heavy work to the
// expert; one that can not (a group, a friend without Google) has only its chat log and its notes to look at, so it acts on what a note asks or the log promised.

export interface Looker {
  who: string; // how the instruction names the person: the owner, her name, "the group"
  zone: string; // its clock (timezone.ts)
  own: boolean; // the owner's conversation: on the login, with the connectors and the whole plugin
  group: boolean;
  reads: boolean; // it can read mail, a calendar or tasks of its own
  mail: boolean; // it has mail tools
  experts: boolean; // it may delegate heavy work to the expert: whoever has something to read
  brief: boolean; // it has the daily-brief skill
  sources: string; // what the instruction lists after the chat log
  skills: readonly string[]; // the skills of its run (plugin-qualified)
}

const READS = ["mail", "calendar", "notion"] as const;

export function lookerOf(conv: Conversation): Looker {
  const caps = capabilitiesOf(conv);
  const own = onLogin(conv);
  const skills = own ? PROFILES.heartbeat.skills : skillsFor(caps);
  const reads = READS.some((c) => caps.has(c));
  const parts = [caps.has("mail") && "the inbox mail you have not looked at yet (see below)", caps.has("calendar") && "the calendar for the next 36 hours", caps.has("notion") && "tasks"].filter(Boolean);
  return {
    who: own ? OWNER : conv.kind === "group" ? "the group" : speakerOf(conv),
    zone: zoneOf(conv),
    own,
    group: conv.kind === "group",
    reads,
    mail: caps.has("mail"),
    experts: reads,
    brief: skills.includes(`${PLUGIN}:daily-brief`),
    sources: [...parts, "and your notes and their schedules"].join(", "),
    skills,
  };
}

// The one rule for "is there anything this conversation could do on its own?": it can read mail, a calendar or tasks of its own, or its notes say something (a schedule, a
// promise, a wish). Without either a look would be a model call for nothing, so none is made and nothing is recorded.
export const hasSomethingToLookAt = (conv: Conversation, now: Date): boolean => READS.some((c) => capabilitiesOf(conv).has(c)) || readNotes(now, conv.notesDir, zoneOf(conv)).length > 0;

// The tools of a friend's or a group's heartbeat run: its capability set, less the notes' file tools. Its notes are in the prompt as data and a run that reads mail has no
// way to change them (the owner's can write only status-* notes, statusnote.ts).
// And the task tools that change the list (finish, drop, snooze, confirm...): an unattended run may only list and suggest (modules/tasks/module.ts).
export const unattendedTools = (tools: ReadonlySet<string>): Set<string> => new Set([...tools].filter((t) => entryFor(t)?.action !== "note-file" && entryFor(t)?.action !== "task-write"));
