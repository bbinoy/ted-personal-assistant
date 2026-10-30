import { auditSource } from "./runkind.ts";
// The key of the owner's chat (Conversation.key). Its own file so that a module that only needs to tell the owner's chat from another conversation (turnscope.ts)
// does not load the send tool and everything it imports. The three helpers that name conversation keys live here too (approvals, policy and the pipeline all need them).
export const OWNER_KEY = "owner"; // a group's key is its group id, a tenant's is tenantKey(id)
export const UNSCOPED_KEY = "unscoped"; // the state key of a bare run that names no conversation (a test, never production: runFor always names one): never the owner's
export const tenantKey = (id: string): string => `tenant:${id}`;
export const isTenantKey = (key: string): boolean => key.startsWith("tenant:");
// A group a friend sponsors (groupstore.ts sponsorOf) is that friend's data like her own chat: the keys of such groups, filled as their sponsors become known (and at start, from the groups' records).
const sponsoredKeys = new Set<string>();
export const noteSponsored = (groupId: string, friend: boolean): void => void (friend ? sponsoredKeys.add(groupId) : sponsoredKeys.delete(groupId));
/** The conversation's words belong to a friend: her own chat, or a group she sponsors (audit rows are wordless, only ids and counts reach the admin's views). */
export const isFriendKey = (key: string): boolean => isTenantKey(key) || sponsoredKeys.has(key);

// The kind of conversation a key names, from the key alone (the tools that are built per key: send, draw, voice), and its audit label (runkind.ts auditSource: the owner's chat
// is "chat", a group's "group", a friend's "tenant"). A name for the log only; nothing is decided by it.
export const kindOfKey = (key: string): "owner" | "group" | "tenant" => (key === OWNER_KEY ? "owner" : isTenantKey(key) ? "tenant" : "group");
export const sourceOfKey = (key: string): "chat" | "group" | "tenant" => auditSource({ who: kindOfKey(key), attended: true }) as "chat" | "group" | "tenant";
