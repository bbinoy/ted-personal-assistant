# Contributing

## Git hygiene

**Commit messages** (checked by a `commit-msg` hook; a `pre-commit` hook runs `npm run check:secrets`; a `pre-push` hook runs every gate, `npm run gates`; enable them once per clone with `npm run setup:hooks`):

```
<type>(<optional scope>): <summary in the imperative, lower case, no full stop>

<optional body: why, not what; wrapped at about 72 characters>

<optional trailers, e.g. Co-Authored-By: ...>
```

- **Types:** `feat` (new behaviour), `fix` (a bug), `refactor` (no behaviour change), `perf`, `docs`, `test`, `chore`, `ci`, `build`, `revert`. A breaking change gets a `!` (`refactor!: ...`).
- **Subject:** at most **72 characters**, so GitHub does not cut it. Lower case after the prefix, imperative ("add", "fix", "remove"), no full stop.
- **Body:** leave a blank line after the subject; wrap prose lines (72 is nice, 100 is the hard limit). Trailers and web addresses may be longer.
- Merge commits (`Merge ...`), reverts and fixup/squash commits are not checked.

**Commits**

- One logical change per commit; the tests pass at every commit that is merged.
- Never commit secrets, `.env`, private data (`conversations/`, `instance/`, `state/`, `logs/`, and the older `memory/`, `tenants/`) or local plans and reports (`plans/`). `npm run check:secrets` must pass.
- Do not rewrite shared history: no force-push to `main`, no rebase of `main`.

**Branches**

- Work on a branch and merge it with `git merge --no-ff`, so the branch stays visible as one unit in the history.
- Before merging: `npx tsc --noEmit --noUnusedLocals`, `npm run lint`, `npm test`, `npm run check:secrets`, `npm run check:isolation` and `npm run check:unused` all pass (`npm run gates` runs all six at once, prints the output of a failed check only plus one line per check with its seconds, and takes a per-machine lock in the OS temp dir so that only one gates run goes at a time, whatever the worktree: a second run prints "waiting for another gates run" and waits; a lock whose process is gone is taken over; `scripts/gates.ts`, `scripts/gates-lock.ts`; the pre-push hook runs it). While iterating, `npm run gates:quick -- test/a.test.ts test/b.test.ts` runs typecheck, lint, the files you name and a fixed set of cross-cutting tests (prompt and run-option snapshots, folder boundaries, policy and approval tables; the list is `alwaysRun` in `scripts/gates.ts`) under the same lock; with no files it runs just those. It is not the pre-push gate: run the full `npm run gates` before pushing. A full run that passes on a clean working tree records its git tree hash (`scripts/gates-passed.ts`, a file next to the lock); the pre-push hook prints "gates already passed on this tree" and skips the run when HEAD's tree is recorded, and runs the gates otherwise (uncommitted changes always run). `check:unused` runs knip (pinned in `tools/knip`, config `tools/knip/knip.jsonc`): an export, type, file or dependency nothing uses fails it, so drop the `export` of a symbol used only in its own file and delete dead code. A test counts as a user; a deliberate unused export goes into the config with the reason. After merging a change that the running assistant uses, restart it and run `npm run doctor`.
- README.md is a summary of Ted's main capabilities, not a changelog: update it only when a change adds a new main capability or makes an existing README claim wrong; improvements to existing features don't go there (mechanics go in docs/).
- Behaviour that changes on purpose gets its fixture regenerated on purpose (`SNAPSHOT_WRITE=1 npm test`) and the diff reviewed.

**Evals (on demand, not gates)**

- The gates are deterministic and free and run on every push. The evals call real models, so they cost money and vary from run to run. Run them by hand every few days, or after a bigger change to prompts, skills, the judge, the tools or a model, and compare with the last run.
- `npm run eval:judge` (`scripts/judge-eval.ts`) checks the judge on one step at a time: is this single action safe and wanted (auto, ask or fix)? It takes about 2 minutes and costs about $0.50 for 3 runs per case. `EVAL_ONLY=c3,m1` runs a few cases, and `EVAL_VARIANT=<name>` keeps a run apart for comparison. Results and transcripts go to `.claude/hillclimb/` (ignored: the judge's reasons quote the owner). A full run also writes `last-run.json` there, which the `ship` skill reads to suggest a rerun when the changes since call for it.
- `npm run eval:e2e` (`scripts/e2e-eval.ts`) runs whole jobs of the owner's assistant on fictional cases (`scripts/e2e/cases*.ts`): the real model, judge, approval chain, skills, tasks and notes in a temporary data folder, and fakes for the calendar, mail, Notion, the web and the browser's shop (their tool names are the real connectors'). It measures `done` (every state check on the fake world), needless questions (the scripted owner answers through the real answer path), unsafe (a "must not" hit, or anything that reached for a real account) and the reply (a small model grades a rubric). It costs about $0.15 per run, so about $2 for one run of every case. `EVAL_ONLY=e1,e5`, `EVAL_REPS` (default 3), `EVAL_CONCURRENCY` (default 2) and `EVAL_VARIANT` work as in the judge eval; `EVAL_FAKE=perfect` runs scripted perfect runs with no model, to test the fakes and the grading. A run is hermetic (`scripts/e2e/guard.ts`): strict MCP config, no user settings, claude.ai connectors off, the start-up message checked, un-faked tool calls refused and the real Mailbird client blocked; a run that reaches for one is unsafe. It needs `openssl` for the fake web. A full run writes `.claude/hillclimb/e2e/last-run.json`, which the `ship` skill reads like the judge's. A new case goes in `scripts/e2e/cases*.ts` with state checks, a `never` list, a rubric and a scripted `perfect` run (`test/e2e-fakes.test.ts` runs every case's perfect run).
- `npm run eval` (`scripts/approval-eval-check.ts`) checks that the approval questions the model writes describe the call truthfully.
- What belongs where: a judge case judges one step and must make sense without knowing the rest of the task. Whether the whole task got done (the invite was sent too, nothing was asked needlessly) is a question for an end-to-end case, which runs the real agent against fake tools. A call the code floor never lets the judge see is not a judge case: the floor already decides it.
- Cases are fiction: no real names, addresses or places, only `example.com` and `example.org` addresses (the secret scan allows only those), and the owner's name filled in at run time.

**Layout**

- `test/boundaries.test.ts` checks the value imports of every file under `src/` against a folder table (each folder may import only the folders below it); a new folder needs a row there, and `test/docs-layout.test.ts` wants a line for every file in `docs/ARCHITECTURE.md`.
- Adding a tool is a folder `src/modules/<name>/` with `module.ts` (the light declaration) and the code it wraps, one line in `src/modules/index.ts` and one binding in `src/modules/runtime.ts` (`docs/ADAPTING.md`). A tool with no code of its own stays a single file `src/modules/<name>.ts`.

**Claude Code project setup**

`.claude/settings.json` (shared) denies reading or editing the private folders and allows the gates and read-only git. Project skills live in `.claude/skills/` (`ship`: merge, gates, push and restart through launchd; `principles-audit`) and project subagents in `.claude/agents/` (`ted-implementer`, `ted-reviewer`). Personal values such as launchd labels (`LAUNCHD_LABEL`) and local overrides go in `.claude/settings.local.json`, which is not committed.
