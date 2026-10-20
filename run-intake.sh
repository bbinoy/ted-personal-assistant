#!/bin/zsh
# Entry point for launchd: the setup page for friends (npm run intake), kept running next to the agent.
cd "$(dirname "$0")" || exit 1
export PATH="$(cat .node-path 2>/dev/null):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec node --conditions=workspace-source --env-file=.env scripts/intake.ts
