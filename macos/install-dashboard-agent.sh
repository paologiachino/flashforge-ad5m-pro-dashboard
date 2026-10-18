#!/bin/sh
# Install a LaunchAgent that starts the dashboard at login and restarts it if
# it crashes. Re-running it is safe. Remove with: launchctl bootout gui/$(id -u)/com.print3d.dashboard
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.print3d.dashboard
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/print3d"
mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"

# node:sqlite needs Node 22+. Pick it now and write its path into the agent.
NODE=""
for n in "$NODE_BIN" /opt/homebrew/opt/node@22/bin/node /usr/local/opt/node@22/bin/node \
         /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node)"; do
  [ -n "$n" ] && [ -x "$n" ] || continue
  major=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || continue
  if [ "$major" -ge 22 ]; then NODE="$n"; break; fi
done
[ -n "$NODE" ] || { echo "Node 22 or newer not found. Install it with: brew install node@22" >&2; exit 1; }
sed -e "s#__NODE__#$NODE#g" -e "s#__REPO__#$REPO#g" -e "s#__LOGDIR__#$LOGDIR#g" \
  "$REPO/macos/com.print3d.dashboard.plist" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Dashboard agent installed (Node: $NODE). Log: $LOGDIR/dashboard.log"
echo "Open http://127.0.0.1:3470 and go to Settings."
