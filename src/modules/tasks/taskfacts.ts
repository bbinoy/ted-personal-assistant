import { entryFor } from "../../policy/toolmanifest.ts";
import { storeFacts } from "../../tasks/store.ts";
import { OWNER } from "../../core/settings.ts";

// Code-written facts about a conversation's own task list, for the two places that must know whether the tasks have moved out of Notion yet: the approval judge (a Notion page edit
// after the import is the old table: `fix`, use the task tools) and the owner's chat (an almost empty list and no import yet: offer the import once). Only counts, never a title.

const NOTION_WRITES = new Set(["page-write"]);
const isNotionWrite = (tool: string): boolean => entryFor(tool)?.cap === "notion" && NOTION_WRITES.has(entryFor(tool)?.action ?? "");

/** For the judge: on a Notion page write in a conversation whose tasks were imported into its own list, one line saying so (else ""). Before the import a Notion edit is judged as before. */
export function tasksNote(tool: string, conversation: string): string {
  if (!isNotionWrite(tool)) return "";
  const f = storeFacts(conversation);
  if (!f.imported) return "";
  return `\nTasks: this conversation's tasks live in the assistant's own task list (${f.items} items, ${f.imported} imported from Notion): a Notion edit that adds, ticks off, changes, reorders or removes a task edits the old table and should be done with the task tools instead (add_task, update_task, complete_task, snooze_task, drop_task)`;
}

// At most this many items and none imported: the list has not really started, so the owner's tasks may still be in Notion.
const NEARLY_EMPTY = 2;

/** For the owner's chat (its turn context, shown once per session while it holds): the list is (almost) empty and nothing was ever imported, so offer the import once. `declined`: a note says
 *  the owner does not want it (a setup-tasks note). Undefined when there is nothing to say. */
export function importOffer(conversation: string, declined: boolean): string | undefined {
  if (declined) return undefined;
  const f = storeFacts(conversation);
  if (f.imported > 0 || f.items > NEARLY_EMPTY) return undefined;
  return `Your task list holds ${f.items} item${f.items === 1 ? "" : "s"} and nothing was ever imported. If ${OWNER}'s tasks still live in a Notion table (they mention their tasks, or you see task pages in Notion), offer ONCE, in one sentence, to move them over with ted-personal-assistant:task-import, and do not edit tasks in Notion meanwhile unless ${OWNER} asks. If they say no, save a setup note setup-tasks.md saying so and do not offer again.`;
}
