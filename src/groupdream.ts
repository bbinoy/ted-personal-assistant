import { skipForCooldown } from "./cooldown.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { audit } from "./audit.ts";
import { budgetSpent } from "./budget.ts";
import { allows } from "./capabilities.ts";
import { dreamOver, describePlan, groupConversation, groupDreamPrompt, readNoteFiles, realRunner as dreamRunner, type Runner as DreamRunner } from "./dream.ts";
import { groupHistorySince, groupScope, listGroups } from "./groupstore.ts";
import { dreamSystem } from "./persona.ts";
import { isPaused, localDay } from "./pause.ts";
import { LIMITS } from "./sanitize.ts";

// The dream of each group's notes: the same tidy-up as the owner's (dream.ts), over that group's notes and
// that group's own words only, silently, once a day before the brief. Anything it changed is logged, and
// "undo the dream for <group>" in the owner's chat puts the notes back.

const MIN_NEW_LINES = 3; // a group that said next to nothing since the last time is left alone
const MAX_GROUPS_PER_NIGHT = 5;

interface GroupDreamState {
  day?: string;
  lastRunAt?: string;
}

export function createGroupDreamer(deps: { run?: DreamRunner } = {}) {
  let inFlight: Promise<void> | undefined;

  async function once(now: Date): Promise<void> {
    if (!allows({ kind: "group" }, "dream") || isPaused(now) || budgetSpent()) return;
    const today = localDay(now);
    let dreamt = 0;
    for (const g of listGroups()) {
      if (dreamt >= MAX_GROUPS_PER_NIGHT) break;
      const stateFile = join(g.dir, "dream.json");
      let state: GroupDreamState = {};
      try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { /* first time */ }
      if (state.day === today) continue;
      const messages = groupHistorySince(g.id, state.lastRunAt);
      const { memberText } = groupConversation(messages);
      if (messages.filter((x) => x.kind === "member").length < MIN_NEW_LINES) continue;
      writeFileSync(stateFile, JSON.stringify({ ...state, day: today }), { mode: 0o600 }); // before the run: no retry loops
      dreamt++;
      try {
        const scope = groupScope(g.id);
        const { plan, snapshot } = await dreamOver(scope, groupDreamPrompt(now, readNoteFiles(scope.notesDir), messages, g.name || "a group"), dreamSystem("group"), memberText, now, deps.run ?? dreamRunner);
        writeFileSync(stateFile, JSON.stringify({ day: today, lastRunAt: now.toISOString() }), { mode: 0o600 });
        for (const r of plan.rejected) console.log(`group dream: rejected ${r.file || "(no file)"}: ${r.why}`);
        audit("group_dream", snapshot ? "changed" : "no-change", "dream", { actions: plan.actions.length, rejected: plan.rejected.length });
        if (snapshot) console.log(`group dream (${g.name || "a group"}): ${describePlan(plan).join("; ")}`); // silent: logged, undoable from chat
      } catch (e) {
        console.error("group dream: failed:", (e as Error).message);
        audit("group_dream", "failed", "dream", { error: (e as Error).message.slice(0, LIMITS.preview) });
      }
    }
  }

  return { run: (now = new Date()) => (skipForCooldown("group dream") ? Promise.resolve() : (inFlight ??= once(now).finally(() => (inFlight = undefined)))) }; // usage limit: no attempt, the day stays open
}

