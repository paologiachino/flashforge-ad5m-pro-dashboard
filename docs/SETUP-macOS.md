# Complete setup on macOS

This guide describes **everything that was installed and configured** to design and print
with Claude on a Flashforge Adventurer 5M Pro, starting from an Apple Silicon Mac
(macOS 26, Homebrew already installed). Every step was run and checked.

In the commands, `~/Documents/3D/ai-3d-print` is the repository and
`~/Documents/3D/Models` is the models library. You can choose other paths.

## Contents

1. [Architecture](#1-architecture)
2. [Base software](#2-base-software)
3. [OpenSCAD and BOSL2](#3-openscad-and-bosl2)
4. [Repository and models library](#4-repository-and-models-library)
5. [Claude skills](#5-claude-skills)
6. [MCP servers](#6-mcp-servers)
7. [Printer](#7-printer)
8. [Dashboard](#8-dashboard)
9. [Camera](#9-camera)
10. [Day-to-day use](#10-day-to-day-use)
11. [Updating from the original project](#11-updating-from-the-original-project)
12. [Using it with other printers](#using-it-with-other-printers)
13. [Troubleshooting](#13-troubleshooting)
14. [Security](#14-security)

---

## 1. Architecture

```
Claude (Claude Code / desktop app)
 ├── print3d skill ............ drives design → review → slice → print
 ├── "openscad" MCP ........... OpenSCAD (render, STL) + Flash Studio CLI (G-code)
 │                               + printer LAN API (port 8898)
 ├── "orcaslicer" MCP ......... OrcaSlicer CLI: parameter sweeps, G-code analysis (optional)
 └── "blender" MCP ............ Blender, for organic shapes and renders (optional)

Dashboard (Node 22, ports 3470 and 80)
 ├── reads the printer (/detail) only while someone is watching
 ├── shows the camera (MJPEG, printer port 8080)
 └── keeps projects and history in SQLite inside the models library

~/.print3d/printer.json ....... IP, serial, check code and model: read by dashboard and MCP
```

Why OpenSCAD: the model is a text file that Claude writes directly. The MCP server renders
it to PNG images, so Claude *sees* the result and fixes mistakes before anything reaches
the printer.

## 2. Base software

```bash
brew install uv          # runs the Python MCP servers (blender, orcaslicer)
brew install node@22     # the dashboard needs Node 22+ for node:sqlite
brew install gh          # optional: to publish on GitHub
```

`node@22` is *keg-only*: it does not replace the system Node. It lives at
`/opt/homebrew/opt/node@22/bin/node`.

Apps to install by hand:

| App | Needed? | Notes |
| --- | --- | --- |
| **Flash Studio** | Yes, for slicing | [flashforge.com](https://www.flashforge.com/pages/flash-studio-desktop). Ships the official *Adventurer 5M Pro 0.25/0.4/0.6/0.8 Nozzle* profiles. |
| **OrcaSlicer** | Optional | For the `orcaslicer` MCP server. Tested with 2.4.2. |
| **Blender** | Optional | For the `blender` MCP server. Tested with 5.2. |

Check that command-line slicing works:

```bash
P="/Applications/Flash Studio.app/Contents/Resources/profiles/Flashforge"
"/Applications/Flash Studio.app/Contents/MacOS/Flash Studio" \
  --load-settings "$P/machine/Flashforge Adventurer 5M Pro 0.4 Nozzle.json;$P/process/0.20mm Standard @Flashforge AD5M Pro 0.4 Nozzle.json" \
  --load-filaments "$P/filament/Flashforge Generic PLA.json" \
  --curr-bed-type "High Temp Plate" --slice 0 --outputdir /tmp/slicetest model.stl
```

> `--curr-bed-type "High Temp Plate"` matters: without it the CLI uses "Cool Plate" with
> generic temperatures (for example 35 °C for PETG instead of 70 °C).

## 3. OpenSCAD and BOSL2

You need a **development snapshot**: the 2021.01 stable release is too old for BOSL2.

```bash
brew install --cask openscad@snapshot
openscad --version
git clone --depth 1 https://github.com/BelfrySCAD/BOSL2.git ~/Documents/OpenSCAD/libraries/BOSL2
```

Test:

```bash
echo 'include <BOSL2/std.scad>; cuboid([20,20,10], rounding=2);' > /tmp/t.scad
openscad -o /tmp/t.stl /tmp/t.scad     # should report "Genus: 0"
```

## 4. Repository and models library

```bash
mkdir -p ~/Documents/3D/Models/projects
git clone https://github.com/paologiachino/flashforge-ad5m-pro-dashboard.git ~/Documents/3D/ai-3d-print
cp ~/Documents/3D/ai-3d-print/dashboard/config.example.macos.json \
   ~/Documents/3D/ai-3d-print/dashboard/config.json
```

In `dashboard/config.json`, replace `/Users/YOUR_USER/Documents/3D/Models` with your
library. The file is ignored by git.

Models, STL files, G-code and the database **live in the library, not in the repository**.

## 5. Claude skills

Skills are instructions Claude loads when they are relevant.

```bash
mkdir -p ~/.claude/skills
cp -R ~/Documents/3D/ai-3d-print/skills/print3d ~/Documents/3D/ai-3d-print/skills/print3d-setup ~/.claude/skills/
```

| Skill | Triggered by | What it does |
| --- | --- | --- |
| `print3d` | "design…", "print me…", "make a holder for…" | Asks what you want, searches online or models with BOSL2, creates the project, has you approve the model in the dashboard, asks which filament is loaded, slices, and prints only with your consent. |
| `print3d-setup` | "set up 3D printing", a new machine | Installs and checks everything needed. |

Changes made for the 5M Pro:

- the model is read from Settings (`printer.json`) and selects the slicer profile;
- with the enclosure closed, ABS and ASA are allowed; for PLA, opening the door or lid is
  suggested;
- Claude replies in the user's language.

After editing the skills in the repository, copy them to `~/.claude/skills` again.

## 6. MCP servers

Servers are registered at user level in `~/.claude.json`, under the `mcpServers` key.
Back the file up first. If you have the `claude` CLI, you can use
`claude mcp add … --scope user` instead of editing it by hand.

```json
{
  "mcpServers": {
    "openscad": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/<user>/Documents/3D/ai-3d-print/skills/print3d/scripts/openscad-mcp.mjs"],
      "env": {
        "SCAD_PROJECT_DIR": "/Users/<user>/Documents/3D/Models",
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
      }
    },
    "blender": {
      "type": "stdio",
      "command": "/opt/homebrew/bin/uvx",
      "args": ["mcp-for-blender"],
      "env": { "DISABLE_TELEMETRY": "true" }
    },
    "orcaslicer": {
      "type": "stdio",
      "command": "/opt/homebrew/bin/uvx",
      "args": ["--python", "3.12", "--with", "mcp<2", "orca-mcp"],
      "env": { "ORCASLICER_PATH": "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer" }
    }
  }
}
```

### `openscad` (required)

On macOS it finds Homebrew's `openscad` and `/Applications/Flash Studio.app` on its own.
For other locations set `OPENSCAD_BIN`, `FLASHSTUDIO_BIN` and `FLASHSTUDIO_PROFILES`.
Do **not** put the IP, serial or check code in environment variables: they belong in
`printer.json`.

| Tool | Purpose |
| --- | --- |
| `scad_render` · `scad_check` · `scad_export` | PNG previews, validation, STL export with manifold and 220×220×220 mm build-volume checks. |
| `scad_slice` | G-code via Flash Studio. Uses the model set in Settings. |
| `printer_discover` · `printer_status` · `printer_files` | Network scan, status, files stored on the printer. |
| `printer_print` · `printer_job` | Upload and start, pause, resume and cancel: **only after the user confirms**. |
| `project_*` · `item_*` · `queue_*` · `print_history` | Projects, revisions, queue and history (need the dashboard running). |

### `orcaslicer` (optional)

[orca-mcp](https://github.com/jeff-roche/orca-mcp) wraps the OrcaSlicer CLI. It is useful
for trying several values of one setting (`parameter_sweep`) and for layer-by-layer G-code
analysis.

> **Note:** version 0.1.0 does not start with the `mcp` 2.x library
> (`No module named 'mcp.server.fastmcp'`). That is why the arguments include
> `--with "mcp<2"`, which pins it to 1.x.

### `blender` (optional)

[mcp-for-blender](https://github.com/ahujasid/mcp-for-blender) (formerly `blender-mcp`):

```bash
uvx mcp-for-blender install-addon
# enable the add-on without opening the UI:
/Applications/Blender.app/Contents/MacOS/Blender -b --python-expr \
  "import bpy; bpy.ops.preferences.addon_enable(module='blender_mcp'); bpy.ops.wm.save_userpref()"
```

Each time you want to use it, open Blender, press **N** in the 3D viewport, open the
**MCP** tab and click **Start MCP Server**. Telemetry is turned off with
`DISABLE_TELEMETRY=true`. The `execute_blender_code` tool runs Python inside Blender.

### Checking

New MCP servers are loaded **only in sessions started after** they are registered. In a
new session, ask Claude: *"list the tools of the openscad, orcaslicer and blender
servers"*.

## 7. Printer

1. On the printer: **Settings → Network → LAN mode on**. Note the **IP address, serial
   number and check code**.
2. In your router, give the printer a **fixed IP** (DHCP reservation).
3. Start the dashboard (section 8) and open **Settings** in the Mac's browser:
   - **Find** looks for printers on port 8898 on the local network;
   - **Test connection** tries the values without saving them;
   - **Save** writes `~/.print3d/printer.json` with mode `600`.

Printer ports: **8898** (HTTP API), **8899** (legacy TCP protocol), **8080** (MJPEG camera).

## 8. Dashboard

### Manual start

```bash
~/Documents/3D/ai-3d-print/dashboard/run-dashboard.sh
```

The script finds a Node ≥ 22 on its own.

### Start at login

```bash
~/Documents/3D/ai-3d-print/macos/install-dashboard-agent.sh
```

This creates `~/Library/LaunchAgents/com.print3d.dashboard.plist`. The agent restarts the
dashboard if it crashes and logs to `~/Library/Logs/print3d/dashboard.log`.

```bash
launchctl kickstart -k gui/$(id -u)/com.print3d.dashboard   # restart
launchctl bootout gui/$(id -u)/com.print3d.dashboard        # disable
```

> **Why the agent starts Node directly rather than a `sh` script:** macOS privacy
> protection stops `/bin/sh`, launched at login, from reading `~/Documents`
> (`Operation not permitted`). The installer finds Node 22 and writes its path into the
> agent file.

### Backup, moving and MakerWorld

- **Projects → Export all** downloads a ZIP of every project (database records and files).
  Keep it as a backup, or use **Import…** on another computer: a preview shows what will be
  added, and existing projects are skipped or copied under a new name, never overwritten.
- **Project → Images / Tags:** add photos of the printed part (from the phone too), choose
  the cover, and edit tags and description. They are part of exports and of the MakerWorld
  package.
- **Project → MakerWorld package** builds models, source, photos, renders and a draft listing for a
  manual upload on makerworld.com. The dashboard never signs in to MakerWorld; see the
  README for why.

### Access

- from the Mac: `http://127.0.0.1:3470`
- from a phone on the same network: `http://<mac-name>.local`. Get the name with
  `scutil --get LocalHostName` or in *System Settings → General → Sharing*. Type the
  `http://` too.

## 9. Camera

The 5M Pro streams 640×480 MJPEG from MJPG-Streamer at
`http://<printer-ip>:8080/?action=stream`.

The dashboard:

- keeps **a single connection** to the printer and shares it between all viewers, because
  MJPG-Streamer copes badly with several connections;
- connects only when someone presses **Show camera**, and disconnects when nobody is
  watching or the tab goes to the background;
- cuts frames on JPEG markers, so a viewer joining mid-stream always starts on a whole
  image;
- offers **Photo** (`/api/camera/snapshot`) and **Fullscreen** (on iPhone it opens the
  stream in its own tab).

The camera URL can be changed in Settings, for example for an external webcam on the plain
5M.

## 10. Day-to-day use

In a new Claude session:

> "Design a door hook, 4 mm thick, and print it in PETG"

1. Claude asks whether you want the design only or also the print, whether to search
   online, and whether you want to review the model.
2. It creates the project in `~/Documents/3D/Models/projects/<name>/` and writes the
   `.scad` file.
3. It checks the model with previews and posts it to the dashboard → **Projects** for your
   review.
4. You press **Approve**, or **Revise** with a note, from the phone too.
5. Claude asks which filament is loaded, slices with the 5M Pro profile and reports time
   and grams.
6. It prints **only** if you chose to print. With several parts it queues them and waits
   for *Bed clear – release* between one part and the next.

## 11. Updating from the original project

```bash
cd ~/Documents/3D/ai-3d-print
git remote add upstream https://github.com/ethanj2k/ai-3d-print.git   # once
git fetch upstream
git rebase upstream/main          # or: git merge upstream/main
launchctl kickstart -k gui/$(id -u)/com.print3d.dashboard
```

The `local/camera` branch holds only the camera feature, in its original form, so it is
easy to re-apply on future versions.

## Using it with other printers

| Printer / situation | Works? | What to configure |
| --- | --- | --- |
| Adventurer 5M Pro, stock firmware | ✅ Tested (fw 5.1.9) | Settings: IP, serial, check code, model *Adventurer 5M Pro*. |
| Adventurer 5M, stock firmware | ✅ Same API (not tested here) | Model *Adventurer 5M*. **Camera off**, unless the add-on camera is fitted (then set its URL). PLA and PETG only. |
| AD5X | ⚠️ Partial, not tested | Same API: status and history should work. Automatic slicing is not supported (different profiles, multi-colour). Camera only if fitted. |
| Klipper-modded firmware (Moonraker/Mainsail) | ❌ | Different API. |
| Several printers at once | ⚠️ One instance per printer | For each: different `DASH_PORT`, `PRINTER_CONFIG`, `PRINT_LIBRARY` and `"listen80": false`. The MCP server handles one printer at a time (`PRINTER_CONFIG`). |
| Nozzle other than 0.4 | ✅ | Ask Claude to use `nozzle: "0.6"` (0.25, 0.4, 0.6 and 0.8 are available). |
| Linux | ✅ With tweaks | `"listen80": false` (port 80 needs root). OpenSCAD and Flash Studio paths via environment variables. A systemd service instead of the LaunchAgent. |
| Windows | ✅ Original project | `run-dashboard.cmd` and the default Windows paths. |

Other useful per-installation settings:

- **Filament cost:** `filament` in `config.json` (spool weight, price, currency).
- **Changing Settings from a phone, or running the dashboard on another machine:**
  `"allowRemoteSettings": true`. It also lets other devices import projects and create
  projects and items, which is what the MCP server does when `DASH_URL` points to a
  dashboard on a server (the file paths it sends must exist on that server too). Not
  recommended on untrusted networks.
- **Firmware:** the printer API is unofficial and may change. If something stops working
  after an update, *Test connection* shows the error.

## 13. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| *no answer: printer off or asleep?* / `EHOSTDOWN` | Printer off, asleep, or its IP changed | Turn it on. Use **Find** and fix the IP in the router. |
| *refused: is LAN mode on?* | LAN mode is off | Turn it on at the printer. |
| Check code rejected | Mistyped, or changed on the printer | Read it again on the printer and save it again in Settings. |
| Agent does not start, `Operation not permitted` in the log | macOS privacy protection | Use `macos/install-dashboard-agent.sh`, which starts Node directly. |
| `This dashboard needs Node 22` | Node too old | `brew install node@22`. |
| `No module named 'mcp.server.fastmcp'` | orca-mcp with mcp 2.x | Add `--with "mcp<2"` to the `uvx` arguments. |
| Claude does not see the MCP tools | Session opened before registration | Start a new session. |
| Blender does not respond | Add-on server not started | Blender → N → MCP → *Start MCP Server*. |
| No camera image | Camera off in Settings, or a 5M without camera | Turn it on or set the right URL. |
| Large uploads fail | Wi-Fi API limit (about 12 MB) | Use a USB stick. |

## 14. Security

- `printer.json` lives in `~/.print3d/` with mode `600` and is ignored by git.
  **Never publish it.**
- The dashboard **never sends the check code** back to a browser. From other devices the
  serial is masked and Settings is read-only.
- The dashboard listens on the whole local network (0.0.0.0) and has no authentication:
  use it only on trusted networks.
- Commands that move the printer (`printer_print`, `printer_job`) are used only by Claude,
  and the skill requires the user's confirmation.
- `mcp-for-blender` can run arbitrary Python code in Blender.
