#!/bin/sh
# Dev instance on port 3471; every path is overridden so config.json (the real
# library) is never used. Data lives in <repo>/.dev/. Set SKETCH_UPLOAD_TOKEN
# in the calling environment to enable POST /api/items/upload.
cd "$(dirname "$0")/.." || exit 1
D="$PWD/.dev"
mkdir -p "$D"
export DASH_PORT=3471 DASH_LISTEN80=0
export DASH_DB="$D/dash.db" PRINT_LIBRARY="$D/library" PROJECTS_ROOT="$D/projects" GCODE_DIRS="$D/gcode"
export PRINTER_IP= PRINTER_SERIAL= PRINTER_CHECKCODE= PRINTER_CONFIG="$D/none.json"
exec node dashboard/server.js
