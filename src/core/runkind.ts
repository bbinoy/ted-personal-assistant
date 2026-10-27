import type { Source } from "./audit.ts";

// WHAT A RUN IS, in two independent facts (CLAUDE.md §2: one agent). Nothing else decides which tools a run has or whether it may ask.
//   who       whose run: the owner's conversation, a group's, a friend's (`tenant`), or the browse worker a run starts. Derived from the conversation (Conversation.kind).
//   attended  someone is waiting for the answer in the chat: a message turn. A look, its expert and everything it starts are unattended: they never ask (permissions.ts
//             UNATTENDED_SKIP), pay nothing and have the tools that do not need a person (the manifest's `attended`, toolmanifest.ts).
// Whether a conversation HAS mail, draw, voice, a card is its capability set (capabilities.ts), never the trigger or "is owner".
export type Who = "owner" | "group" | "tenant" | "browse";
export interface RunKind {
  readonly who: Who;
  readonly attended: boolean;
}

// The audit log's label for who acted (audit.ts Source): a name for the log only, nothing is decided by it.
export const auditSource = (k: RunKind): Source => (k.who === "browse" ? "browse" : k.who !== "owner" ? "group" : k.attended ? "chat" : "background");
