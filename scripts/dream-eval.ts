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
  {
    id: "d",
    title: "an incident rule without never/always wording: rewritten into the need behind it, as a merge naming itself",
    notes: {
      "triage-invoices-inbox.md": note("Invoices stay in the inbox", "Invoices from suppliers stay in the inbox; archive only after the person has acted on them. Set after the 4 May reminder from Example Supplies Ltd was archived on sight, the invoice went unpaid and a late fee followed. Since then no supplier invoice, reminder or statement is archived when it arrives.", 6),
    },
    ok: (plan, after) => {
      const m = plan.actions.find((x) => x.kind === "merge" && x.merged.includes(x.file));
      if (!m || plan.actions.length !== 1) return `expected one self-merge rewrite, got: ${plan.actions.map((x) => `${x.kind} ${x.file}`).join(", ") || "no actions"}`;
      if (!/fee|unpaid|pay|due/i.test(after[m.file] ?? "")) return "the need behind the rule is missing";
      return undefined;
    },
  },
  {
    id: "e",
    title: "a note repeating two narrower notes, plus cross-references: one merged note, every distinct rule kept",
    notes: {
      "style-short-replies.md": note("Keep replies short", "Replies to the team are short: three sentences at most.", 12),
      "style-greeting-first-names.md": note("Greet by first name", "Open every email to the team with the first name, then a comma.", 11),
      "style-team-email-overview.md": note("Team email style (overrides the notes on replies and greetings)", "Team email: replies are short, three sentences at most; open with the first name and a comma. This overrides the older notes on replies and greetings. Sign off with only the initial J.", 4),
    },
    ok: (_plan, after) => {
      const names = Object.keys(after);
      if (names.length !== 1) return `expected one note left, got ${names.length}`;
      const t = Object.values(after)[0] ?? "";
      if (!/three sentences/i.test(t)) return "the three-sentence limit was lost";
      if (!/first name/i.test(t)) return "the first-name greeting was lost";
      if (!/initial/i.test(t)) return "the sign-off was lost";
      return undefined;
    },
  },
  {
    id: "f",
    title: "a strict preference in the person's own quoted words, next to those: left untouched",
    notes: {
      "triage-newsletters.md": note("Newsletters stay out of the brief", 'In their own words: "never show me newsletters in the daily brief, not even once". A lasting preference.', 9),
      "triage-invoices-inbox.md": note("Invoices stay in the inbox", "Invoices from suppliers stay in the inbox; archive only after the person has acted on them. Set after one invoice was archived unpaid in the week of 3 May and a late fee followed.", 6),
    },
    ok: (plan) => {
      const bad = plan.actions.filter((x) => x.file === "triage-newsletters.md" || (x.kind !== "delete" && x.merged.includes("triage-newsletters.md")));
      return bad.length ? `touched the quoted preference: ${bad.map((x) => `${x.kind} ${x.file}`).join(", ")}` : undefined;
    },
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
