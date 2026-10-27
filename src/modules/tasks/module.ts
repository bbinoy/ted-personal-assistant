import { rowsOf, type ToolModule } from "../types.ts";
import { hasMailItems } from "../../tasks/store.ts";

// tasks (tasktools.ts): the conversation's own task list, promises and waiting-on items, in its assistant.db. All of it is the conversation's OWN data, so nothing is asked: an add or a change is a
// journal line and a row in the item's history, never an approval. What an unattended run (a heartbeat look, the mail handler) may do is narrower, and that is the manifest, not the prompt: an
// unattended run (a look of any conversation) has only list_tasks (a read) and add_task, and the server marks what it adds as origin `inferred` (10 a day at most); changing, finishing, dropping and snoozing are rows
// marked `attended: true`: they are free of the judge, and a run that has read mail must not rewrite the person's list. Nothing here deletes.
const tasks = rowsOf("mcp__tasks__", "tasks", "tasks");
// import_tasks_preview / import_tasks_commit (tasks/import.ts): the one-time move of the owner's Notion tasks. Owner chat only (`attended: true`, `who: owner`): the server hands them to no other key.
export const TASK_WRITES = "update_task complete_task drop_task snooze_task";
export const tasksModule: ToolModule = {
  name: "tasks",
  connection: {
    kind: "in-process",
    name: "tasks",
    // A conversation to keep the list in: every run of the owner's, a group's or a friend's conversation has its own.
    when: (ctx) => !!ctx.key && ctx.offers("mcp__tasks__add_task"),
  },
  rows: [...tasks("read", "list_tasks"), ...tasks("task-add", "add_task"), ...tasks("task-write", TASK_WRITES, { attended: true }), ...tasks("task-import", "import_tasks_preview import_tasks_commit", { attended: true, who: ["owner"] })],
  free: true,
  trusted: true, // the list is the conversation's own; items that came from mail or a member are fenced as data when listed (tasktools.ts)
  // ... but an item the assistant added from a mail carries the mail's words: a run that lists a list holding one has read untrusted text (the judge is told, permissions.ts), like reading the mail
  untrustedWhen: (_tool, conversation) => hasMailItems(conversation),
};
