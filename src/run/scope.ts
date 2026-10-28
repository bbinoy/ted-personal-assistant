import type { Conversation } from "../conversation/conversationmodel.ts";
import { speakerOf, zoneOf } from "../tenants/tenants.ts";
import { readNotes } from "../memory/notes.ts";
import { capabilitiesOf } from "../policy/capabilities.ts";
import { OWNER, settings } from "../core/settings.ts";
import { skillsFor } from "../modules/skills.ts";

// What a conversation's background checks are made of, read from its capability set (capabilities.ts capabilitiesOf) and nothing else: the owner, a group and a friend
// are asked the same way and differ only in data. A conversation that can read mail, a calendar or tasks is told to be proactive ; one that can not (a group, a friend without Google) has only its chat log and its notes to look at, so it acts on what a note asks or the log promised.

export interface Looker {
  who: string; // how the instruction names the person: the owner, her name, "the group"
  zone: string; // its clock (timezone.ts)
  own: boolean; // the owner's conversation: on the login, with the connectors and the whole plugin
  group: boolean;
  reads: boolean; // it can read mail, a calendar or tasks of its own
  mail: boolean; // it has mail tools
  tasks: boolean; // it has the task list (an unattended look may add to it)
  meetings: boolean; // meeting prep is on and it has a calendar: any run that reads it records the upcoming meetings (modules/meetings); heartbeat/preptick.ts claims them and the look says them
  sources: string; // what the instruction lists after the chat log
  skills: readonly string[]; // the skills of its run (plugin-qualified)
}

const READS = ["mail", "calendar", "notion"] as const;

export function lookerOf(conv: Pick<Conversation, "kind" | "tenantId">, mailOn: boolean = settings.mail): Looker {
  const caps = capabilitiesOf(conv);
  const own = caps.has("login");
  const skills = skillsFor(caps);
  const reads = READS.some((c) => caps.has(c));
  const mail = caps.has("mail") && (!own || mailOn); // (the owner's mail is her mail provider's: none, no mail to read)
  const parts = [mail && "the inbox (list it with the mail tools and ask seen_mail which mail is new)", caps.has("calendar") && "the calendar for the next 36 hours", caps.has("notion") && "tasks"].filter(Boolean);
  return {
    who: own ? OWNER : conv.kind === "group" ? "the group" : speakerOf(conv),
    zone: zoneOf(conv),
    own,
    group: conv.kind === "group",
    reads,
    mail,
    tasks: caps.has("tasks"),
    meetings: settings.prepMinutes > 0 && caps.has("calendar"),
    sources: [...parts, "and your notes"].join(", "),
    skills,
  };
}

// The one rule for "is there anything this conversation could do on its own?": it can read mail, a calendar or tasks of its own, or its notes say something (a schedule, a
// promise, a wish). Without either a look would be a model call for nothing, so none is made and nothing is recorded.
export const hasSomethingToLookAt = (conv: Conversation, now: Date): boolean => READS.some((c) => capabilitiesOf(conv).has(c)) || readNotes(now, conv.notesDir, zoneOf(conv)).length > 0;
