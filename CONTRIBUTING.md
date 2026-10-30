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
- Before merging: `npx tsc --noEmit --noUnusedLocals`, `npm run lint`, `npm test`, `npm run check:secrets`, `npm run check:isolation` and `npm run check:unused` all pass (`npm run gates` runs them in order; the pre-push hook runs it). `check:unused` runs knip (pinned in `tools/knip`, config `tools/knip/knip.jsonc`): an export, type, file or dependency nothing uses fails it, so drop the `export` of a symbol used only in its own file and delete dead code. A test counts as a user; a deliberate unused export goes into the config with the reason. After merging a change that the running assistant uses, restart it and run `npm run doctor`.
- Behaviour that changes on purpose gets its fixture regenerated on purpose (`SNAPSHOT_WRITE=1 npm test`) and the diff reviewed.

**Layout**

- `test/boundaries.test.ts` checks the value imports of every file under `src/` against a folder table (each folder may import only the folders below it); a new folder needs a row there, and `test/docs-layout.test.ts` wants a line for every file in `docs/ARCHITECTURE.md`.
- Adding a tool is a folder `src/modules/<name>/` with `module.ts` (the light declaration) and the code it wraps, one line in `src/modules/index.ts` and one binding in `src/modules/runtime.ts` (`docs/ADAPTING.md`). A tool with no code of its own stays a single file `src/modules/<name>.ts`.

**Claude Code project setup**

`.claude/settings.json` (shared) denies reading or editing the private folders and allows the gates and read-only git. Project skills live in `.claude/skills/` (`ship`: merge, gates, push and restart through launchd; `principles-audit`) and project subagents in `.claude/agents/` (`ted-implementer`, `ted-reviewer`). Personal values such as launchd labels (`LAUNCHD_LABEL`) and local overrides go in `.claude/settings.local.json`, which is not committed.
