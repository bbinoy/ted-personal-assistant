import { liveConvDb } from "../core/convdb.ts";
import { convIdOfKey } from "../core/convpaths.ts";
import { tasksText } from "./render.ts";

// The two group-only pieces of the task list, in code: "/tasks" said in a group (read-only, from the group's own list, no model, no cost; any member may ask), and whether a member is to be
// told (by the model, in its words) that a reminder she asks for in the group is the GROUP's task (everyone sees it): once per member, persisted.

/** "/tasks" said in a group: the group's list. undefined: not the command, or not a group. */
export function groupTasksReply(conv: { readonly kind: "owner" | "group" | "tenant"; readonly key: string }, text: string, zone: string, now = Date.now()): string | undefined {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (conv.kind !== "group" || t !== "/tasks") return undefined;
  return tasksText(conv.key, now, zone);
}

/** Once per member: a reminder asked for in a group is the group's task (everyone sees it), not a private one. true the first time for this member (the model is told to say so), then false. Persisted. */
export function groupReminderNote(key: string, member: string, now: number): boolean {
  const db = liveConvDb(convIdOfKey(key));
  if (!db) return false;
  const name = member.trim().slice(0, 80) || "a member";
  const r = db.run("INSERT OR IGNORE INTO group_remind_noted (member, at) VALUES (?, ?)", name, now);
  return r.changes > 0;
}
