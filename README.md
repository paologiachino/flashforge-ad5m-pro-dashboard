# Flashforge Adventurer 5M Pro Dashboard

A local web dashboard and toolchain to **design objects by talking to Claude**, review them
in 3D, slice them with the official Flashforge profiles and print them on a
**Flashforge Adventurer 5M Pro**. The plain Adventurer 5M uses the same API.

This project is a fork of [ethanj2k/ai-3d-print](https://github.com/ethanj2k/ai-3d-print)
(MIT license), adapted and tested on **macOS** with a 5M Pro. The original README is in
[docs/UPSTREAM-README.md](docs/UPSTREAM-README.md).

> "Design me a phone stand and print it in PLA"
>
> — Design only, or design and print?
> — Search online for an existing design first, or model it from scratch?
> — Review the design before printing?

---

## What's inside

| Component | Purpose |
| --- | --- |
| `dashboard/` | Local web page for printer status, **live camera**, 3D model review, print queue, history and **Settings**. |
| `skills/print3d/scripts/openscad-mcp.mjs` | Dependency-free MCP server (Node 18+): OpenSCAD rendering, STL export, slicing with Flash Studio, printer commands, projects and queue. |
| `skills/print3d` | Claude skill: the "request → model → review → slice → print" flow. |
| `skills/print3d-setup` | Claude skill: installs and configures everything on a new machine. |
| `macos/` | Starts the dashboard at login (LaunchAgent). |
| `docs/SETUP-macOS.md` | **Step-by-step guide** to everything that was set up. |
| `docs/CLAUDE-PROMPT.md` | **Ready-made prompt** for Claude to repeat the whole setup on another Mac. |

## What's new compared to the original

- **Settings page in the dashboard.** Configure the IP address, serial number, check code,
  model and camera from the browser, with *Find* (scans the local network for the printer)
  and *Test connection*. Values are saved to `~/.print3d/printer.json` with mode `600`,
  **outside the repository**. The check code is never sent back to the browser, and
  Settings can only be changed from the computer running the dashboard.
- **Live camera (5M Pro).** *Show camera* displays the printer's MJPEG stream, with *Photo*
  and *Fullscreen*. The dashboard keeps **a single connection** to the printer, shares it
  with every viewer, and closes it when nobody is watching or the tab is in the background.
- **Multiple models.** The model is detected from the printer (5M, 5M Pro, AD5X) or set in
  Settings. The MCP server uses the saved model to pick the right slicer profile.
- **Starts without configuration.** On first run the dashboard no longer exits for missing
  printer details: it asks you to open Settings.
- **macOS out of the box.** Default paths for OpenSCAD (Homebrew) and Flash Studio,
  `run-dashboard.sh` and a LaunchAgent installer.
- **Updated skills** for the 5M Pro: ABS/ASA allowed with the enclosure closed, automatic
  profile selection.
- **Bulk export / import of projects.** One ZIP with every project, item, revision, note,
  tag and print record plus all project files. Import shows a preview first and never
  overwrites anything. A plain ZIP of STL/SCAD files is accepted too.
- **MakerWorld package.** One click builds everything a MakerWorld upload needs (models,
  OpenSCAD source, rendered previews, your photos, a draft listing and an upload
  checklist). You upload it on makerworld.com, signed in to your own account; see
  [Publishing to MakerWorld](#publishing-to-makerworld).

## Quick start (macOS)

```bash
brew install uv node@22 gh
brew install --cask openscad@snapshot
git clone https://github.com/paologiachino/flashforge-ad5m-pro-dashboard.git ~/Documents/3D/ai-3d-print
git clone --depth 1 https://github.com/BelfrySCAD/BOSL2.git ~/Documents/OpenSCAD/libraries/BOSL2
cp ~/Documents/3D/ai-3d-print/dashboard/config.example.macos.json ~/Documents/3D/ai-3d-print/dashboard/config.json
# edit config.json: replace YOUR_USER and choose your models folder
~/Documents/3D/ai-3d-print/macos/install-dashboard-agent.sh
open http://127.0.0.1:3470    # → Settings: IP, serial, check code → Test → Save
```

Then install **Flash Studio** from [flashforge.com](https://www.flashforge.com/pages/flash-studio-desktop),
copy the skills and register the MCP servers. Every step is explained in
[docs/SETUP-macOS.md](docs/SETUP-macOS.md). Alternatively, open Claude Code and paste the
contents of [docs/CLAUDE-PROMPT.md](docs/CLAUDE-PROMPT.md).

## On the printer

*Settings → Network → turn on **LAN mode***. The screen shows the **IP address, serial
number and check code**: enter them on the dashboard's **Settings** page. Give the printer
a fixed IP address in your router.

## The dashboard

| Tab | Contents |
| --- | --- |
| **Print** | Status, temperatures, layer-by-layer progress, toolpath preview, camera. |
| **Projects** | Projects and parts, with the STL to rotate in 3D and *Approve* / *Revise* buttons. *Export all* / *Import…*, and per project *Export* and *MakerWorld package*. |
| **Queue** | Print queue: nothing starts until you press *Bed clear – release*. |
| **History** | Past prints, duration, filament used and cost. |
| **Settings** | Printer connection, model and camera. |

The dashboard is **view only**: it never starts, pauses or cancels a print. Claude does
that through the MCP server, after you confirm.

Open it at `http://127.0.0.1:3470`, or from other devices on the same network at
`http://<mac-name>.local` (port 80) or `http://<mac-ip>:3470`.

### Configuration (`dashboard/config.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `library` | `../library` | Your models folder (outside the repo). |
| `projectsRoot` | `<library>/projects` | One subfolder per project. |
| `gcodeDirs` | `[library]` | Where to look for G-code for the preview. |
| `port` | `3470` | Main port. |
| `listen80` | `true` | Also listen on port 80. Needs root on Linux: set it to `false` there. |
| `allowRemoteSettings` | `false` | Allow changing Settings from other devices on the network. |
| `pollMs` | `2000` | How often to read the printer while auto refresh is on. |
| `filament` | 1100 g, $20 | Spool weight and price, used to estimate print cost. |

### Printer details (`~/.print3d/printer.json`)

Normally written by the Settings page. Format (see `printer.example.json`):

```json
{ "ip": "192.168.1.50", "serial": "SN…", "checkCode": "…", "model": "Adventurer 5M Pro", "camera": true }
```

The environment variables `PRINTER_IP`, `PRINTER_SERIAL`, `PRINTER_CHECKCODE` and
`PRINTER_CONFIG` take precedence over the file. Settings tells you when they are set.

## Dashboard API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/status` · `/api/events` | Status, also as a Server-Sent Events stream. |
| GET | `/api/camera/stream` | Shared MJPEG stream. |
| GET | `/api/camera/snapshot` | Single JPEG image. |
| GET | `/api/settings` | Settings, **without** the check code. |
| POST | `/api/settings` | Save. Localhost only, unless `allowRemoteSettings` is set. |
| POST | `/api/settings/test` | Test the connection with the form values. |
| POST | `/api/settings/discover` | Look for printers on port 8898 on the local network. |
| GET | `/api/export` | ZIP of all projects. `?projects=a,b` for some, `&gcode=0` to leave G-code out. |
| POST | `/api/import` | Body: the ZIP. `?mode=skip` (default) or `copy`, `&dryRun=1` to preview. Localhost only, unless `allowRemoteSettings`. |
| GET | `/api/projects/<slug>/makerworld` | MakerWorld upload package (ZIP). |

## Export and import

**Export all** (or **Export** on one project) downloads a ZIP:

```
manifest.json                  projects, items, revisions, notes, tags and print history
projects/<slug>/…              every file in the project folder
projects/<slug>/_external/…    revision files that lived outside it
```

**Import…** reads the ZIP and shows a preview first. Projects that already exist (same
name) are either skipped or imported again under a new name (`<slug>-2`): **nothing is
ever overwritten**. A ZIP without `manifest.json` also works: each top-level folder becomes
a project, and files sharing a name (`hook.stl`, `hook.scad`) become one item. Paths that
try to leave the projects folder (`../`, absolute paths) are ignored.

Use it to back up the library, move it to another computer, or bring in a folder of
downloaded models.

## Publishing to MakerWorld

MakerWorld has **no public upload API**, and its user agreement is reported to prohibit
robots and other automated access. So the dashboard does not log in to MakerWorld and never handles your
Bambu Lab password, token or 2-step code. Instead, **MakerWorld package** on a project
builds:

| File | Contents |
| --- | --- |
| `LISTING.md` | Draft title, summary, description, part list, slicer settings, tags. |
| `UPLOAD.md` | Step-by-step upload checklist and any warnings (unapproved revision, no images). |
| `models/*.stl` | The approved (or latest) revision of every part. |
| `source/*.scad` | The OpenSCAD source, to attach if you want to share it. |
| `images/*.png` | 1600×1200 renders of each part; photos found in the project folder go in `images/photos/`. |

Then **Open MakerWorld**, sign in with your own Bambu Lab account and upload the files,
copying the text from `LISTING.md`. MakerWorld print profiles are made in Bambu Studio for
Bambu Lab printers, so for a Flashforge-only model the slicer settings go in the
description. Only publish your own designs, and credit the original for remixes.

If Bambu Lab grants official API access (their Trust Center collaboration programme), a
direct upload with proper OAuth sign-in could be added later.

## Using it with other printers

See the full table in [docs/SETUP-macOS.md](docs/SETUP-macOS.md#using-it-with-other-printers).
In short:

- **Adventurer 5M Pro, stock firmware:** tested. **Adventurer 5M:** same API, not tested
  here. Set the IP, serial, check code and model in Settings. On the plain 5M, turn the
  camera off unless the add-on camera is fitted.
- **AD5X:** same API, not tested. Status and history should work; automatic slicing is not
  supported because its profiles differ.
- **Klipper-modded firmware (Moonraker):** not supported, the API is different.
- **Several printers at once:** not supported in one instance. Run one dashboard per
  printer, each with its own port, `printer.json` (`PRINTER_CONFIG`) and library.

## Known limits

- The printer API is not officially documented and may change between firmware versions.
  Tested with firmware 5.1.9 on the 5M Pro.
- Wi-Fi uploads over about 12 MB can fail: use a USB stick for large jobs.
- The camera stream is 640×480 MJPEG and is only reachable on the local network.

## License

MIT. Copyright © 2026 Ethan Johnson (original project) and the contributors to this fork.
See [LICENSE](LICENSE).
