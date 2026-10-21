import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { removeScope, scopeRoot } from "@ted-assistant/speech/tts";
import { audit } from "../core/audit.ts";
import { isInside } from "../core/contain.ts";
import { pendingFileOf } from "../approvals/pending.ts";
import { dataPath } from "../core/state.ts";
import { forgetTenantConnections } from "../intake/intakelinks.ts";
import { forgetConversation } from "../modules/voice/voicenote.ts";
import { TENANT_ID } from "../secrets/secrets.ts";
import { tenantKey } from "../core/ownerkey.ts";
import { settings } from "../core/settings.ts";
import { deleteTenant, OWNER_ID, tenantById } from "./tenants.ts";

// Removing a friend takes EVERYTHING of hers, not only her folder (tenants.ts deleteTenant): her cloned voices and their reference clips (state/voice/groups/
// <hash of tenant:<id>>), her voice-note index (state/voice/sources.json) and the audio files signal-cli saved for those notes, her marks in
// state/intake-status.json and intake-problems.json, her pending approvals (state/pending-<hash>.json), and her items in the secret store (tenants/<id>/*). Idempotent: run again after a failure (or for a friend
// whose registry entry is already gone) and it removes what is left. It reports what it removed; it never throws for one step failing, so the rest still happens.
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
  voiceRoot?: string;
  attachmentsDir?: string;
  // The secret store: each is tried in order until one works (the app's token, then the admin's root). Returns how many items went; throws when refused.
  secrets?: readonly ((id: string) => Promise<number>)[];
}

const safeAttachment = (id: string): boolean => /^[\w.-]{1,100}$/.test(id) && !id.startsWith(".");
export const adminCommand = (id: string): string => `npm run openbao -- forget-tenant ${id}`;

export async function removeTenant(id: string, d: RemovalDeps = {}): Promise<Removal | undefined> {
  if (id === OWNER_ID || !TENANT_ID.test(id)) return undefined;
  const out: Removal = { registry: false, removed: [], failed: [] };
  const step = (what: string, f: () => boolean | number | void): void => {
    try {
      const r = f();
      if (r === true || (typeof r === "number" && r > 0)) out.removed.push(typeof r === "number" ? `${what} (${r})` : what);
    } catch {
      out.failed.push(what);
    }
  };
  const key = tenantKey(id);
  if (tenantById(id)) out.registry = deleteTenant(id, d.drop ? { drop: d.drop } : {});
  const voiceRoot = d.voiceRoot ?? (settings.tts.provider === "qwen" ? settings.tts.qwen.voiceRoot : undefined) ?? join(settings.stateDir, "voice");
  step("her cloned voices", () => {
    const had = existsSync(scopeRoot(voiceRoot, key));
    removeScope(voiceRoot, key); // (her scope is the hash of tenant:<id>, like a group's of its id)
    return had;
  });
  let attachments: string[] = [];
  step("her voice-note index", () => {
    attachments = forgetConversation(key);
    return attachments.length;
  });
  const dir = d.attachmentsDir ?? settings.signalAttachmentsDir;
  step("her saved voice-note audio", () => {
    let n = 0;
    for (const a of attachments) {
      if (!safeAttachment(a) || !isInside(join(dir, a), dir)) continue;
      rmSync(join(dir, a), { force: true });
      n++;
    }
    return n;
  });
  step("her pending approvals", () => {
    const file = dataPath(pendingFileOf(key)); // state/pending-<hash of her key>.json: outside her folder
    const had = existsSync(file);
    rmSync(file, { force: true });
    return had;
  });
  step("her connection marks", () => forgetTenantConnections(id));
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
