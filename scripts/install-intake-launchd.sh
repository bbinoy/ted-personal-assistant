#!/bin/zsh
# Install (or reinstall) the launchd job that keeps the friends' setup page (npm run intake) running.
# Run from the repo after INTAKE_BASE_URL is in .env: npm run install:launchd-intake
set -eu
cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo "Create .env first (copy .env.example)."; exit 1; }
set -a; source .env; set +a
[[ -n "${INTAKE_BASE_URL:-}" ]] || { echo "Set INTAKE_BASE_URL in .env first (docs/SETUP.md, The intake page)."; exit 1; }
LABEL="${LAUNCHD_LABEL:-com.$USER.ted-personal-assistant}-intake"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
dirname "$(command -v node)" > .node-path
mkdir -p logs && chmod 700 logs
: > logs/intake-launchd-stderr.log && chmod 600 logs/intake-launchd-stderr.log
sed -e "s#__LABEL__#$LABEL#g" -e "s#__DIR__#$PWD#g" launchd/intake.plist.template > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 1
done
for i in 1 2 3 4 5; do
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break
  [[ $i -eq 5 ]] && { echo "launchctl bootstrap failed; try: launchctl bootstrap gui/$(id -u) $PLIST"; exit 1; }
  sleep 2
done
echo "Installed and started $LABEL"
echo "Check:  npm run doctor"
