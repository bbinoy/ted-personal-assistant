import { rowsOf, type ToolModule } from "../types.ts";
import { hasMailItems } from "../../tasks/store.ts";

// tasks (tasktools.ts): the conversation's own task list, promises and waiting-on items, in its assistant.db. All of it is the conversation's OWN data, so nothing is asked: an add or a change is a
// journal line and a row in the item's history, never an approval. What an unattended run (a heartbeat look, the mail handler) may do is narrower, and that is the manifest, not the prompt: the
// background source has only list_tasks (a read) and add_task, and the server marks what it adds as origin `inferred` (10 a day at most); changing, finishing, dropping and snoozing exist
// for the owner's, a friend's and a group's chat only (and a friend's or group's own look has them removed from its tool set, run/scope.ts unattendedTools). Nothing here deletes.
const tasks = rowsOf("mcp__tasks__", "tasks", "tasks");
const WITH_BACKGROUND = ["chat", "group", "background"] as const;
// import_tasks_preview / import_tasks_commit (tasks/import.ts): the one-time move of the owner's Notion tasks. Owner chat only: the server hands them to no other key, and an unattended run has them removed (run/scope.ts).
export const TASK_WRITES = "update_task complete_task drop_task snooze_task";
export const tasksModule: ToolModule = {
  name: "tasks",
  connection: {
    kind: "in-process",
    name: "tasks",
    // A conversation to keep the list in: the owner's chat, a group, a friend, or the owner's background run. An isolated run without one gets no server rather than the owner's list.
    when: (ctx) =>
      !ctx.browsing &&
      (ctx.source === "chat" || ctx.source === "group" || ctx.source === "background") &&
      !!(ctx.tenant?.key ?? ctx.groupId ?? ctx.key ?? (ctx.source === "background" ? "owner" : undefined)) &&
      ctx.offers("mcp__tasks__add_task"),
  },
  rows: [...tasks("read", "list_tasks", { only: WITH_BACKGROUND }), ...tasks("task-add", "add_task", { only: WITH_BACKGROUND }), ...tasks("task-write", TASK_WRITES, { only: ["chat", "group"] }), ...tasks("task-import", "import_tasks_preview import_tasks_commit", { only: ["chat"] })],
  free: true,
  trusted: true, // the list is the conversation's own; items that came from mail or a member are fenced as data when listed (tasktools.ts)
  // ... but an item the assistant added from a mail carries the mail's words: a run that lists a list holding one has read untrusted text (the judge is told, permissions.ts), like reading the mail
  untrustedWhen: (_tool, conversation) => hasMailItems(conversation),
};
