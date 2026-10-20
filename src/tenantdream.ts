import { join } from "node:path";
import { audit } from "./audit.ts";
import { allows } from "./capabilities.ts";
import { dreamOver, describePlan, dreamPrompt, conversationLines, readNoteFiles, runnerFor, type Runner } from "./dream.ts";
import type { Scope } from "./dreamplan.ts";
import { tenantDreamSystem } from "./persona.ts";
import { isPaused, localDay } from "./pause.ts";
import { messagesSince } from "./messages.ts";
import { LIMITS } from "./sanitize.ts";
import { settings } from "./settings.ts";
import { readJson, writeJson } from "./state.ts";
import { listTenants, type TenantContext } from "./tenants.ts";
import type { TenantAccess } from "./tenantrun.ts";

// The dream of each tenant's notes: the same tidy-up as the owner's (dream.ts) and a group's (groupdream.ts), over HER notes and HER words only,
// silently, once a day, on the instance key and billed to her (her cost file, her cooldown). Only for a tenant who is active, has the `dream`
// capability, is out of a cooldown and within her day's budget, and only when she wrote something since the last time. Its snapshots are in her
// folder (backup/). Every tenant is tried on her own: one that fails (or has no key to run on) never keeps another from being dreamt.

const scopeOf = (ctx: TenantContext): Scope => ({ notesDir: ctx.notesDir, backupsDir: ctx.backupDir, categories: ["people", "context", "scheduling", "style"], index: true, maxNotes: settings.memoryMaxNotes });

interface DreamState {
  day?: string; // local day of the last attempt
  lastRunAt?: string; // when the last real run started: what it covered ends here
}

export function createTenantDreamer(deps: { access: (id: string) => TenantAccess | undefined; run?: (tenant: TenantAccess) => Runner; ids?: () => string[] }) {
  let inFlight: Promise<void> | undefined;

  async function one(access: TenantAccess, now: Date): Promise<void> {
    const ctx = access.ctx;
    const stateFile = join(ctx.dir, "dream.json");
    const today = localDay(now);
    const state = readJson<DreamState>(stateFile, {});
    if (state.day === today) return;
    const messages = messagesSince(state.lastRunAt, ctx.logFile);
    if (!messages.some((m) => m.kind === "owner")) return; // she said nothing new: left alone, without even marking the day
    writeJson(stateFile, { ...state, day: today }); // before the run: no retry loops
    try {
      const { ownerText } = conversationLines(messages, ctx.name);
      const run = deps.run?.(access) ?? runnerFor(access);
      const { plan, snapshot } = await dreamOver(scopeOf(ctx), dreamPrompt(now, readNoteFiles(ctx.notesDir), messages, ctx.name), tenantDreamSystem(ctx.name), ownerText, now, run);
      writeJson(stateFile, { day: today, lastRunAt: now.toISOString() });
      for (const r of plan.rejected) console.log(`tenant dream: rejected ${r.file || "(no file)"}: ${r.why}`);
      audit("tenant_dream", snapshot ? "changed" : "no-change", "dream", { tenant: ctx.id, actions: plan.actions.length, rejected: plan.rejected.length });
      if (snapshot) console.log(`tenant dream (${ctx.id}): ${describePlan(plan).length} change(s)`); // silent: her notes' words stay out of the log
    } catch (e) {
      console.error(`tenant dream (${ctx.id}): failed:`, (e as Error).message);
      audit("tenant_dream", "failed", "dream", { tenant: ctx.id, error: (e as Error).message.slice(0, LIMITS.preview) });
    }
  }

  async function once(now: Date): Promise<void> {
    if (!settings.tenants || isPaused(now)) return;
    for (const id of deps.ids?.() ?? listTenants().map((r) => r.id)) {
      try {
        if (!allows({ kind: "tenant", tenantId: id }, "dream")) continue; // her record: active, with the capability
        const access = deps.access(id); // suspended, cooling down, over her budget or no key: nothing runs (and the admin hears of a missing key once)
        if (access) await one(access, now);
      } catch (e) {
        console.error(`tenant dream (${id}): failed:`, (e as Error).message);
      }
    }
  }

  // One run at a time; a second caller waits for the first.
  return { run: (now = new Date()) => (inFlight ??= once(now).finally(() => (inFlight = undefined))) };
}
