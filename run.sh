#!/bin/zsh
# Entry point for launchd: start the agent. Everything else (the Signal daemon, the
# heartbeat, the daily brief) is supervised from inside the agent.
cd "$(dirname "$0")" || exit 1
# launchd starts with a minimal PATH. install-launchd.sh records where `node` lives.
export PATH="$(cat .node-path 2>/dev/null):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# the workspace-source condition makes @ted-assistant/signal resolve to its TypeScript source, so no build step is needed
exec node --conditions=workspace-source --env-file=.env src/main.ts
