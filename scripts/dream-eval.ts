// The nightly dream (src/conversation/dream.ts) on notes that disagree, with the REAL model: the production prompt (dreamPrompt, dreamSystem), runner (runnerFor) and rules (planOps).
// Notes are fictional and live in a temporary folder; nothing is applied, the plan is checked.
//   npm run eval:dream                 all cases, EVAL_REPS (default 3) runs each
//   EVAL_ONLY=a,b npm run eval:dream   some cases
// Not part of npm test (it calls the model).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dreamPrompt, runnerFor } from "../src/conversation/dream.ts";
import { planOps, type NoteFile, type Plan } from "../src/memory/dreamplan.ts";
import { dreamSystem } from "../src/run/persona.ts";
import { dayIn } from "../src/core/timezone.ts";
import { preset } from "../src/core/preset.ts";

const now = new Date();
const day = (n: number): string => dayIn(new Date(now.getTime() + n * 86_400_000));
const note = (description: string, text: string, modifiedDaysAgo: number): string =>
  `---\nname: x\ndescription: ${JSON.stringify(description)}\nmetadata:\n  node_type: memory\n  type: user\n  modified: ${new Date(now.getTime() - modifiedDaysAgo * 86_400_000).toISOString()}\n---\n\n${text}\n`;

interface Case {
  id: string;
  title: string;
  notes: Record<string, string>;
  ok: (plan: Plan, after: Record<string, string>) => string | undefined; // undefined: pass; else why not. `after`: the notes as the plan would leave them
}

const cases: Case[] = [
  {
    id: "a",
    title: "an older and a newer note disagree on a start date: resolved to the newer date, nothing else lost",
    notes: {
      "context-valmora-plan.md": note(`Plan: Valmora from ${day(30)} to ${day(44)}`, `Working from Valmora from ${day(30)} to ${day(44)}. Flights not booked. Wants the window desk at the shared office.`, 20),
      "context-whereabouts.md": note(`Whereabouts: home; next Valmora from ${day(27)} to ${day(41)}`, `Updated after the flights were booked: Valmora from ${day(27)} to ${day(41)}.`, 2),
    },
    ok: (plan, after) => {
      const all = Object.values(after).join("\n");
      if (plan.actions.length === 0) return "no action";
      if (all.includes(day(30)) || all.includes(day(44))) return "the older dates are still in a note";
      if (!all.includes(day(27))) return "the newer start is gone";
      if (!/window desk/i.test(all)) return "the window desk detail was lost";
      return undefined;
    },
  },
  {
    id: "b",
    title: "a stay and an event inside it do not conflict: both untouched",
    notes: {
      "context-valmora-stay.md": note(`Stay in Valmora from ${day(12)} to ${day(26)}`, `Working from Valmora from ${day(12)} to ${day(26)}.`, 5),
      "context-team-dinner.md": note(`Team dinner in Valmora on ${day(25)}`, `Dinner with the Example Labs team in Valmora on ${day(25)}, 19:30.`, 3),
    },
    ok: (plan) => (plan.actions.length === 0 ? undefined : `changed: ${plan.actions.map((a) => `${a.kind} ${a.file}`).join(", ")}`),
  },
  {
    id: "c",
    title: "two notes disagree and nothing shows which is newer: left alone",
    notes: {
      "context-conference-a.md": note(`Conference in Valmora starts ${day(10)}`, `The Example Labs conference in Valmora starts ${day(10)}.`, 4),
      "context-conference-b.md": note(`Conference in Valmora starts ${day(12)}`, `The Example Labs conference in Valmora starts ${day(12)}.`, 4),
    },
    ok: (plan) => (plan.actions.length === 0 ? undefined : `changed: ${plan.actions.map((a) => `${a.kind} ${a.file}`).join(", ")}`),
  },
];

const only = process.env.EVAL_ONLY?.split(",").map((s) => s.trim());
const reps = Number(process.env.EVAL_REPS ?? "3");
const run = runnerFor();
const categories = preset().notes.dream;
const evidence = "thanks, that is all for today";
let failed = 0;
for (const c of cases.filter((x) => !only || only.includes(x.id))) {
  let pass = 0;
  for (let i = 0; i < reps; i++) {
    const dir = mkdtempSync(join(tmpdir(), "dream-eval-"));
    mkdirSync(join(dir, "notes"));
    const notesDir = join(dir, "notes");
    const files: NoteFile[] = Object.entries(c.notes).map(([file, raw]) => ({ file, raw }));
    for (const f of files) writeFileSync(join(notesDir, f.file), f.raw);
    const scope = { notesDir, backupsDir: join(dir, "backups"), categories, maxNotes: 100 };
    const out = await run(dreamPrompt(now, "the owner", files, [`[10:00] the owner: ${evidence}`]), dreamSystem({ subject: "the owner", kind: "owner", categories }));
    const plan = planOps(out, { ownerText: evidence, notes: files, today: dayIn(now), now, scope });
    const after: Record<string, string> = Object.fromEntries(files.map((f) => [f.file, f.raw]));
    for (const a of plan.actions) {
      if (a.kind === "delete") delete after[a.file];
      else after[a.file] = a.content;
    }
    const why = c.ok(plan, after);
    if (!why) pass++;
    console.log(`${c.id}#${i} ${why ? `FAIL ${why}` : "ok"} (${plan.actions.map((a) => `${a.kind} ${a.file}`).join(", ") || "no actions"}${plan.rejected.length ? `; rejected ${plan.rejected.map((r) => `${r.file}: ${r.why}`).join(", ")}` : ""})`);
  }
  if (pass < reps) failed++;
  console.log(`${c.id}: ${pass}/${reps}  ${c.title}`);
}
process.exit(failed ? 1 : 0);
