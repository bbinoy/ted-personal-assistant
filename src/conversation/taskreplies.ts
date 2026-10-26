import { zoneOf } from "../tenants/tenants.ts";
import { groupTasksReply } from "../tasks/grouptasks.ts";
import type { Conversation, Held } from "./conversationmodel.ts";

// "/tasks" said in a group, handled in code before any model (intake.ts calls this as a one-line hook; the owner's and a friend's /tasks is ownercommands.ts). true: handled here.
export async function taskReply(conv: Conversation, m: Pick<Held, "text" | "quote" | "fromName" | "picture" | "document" | "edit">, say: (text: string) => Promise<unknown>): Promise<boolean> {
  if (m.picture || m.document || m.edit) return false; // a caption or an edit never answers
  const listed = conv.kind === "group" ? groupTasksReply(conv, m.text, zoneOf(conv)) : undefined;
  if (listed !== undefined) return void (await say(listed)), true;
  return false;
}
