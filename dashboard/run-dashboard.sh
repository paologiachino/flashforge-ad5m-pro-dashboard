#!/bin/sh
# Start the dashboard with the first Node >= 22 found (node:sqlite needs it).
cd "$(dirname "$0")" || exit 1
for n in "$NODE_BIN" /opt/homebrew/opt/node@22/bin/node /usr/local/opt/node@22/bin/node \
         /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node)"; do
  [ -n "$n" ] && [ -x "$n" ] || continue
  major=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || continue
  if [ "$major" -ge 22 ]; then exec "$n" server.js; fi
done
echo "Node 22 or newer not found. Install it with: brew install node@22" >&2
exit 1
