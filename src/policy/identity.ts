import type { Conversation } from "../conversation/conversationmodel.ts";

// ONE row per conversation of what only its kind says (CLAUDE.md §2), beside capabilitiesOf: whether it is the owner's own chat, whether it is a group. The prompts, the looker, the expert and the
// dream read it; nothing else names a kind to pick these. (The audit label and the failure scope are the kind itself: core/runkind.ts auditSource, heartbeat/notices.ts.)
export function identity(conv: Pick<Conversation, "kind">) {
  const own = conv.kind === "owner";
  return { own, group: conv.kind === "group" };
}
