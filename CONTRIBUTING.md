# Contributing

## Git hygiene

**Commit messages** (checked by a `commit-msg` hook; enable it once per clone with `npm run setup:hooks`):

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
- Never commit secrets, `.env`, private data (`memory/`, `state/`, `logs/`) or local plans and reports (`plans/`). `npm run check:secrets` must pass.
- Do not rewrite shared history: no force-push to `main`, no rebase of `main`.

**Branches**

- Work on a branch and merge it with `git merge --no-ff`, so the branch stays visible as one unit in the history.
- Before merging: `npx tsc --noEmit --noUnusedLocals`, `npm test`, `npm run check:secrets` and `npm run check:isolation` all pass. After merging a change that the running assistant uses, restart it and run `npm run doctor`.
- Behaviour that changes on purpose gets its fixture regenerated on purpose (`SNAPSHOT_WRITE=1 npm test`) and the diff reviewed.
