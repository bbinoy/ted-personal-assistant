import type { Conversation } from "../conversation/conversationmodel.ts";
import { preset } from "../core/preset.ts";

// ONE row per conversation of what only its kind says (CLAUDE.md §2), beside capabilitiesOf: whether it is the owner's own chat, whether it is a group, and which note
// categories it has (the owner all of them, a group or a friend the preset's notes.others; the owner's own list for the dream). The prompts, the looker, the expert and the
// dream read it; nothing else names a kind to pick these. (The audit label and the failure scope are the kind itself: core/runkind.ts auditSource, heartbeat/notices.ts.)
export function identity(conv: Pick<Conversation, "kind">) {
  const own = conv.kind === "owner";
  const { notes } = preset();
  return { own, group: conv.kind === "group", categories: own ? notes.categories : notes.others, dreamCategories: own ? notes.dream : notes.others };
}
