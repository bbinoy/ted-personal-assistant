import { emit } from "../core/events.ts";
import { forgetSpend } from "../core/budget.ts";
import { forgetNotices } from "../core/capnotice.ts";
import { removeConvDir } from "../core/convdb.ts";
import { dataRoot, isConvId, type ConvId } from "../core/convpaths.ts";
import { forgetConvInBackups } from "../core/convimport.ts";
import { settings } from "../core/settings.ts";
import { macKeychain } from "../secrets/keychain.ts";
import { Admin, layoutOf } from "../secrets/openbaoadmin.ts";
import { appBao, deleteTenantItems } from "../secrets/secrets.ts";
import { removeAttachments, stepper } from "../tenants/removal.ts";
import { forgetConvId } from "../modules/voice/voicenote.ts";
import { forgetGroupCache, listGroups } from "./groupstore.ts";
import { removeFriend } from "./tenantremoval.ts";

// FORGETTING a conversation: `npm run forget -- friend <id>` and `npm run forget -- group <folder name|name>`. A conversation is one folder now (core/convpaths.ts), so most of it is
// deleting that folder; what is not in it is a handful of keys in instance/ (the day's spend, the notice marks, a friend's connection marks), the audio files signal-cli saved for its voice
// notes, and a friend's items in the secret store. Every step reports what went and never throws for one failing, so the rest still happens; running it again removes what is left.
// A friend is removed with removeFriend (tenants/removal.ts: her registry entry first, then everything). A group is only FORGOTTEN: its folder and keys go, the assistant does not leave
// the group (that is Signal's: leave it on the phone); if the group writes again, a new empty folder is made and it is a new conversation.
//
// The messenger does not tell the app that the assistant was removed from a group: packages/signal surfaces no membership or leave event (only `groups()`, a listing that can fail
// or be empty for a moment, which must never delete anybody's history). So nothing forgets a group by itself; the owner does, with this command, when she has left or been removed.

export interface GroupRemoval {
  conv: ConvId;
  name?: string;
  removed: string[];
  failed: string[];
}
export interface GroupForgetDeps {
  attachmentsDir?: string;
  drop?: (groupId: string) => void; // the part that lives in the running agent (its warm process, its queue): wired by the caller that has them
}

/** A group by its folder name (group-<16 hex>) or by its name (exactly, any case). An error sentence when none or several. */
export function resolveGroup(ref: string): { conv: ConvId; name?: string; id?: string } | { error: string } {
  const r = ref.trim();
  if (r === "") return { error: "Give the group's folder name or its name." };
  const known = listGroups();
  if (isConvId(r) && r.startsWith("group-")) {
    const g = known.find((x) => x.convId === r);
    return { conv: r, ...(g ? { name: g.name, id: g.id } : {}) }; // (also when the folder is gone already: running it again reports that nothing is left)
  }
  const named = known.filter((g) => g.name.trim().toLowerCase() === r.toLowerCase());
  if (named.length === 1) return { conv: named[0]!.convId, name: named[0]!.name, id: named[0]!.id };
  if (named.length > 1) return { error: `Several groups are called "${r}": use the folder name instead (${named.map((g) => g.convId).join(", ")}).` };
  return { error: `No group called "${r}". Known: ${known.map((g) => `${g.name || "(no name)"} (${g.convId})`).join(", ") || "none"}.` };
}

export function forgetGroup(ref: string, d: GroupForgetDeps = {}): GroupRemoval | { error: string } {
  const found = resolveGroup(ref);
  if ("error" in found) return found;
  const { conv } = found;
  const out: GroupRemoval = { conv, ...(found.name ? { name: found.name } : {}), removed: [], failed: [] };
  const step = stepper(out);
  let attachments: string[] = [];
  step("its voice-note index", () => {
    attachments = forgetConvId(conv); // (before its folder goes: the index is in it)
    return attachments.length;
  });
  step("its folder (notes, history, session, pending approvals, voices)", () => {
    return removeConvDir(conv); // (its assistant.db connection is closed first)
  });
  step("its saved voice-note audio", () => removeAttachments(attachments, d.attachmentsDir));
  step("its files in the assistant.db import's backups", () => forgetConvInBackups(dataRoot(), conv) > 0);
  step("its day's spend", () => forgetSpend(conv));
  step("its notice marks", () => forgetNotices((k) => k === `group:${conv}` || k === `group-budget:${conv}` || k === `warn:${conv}`));
  step("its name in memory", () => (found.id ? (forgetGroupCache(found.id), d.drop?.(found.id), false) : false));
  emit({ type: "removal", tool: "group_forget", decision: "removed", source: "chat", meta: { conv, steps: out.removed.length }, text: `Forgot the group ${out.name ? `“${out.name}” ` : ""}(${conv}) and its data (${out.removed.length} step(s))` });
  console.log(`groups: ${conv} forgotten`);
  return out;
}

/** The two ways to reach a friend's items in the secret store: the app's own token, then the admin's (a short-lived root token from the Keychain shares). */
export function friendSecretSteps(): ((id: string) => Promise<number>)[] {
  const cfg = settings.openbao;
  const admin = new Admin({ layout: layoutOf(cfg.dir), addr: cfg.addr, mount: cfg.mount, role: cfg.role, tenant: "owner", prefix: cfg.keychainPrefix, keychain: macKeychain });
  return [(t) => deleteTenantItems(appBao(), t), (t) => admin.forgetTenant(t)];
}

/** A friend and ALL her data (tenants/removal.ts has the steps; this wires the voice-note index in). Undefined: not a friend's id. */
export const forgetFriend = removeFriend;
