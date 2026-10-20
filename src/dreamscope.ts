import { join } from "node:path";
import type { Conversation } from "./conversationmodel.ts";
import { OWNER_SCOPE, type Scope } from "./dreamplan.ts";
import { groupDir, groupScope } from "./groupstore.ts";
import { preset } from "./preset.ts";
import { settings } from "./settings.ts";
import { tenantById, tenantContext } from "./tenants.ts";

// WHERE a conversation's dream works (dream.ts): its notes folder, the snapshots beside it, the note categories it has (the preset's notes.dream for the owner,
// notes.group, notes.tenant) and the state file of its last run, all inside the conversation's own folder. The dream and "undo the dream" (memory-tools.ts) both
// ask this, so a conversation that is dreamt can always be undone, and nobody can name another conversation's folder.

type Who = Pick<Conversation, "kind" | "tenantId" | "groupId">;

export function dreamScope(conv: Who): Scope {
  if (conv.kind === "owner") return OWNER_SCOPE;
  if (conv.kind === "group") return groupScope(conv.groupId!);
  const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
  if (!rec) throw new Error("not a tenant");
  const ctx = tenantContext(rec);
  return { notesDir: ctx.notesDir, backupsDir: ctx.backupDir, categories: preset().notes.tenant, index: true, maxNotes: settings.memoryMaxNotes };
}

// The conversation's own state file: the owner's in state/, a group's and a friend's in their folder (where they have always been).
export function dreamStateFile(conv: Who): string {
  if (conv.kind === "owner") return "state/dream.json";
  if (conv.kind === "group") return join(groupDir(conv.groupId!), "dream.json");
  const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
  if (!rec) throw new Error("not a tenant");
  return join(tenantContext(rec).dir, "dream.json");
}
