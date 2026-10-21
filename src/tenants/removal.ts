import { rmSync } from "node:fs";
import { join } from "node:path";
import { audit } from "../core/audit.ts";
import { forgetNotices } from "../core/capnotice.ts";
import { isInside } from "../core/contain.ts";
import { removeConvDir } from "../core/convdb.ts";
import { friendConvId } from "../core/convpaths.ts";
import { forgetTenantConnections } from "../intake/intakelinks.ts";
import { TENANT_ID } from "../secrets/secrets.ts";
import { tenantKey } from "../core/ownerkey.ts";
import { settings } from "../core/settings.ts";
import { deleteTenant, OWNER_ID, tenantById } from "./tenants.ts";

// Removing a friend takes EVERYTHING of hers. Her data is ONE folder now (conversations/friend-<id>/: notes, history, session, cost, pending approvals, cloned voices and the index of
// her voice notes, search index), so most of it goes with deleteTenant (tenants.ts) alongside her registry entry. What is not in her folder is the audio files signal-cli saved for her
// voice notes (found through her index, which is read BEFORE the folder goes), her marks in instance/intake-status.json and intake-problems.json, her keys in instance/cap-notices.json,
// and her items in the secret store (tenants/<id>/*). Idempotent: run again after a failure (or for a friend whose registry entry is already gone) and it removes what is left.
// It reports what it removed; it never throws for one step failing, so the rest still happens.
// Not reached, and said so in docs/SAFETY.md: attachments signal-cli saved for her other messages (the app's log keeps no attachment id for them), the SDK's own
// transcripts under ~/.claude, backups of the Mac.

export interface Removal {
  registry: boolean; // she was a tenant (and her folder went with her entry)
  removed: string[]; // what else went, in words
  failed: string[]; // steps that threw (run it again)
  manual?: string; // the exact command for the owner when a step needs the admin
}

export interface RemovalDeps {
  drop?: (id: string) => void;
  attachmentsDir?: string;
  // Wired from above (conversation/tenantremoval.ts: tenants may not import the voice module): the voice-note index of a conversation key (returns the attachment ids it held).
  forgetNotes?: (key: string) => string[];
  // The secret store: each is tried in order until one works (the app's token, then the admin's root). Returns how many items went; throws when refused.
  secrets?: readonly ((id: string) => Promise<number>)[];
}

export const safeAttachment = (id: string): boolean => /^[\w.-]{1,100}$/.test(id) && !id.startsWith(".");
export const adminCommand = (id: string): string => `npm run openbao -- forget-tenant ${id}`;

/** A reporting wrapper: runs one step, notes what it removed, notes (never throws) when it failed. */
export function stepper(out: { removed: string[]; failed: string[] }): (what: string, f: () => boolean | number | void) => void {
  return (what, f) => {
    try {
      const r = f();
      if (r === true || (typeof r === "number" && r > 0)) out.removed.push(typeof r === "number" ? `${what} (${r})` : what);
    } catch {
      out.failed.push(what);
    }
  };
}

/** The audio files signal-cli saved for voice notes of a conversation that is going: by attachment id, each checked to be a plain file name inside the attachments folder. */
export function removeAttachments(ids: readonly string[], attachmentsDir: string = settings.signalAttachmentsDir): number {
  let n = 0;
  for (const a of ids) {
    if (!safeAttachment(a) || !isInside(join(attachmentsDir, a), attachmentsDir)) continue;
    rmSync(join(attachmentsDir, a), { force: true });
    n++;
  }
  return n;
}

export async function removeTenant(id: string, d: RemovalDeps = {}): Promise<Removal | undefined> {
  if (id === OWNER_ID || !TENANT_ID.test(id)) return undefined;
  const out: Removal = { registry: false, removed: [], failed: [] };
  const step = stepper(out);
  const key = tenantKey(id);
  const conv = friendConvId(id);
  let attachments: string[] = [];
  step("her voice-note index", () => {
    attachments = d.forgetNotes?.(key) ?? []; // (before her folder goes: the index is in it)
    return attachments.length;
  });
  if (tenantById(id)) out.registry = deleteTenant(id, d.drop ? { drop: d.drop } : {}); // (her registry entry first: from that moment she is nobody; then her whole folder)
  step("her conversation folder", () => {
    const had = removeConvDir(conv); // (also when the registry entry was gone already; its assistant.db connection is closed first)
    return had && !out.registry;
  });
  step("her saved voice-note audio", () => removeAttachments(attachments, d.attachmentsDir));
  step("her connection marks", () => forgetTenantConnections(id));
  step("her notice marks", () => forgetNotices((k) => k === `friend:${id}` || k === `warn:${conv}`));
  for (const secrets of d.secrets ?? []) {
    try {
      const n = await secrets(id);
      out.removed.push(`her secret-store items (${n})`);
      delete out.manual;
      break;
    } catch {
      out.manual = `her secret-store items are still in OpenBao (the app's token may not delete another person's folder). As the admin, run: ${adminCommand(id)}`;
    }
  }
  audit("tenant_status", "removed", "chat", { tenant: id, steps: out.removed.length, ...(out.manual ? { manual: true } : {}) });
  return out;
}
