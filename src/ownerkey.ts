// The key of the owner's chat (Conversation.key). Its own file so that a module that only needs to tell the owner's chat from another conversation (turnscope.ts)
// does not load the send tool and everything it imports.
export const OWNER_KEY = "owner"; // a group's key is its group id, a tenant's is tenantKey(id) (send.ts)
