# Prompt for Claude: full setup

Copy everything below the line and paste it into a **new Claude Code session** (desktop
app Code tab, or terminal) on a Mac. Claude will install and verify the whole toolchain
described in [SETUP-macOS.md](SETUP-macOS.md), asking for the printer details only when
they are needed. Claude answers in the language you write to it in.

---

You are my assistant for setting up a 3D design-and-print environment on this Mac. Reply
in the language I write in. Work one step at a time, verify each step before moving on,
and tell me clearly what failed instead of carrying on past it.

## Goal

I want to ask you "design X and print it" and get: OpenSCAD model → previews → review in
the dashboard → slicing with the official Flashforge profiles → print on my
**Flashforge Adventurer 5M Pro** (or Adventurer 5M: ask me which), after my consent.

## References

- Repository: `https://github.com/paologiachino/flashforge-ad5m-pro-dashboard`
  (Flashforge Adventurer 5M Pro Dashboard). Read `README.md`, `docs/SETUP-macOS.md` and
  `skills/print3d-setup/SKILL.md` before starting: they are the source of truth.
- Repository folder: `~/Documents/3D/ai-3d-print`. Models library:
  `~/Documents/3D/Models`. Ask me whether I want other paths before creating folders.

## Rules

1. **Check what is already there first** (`brew`, `node`, `uv`, `openscad`, apps in
   `/Applications`, `~/.claude.json`, `~/.claude/skills`) and skip whatever already works.
2. **Never put** the IP, serial number or check code in the repository, in commits or in
   MCP server environment variables. They go only in `~/.print3d/printer.json` with mode
   600, preferably through the dashboard's Settings page.
3. **Back up** `~/.claude.json` before editing it.
4. **Do not start prints**, upload files to the printer, or send pause/cancel commands
   during setup. Only reads are allowed on the printer (`printer_status`, `printer_files`).
5. I install the GUI apps (Flash Studio, OrcaSlicer, Blender) myself: tell me what to
   download and from where, then verify.
6. Read the code of third-party MCP servers before registering them, and tell me if
   anything looks suspicious.

## Steps

1. **Base software:** `brew install uv node@22` and
   `brew install --cask openscad@snapshot`. Verify with `openscad --version` and
   `/opt/homebrew/opt/node@22/bin/node --version`.
2. **BOSL2:** clone `https://github.com/BelfrySCAD/BOSL2` into
   `~/Documents/OpenSCAD/libraries/BOSL2`. Test a `cuboid` with `rounding` and export it
   to STL.
3. **Flash Studio:** check that
   `/Applications/Flash Studio.app/Contents/Resources/profiles/Flashforge/machine/Flashforge Adventurer 5M Pro 0.4 Nozzle.json`
   exists, and run a test slice from the command line with
   `--curr-bed-type "High Temp Plate"`.
4. **Repository:** clone it, then copy `dashboard/config.example.macos.json` to
   `dashboard/config.json` with the paths of my library.
5. **Skills:** copy `skills/print3d` and `skills/print3d-setup` into `~/.claude/skills/`.
6. **MCP servers** in `~/.claude.json` → `mcpServers`, at user level:
   - `openscad`: `node <repo>/skills/print3d/scripts/openscad-mcp.mjs` with
     `SCAD_PROJECT_DIR=<library>` and a `PATH` that includes `/opt/homebrew/bin`;
   - optional, ask me: `orcaslicer` = `uvx --python 3.12 --with "mcp<2" orca-mcp` with
     `ORCASLICER_PATH`;
   - optional, ask me: `blender` = `uvx mcp-for-blender` with `DISABLE_TELEMETRY=true`,
     plus `uvx mcp-for-blender install-addon` and enabling the add-on.

   Verify each server by starting it and calling `initialize` and `tools/list` over stdio.
   For `openscad`, also try `scad_render`, `scad_export` and `scad_slice` on a cube, then
   delete the test files.
7. **Dashboard:** run `macos/install-dashboard-agent.sh`, check that
   `http://127.0.0.1:3470/api/settings` answers and that the agent is `running`.
8. **Printer:** ask me to turn on LAN mode and read the **IP, serial number and check
   code** from its screen. Save them with `POST /api/settings`, or tell me to enter them
   on the Settings page in the browser, together with the model. Then run
   `POST /api/settings/test` and a read-only `printer_status`. If the printer does not
   answer, use `/api/settings/discover`.
9. **Camera** (5M Pro only): check that `/api/camera/snapshot` returns a JPEG.
10. **Final report:** a table with each component, its status (✅/❌) and how you checked
    it. Add the dashboard address for my phone (`http://<LocalHostName>.local`) and remind
    me to open a **new session** to load the MCP tools.

## After setup

To design and print, follow the `print3d` skill. Always ask whether I want the design only
or also the print and which filament is loaded, and wait for my approval in the dashboard
before printing.
