import { convPaths, OWNER_CONV } from "./convpaths.ts";

// The key of the owner's chat (Conversation.key). Its own file so that a module that only needs to tell the owner's chat from another conversation (turnscope.ts)
// does not load the send tool and everything it imports. The three helpers that name conversation keys live here too (approvals, policy and the pipeline all need them).
export const OWNER_KEY = "owner"; // a group's key is its group id, a tenant's is tenantKey(id)
export const tenantKey = (id: string): string => `tenant:${id}`;
export const isTenantKey = (key: string): boolean => key.startsWith("tenant:");

// The owner's session pointer (a run's resumed SDK session, run/session.ts); every conversation's is session.json in its own folder (core/convpaths.ts). Here because the tenant registry names it too.
export const OWNER_SESSION_FILE = convPaths(OWNER_CONV).session;

// The policy source of a conversation, from its key alone (the tools that are built per key: send, draw, voice): the owner's chat is "chat", every other conversation (a group, a tenant)
// is the isolated "group" source. The same rule as Conversation.source (conversationmodel.ts).
export const sourceOfKey = (key: string): "chat" | "group" => (key === OWNER_KEY ? "chat" : "group");

// Is this the conversation that runs on the instance's own Claude login, with its connectors (the owner's)? A group is isolated, a friend runs on the instance key.
export const onLogin = (conv: { readonly kind: string }): boolean => conv.kind === "owner";
