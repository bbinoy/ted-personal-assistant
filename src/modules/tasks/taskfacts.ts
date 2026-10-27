import { entryFor } from "../../policy/toolmanifest.ts";
import { storeFacts } from "../../tasks/store.ts";

// Code-written facts about a conversation's own task list, for the approval judge: a Notion page edit in a conversation whose tasks moved into its own list is the old table (`fix`, use the task tools). Only counts, never a title.

const NOTION_WRITES = new Set(["page-write"]);
const isNotionWrite = (tool: string): boolean => entryFor(tool)?.cap === "notion" && NOTION_WRITES.has(entryFor(tool)?.action ?? "");

/** For the judge: on a Notion page write in a conversation whose tasks were imported into its own list, one line saying so (else ""). Before the import a Notion edit is judged as before. */
export function tasksNote(tool: string, conversation: string): string {
  if (!isNotionWrite(tool)) return "";
  const f = storeFacts(conversation);
  if (!f.imported) return "";
  return `\nTasks: this conversation's tasks live in the assistant's own task list (${f.items} items, ${f.imported} imported from Notion): a Notion edit that adds, ticks off, changes, reorders or removes a task edits the old table and should be done with the task tools instead (add_task, update_task, complete_task, snooze_task, drop_task)`;
}
