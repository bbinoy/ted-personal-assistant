import { zoneOf } from "../tenants/tenants.ts";
import { groupTasksReply } from "../tasks/grouptasks.ts";
import { learnedReply } from "./learnedreplies.ts";
import type { Conversation, Held } from "./conversationmodel.ts";

// The messages that are about the conversation's own lists, handled in code before any model (intake.ts calls this as a one-line hook): "undo 2" / "confirm 1" on the "🧠 Learned overnight"
// list (learnedreplies.ts), and "/tasks" said in a group (the owner's and a friend's /tasks is ownercommands.ts; a group has no other command). true: handled here.
export async function taskReply(conv: Conversation, m: Pick<Held, "text" | "quote" | "fromName" | "picture" | "document" | "edit">, say: (text: string) => Promise<unknown>): Promise<boolean> {
  if (m.picture || m.document || m.edit) return false; // a caption or an edit never answers
  if (await learnedReply(conv, m, say)) return true;
  const listed = conv.kind === "group" ? groupTasksReply(conv, m.text, zoneOf(conv)) : undefined;
  if (listed !== undefined) return void (await say(listed)), true;
  return false;
}
