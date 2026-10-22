import type { Conversation } from "../../conversation/conversationmodel.ts";
import { OWNER_SCOPE, type Scope } from "../../memory/dreamplan.ts";
import { groupDir, groupScope } from "../../conversation/groupstore.ts";
import { preset } from "../../core/preset.ts";
import { settings } from "../../core/settings.ts";
import { convIdOf, type ConvId } from "../../core/convpaths.ts";
import { convDb, peekConvDb } from "../../core/convdb.ts";
import { tenantById, tenantContext } from "../../tenants/tenants.ts";

// WHERE a conversation's dream works (dream.ts): its notes folder, the snapshots beside it, the note categories it has (the preset's notes.dream for the owner,
// notes.group, notes.tenant) and the state of its last run (in its assistant.db), all inside the conversation's own folder. The dream and "undo the dream" (memory-tools.ts) both
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

// The conversation whose assistant.db holds its dream state (the `dream` row): checked first, so a name that is no conversation cannot make one.
export function dreamStateConv(conv: Who): ConvId {
  if (conv.kind === "group") groupDir(conv.groupId!); // (the folder is made first)
  if (conv.kind === "tenant" && !(conv.tenantId && tenantById(conv.tenantId))) throw new Error("not a tenant");
  return convIdOf(conv);
}

export interface DreamState {
  day?: string; // local day of the last attempt
  lastRunAt?: string; // when the last real run started: what it covered ends here
}
export function readDream(conv: ConvId): DreamState {
  const r = peekConvDb(conv)?.get<{ day: string | null; last_run_at: string | null }>("SELECT day, last_run_at FROM dream WHERE id = 1");
  return { ...(r?.day != null ? { day: r.day } : {}), ...(r?.last_run_at != null ? { lastRunAt: r.last_run_at } : {}) };
}
export const writeDream = (conv: ConvId, s: DreamState): void =>
  void convDb(conv).run("INSERT INTO dream (id, day, last_run_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET day = excluded.day, last_run_at = excluded.last_run_at", s.day ?? null, s.lastRunAt ?? null);
