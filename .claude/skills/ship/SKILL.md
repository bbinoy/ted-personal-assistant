---
name: ship
description: Merge a reviewed branch into main, run the gates, push, restart the running assistant through launchd and verify. Use when the owner asks to ship, merge or deploy a branch.
disable-model-invocation: true
---

# Ship a reviewed branch

Labels come from the environment (set them in `.claude/settings.local.json` under `env`, or export them):
`LAUNCHD_LABEL` (the variable `scripts/install-launchd.sh` reads; default `com.$USER.ted-personal-assistant`) and the intake job, which is `${LAUNCHD_LABEL:-com.$USER.ted-personal-assistant}-intake` (see `scripts/install-intake-launchd.sh`).

1. **Check the branch.** `git status` is clean on main; `git log main..<branch>` shows the commits to ship.
2. **Back up before a migration.** If the branch adds a numbered migration step in `src/core/convdb.ts` or `src/core/instancedb.ts`, first back up every database: create a dated folder `state/backup-<date>/` and run `sqlite3 <db> ".backup '<dest>'"` for `instance/instance.db` and every `conversations/*/assistant.db`. Only copy; do not read the data.
3. **Merge.** `git merge --no-ff <branch> -m "Merge: <what changed, one line>"`, with the trailers the session gives. Resolve conflicts by understanding both sides.
4. **Gates, all five, on the merged tree:** `npx tsc --noEmit --noUnusedLocals`, `npm run lint`, `npm test`, `npm run check:secrets`, `npm run check:isolation`. A few tests are timing-flaky (packages/speech, search/instancedb timing): re-run the failing file alone to tell a flake from a failure. Never ignore a real failure; if one fails, stop and ask the owner before undoing the merge.
5. **Push.** `git push origin main` (never force).
6. **Restart, only through launchd.** `launchctl kickstart -k gui/$(id -u)/$LAUNCHD_LABEL`, and the same for the intake label. Never start `run.sh` or `src/main.ts` by hand: launchd's KeepAlive would also restart it and two instances would run.
7. **Verify.** `npm run doctor`, and check that exactly one `src/main.ts` process runs (`pgrep -fl src/main.ts`).
8. **Clean up.** `git worktree remove <path>` and `git branch -d <branch>`.
