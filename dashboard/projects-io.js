// Bulk export / import of dashboard projects, and the MakerWorld upload package.
//
// Export format ("print3d-projects" v1) is a ZIP with:
//   manifest.json                   projects, items, revisions, notes, tags, prints
//   projects/<slug>/...             every file in the project folder
//   projects/<slug>/_external/...   revision files that lived outside it
// Import also accepts a plain ZIP of model files with no manifest: each top
// level folder becomes a project and files sharing a name stem become an item.

import {
  readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, rmSync, mkdtempSync,
} from "node:fs";
import { join, basename, extname, relative, resolve, dirname, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createZip, readZip } from "./zip.js";
import { slugify } from "./db.js";

export const FORMAT = "print3d-projects";
export const VERSION = 1;

const MODEL_EXT = [".stl", ".3mf", ".obj", ".step", ".stp"];
const ITEM_EXT = [".stl", ".scad", ".gcode", ".gx", ".3mf", ".obj"];
const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp"];
const MAX_WALK_FILES = 5000;

const stamp = () => new Date().toISOString().slice(0, 10);
const inside = (root, p) => { const r = resolve(root); const a = resolve(p); return a === r || a.startsWith(r + sep); };

function walk(dir, { skip = () => false } = {}) {
  const out = [];
  const go = (d, depth) => {
    if (depth > 6 || out.length >= MAX_WALK_FILES) return;
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const p = join(d, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) go(p, depth + 1);
      else if (st.isFile() && !skip(p)) out.push({ path: p, mtime: st.mtime, size: st.size });
    }
  };
  if (existsSync(dir)) go(dir, 0);
  return out;
}

// --- export ------------------------------------------------------------------

export function exportProjects(db, { slugs = [], gcode = true } = {}) {
  const all = db.all("SELECT * FROM projects ORDER BY created_at");
  const chosen = slugs.length ? all.filter((p) => slugs.includes(p.slug)) : all;
  if (!chosen.length) throw new Error("no projects to export");

  const entries = [];
  const manifest = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    app: "Flashforge Adventurer 5M Pro Dashboard",
    projects: [],
  };
  const isGcode = (p) => [".gcode", ".gx"].includes(extname(p).toLowerCase());

  for (const p of chosen) {
    const base = `projects/${p.slug}/`;
    const byPath = new Map();   // absolute path -> archive name
    for (const f of walk(p.dir, { skip: (x) => !gcode && isGcode(x) })) {
      const name = base + relative(p.dir, f.path).split(sep).join("/");
      byPath.set(resolve(f.path), name);
      entries.push({ name, data: readFileSync(f.path), mtime: f.mtime });
    }
    // Revision files kept outside the project folder still belong to the export.
    const archived = (abs) => {
      if (!abs) return null;
      const r = resolve(abs);
      if (byPath.has(r)) return byPath.get(r);
      if (!existsSync(r) || !statSync(r).isFile() || (!gcode && isGcode(r))) return null;
      let name = `${base}_external/${basename(r)}`;
      for (let n = 2; [...byPath.values()].includes(name); n++) name = `${base}_external/${n}-${basename(r)}`;
      byPath.set(r, name);
      entries.push({ name, data: readFileSync(r), mtime: statSync(r).mtime });
      return name;
    };

    const items = db.all("SELECT * FROM items WHERE project_id = ? ORDER BY created_at", p.id).map((it) => ({
      slug: it.slug,
      name: it.name,
      status: it.status,
      createdAt: it.created_at,
      updatedAt: it.updated_at,
      tags: db.tagsFor("item", it.id),
      notes: db.all("SELECT body, author, created_at AS createdAt FROM notes WHERE item_id = ? ORDER BY created_at", it.id),
      revisions: db.all("SELECT * FROM revisions WHERE item_id = ? ORDER BY rev", it.id).map((r) => ({
        rev: r.rev,
        files: { stl: archived(r.stl_path), scad: archived(r.scad_path), gcode: archived(r.gcode_path) },
        layerCount: r.layer_count,
        estSeconds: r.est_seconds,
        filamentG: r.filament_g,
        filamentType: r.filament_type,
        note: r.note,
        decision: r.decision,
        decisionNote: r.decision_note,
        decidedAt: r.decided_at,
        createdAt: r.created_at,
      })),
      prints: db.all(
        `SELECT gcode_name AS gcodeName, started_at AS startedAt, ended_at AS endedAt, result, layers,
                est_seconds AS estSeconds, actual_seconds AS actualSeconds, filament_g AS filamentG,
                filament_type AS filamentType, outcome, outcome_note AS outcomeNote
         FROM prints WHERE item_id = ? ORDER BY started_at`, it.id),
    }));

    manifest.projects.push({
      slug: p.slug,
      name: p.name,
      notes: p.notes,
      status: p.status,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      tags: db.tagsFor("project", p.id),
      // In display order; the first is the cover.
      images: db.images(p.id)
        .map((img) => ({ file: archived(join(p.dir, "images", img.file)), caption: img.caption, createdAt: img.created_at }))
        .filter((img) => img.file),
      noteLog: db.all(
        "SELECT body, author, created_at AS createdAt FROM notes WHERE project_id = ? AND item_id IS NULL ORDER BY created_at", p.id),
      items,
    });
  }

  entries.unshift({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  const name = chosen.length === 1 ? `project-${chosen[0].slug}-${stamp()}.zip` : `projects-${stamp()}.zip`;
  return { zip: createZip(entries), filename: name, projects: chosen.length, files: entries.length - 1 };
}

// --- import ------------------------------------------------------------------

function uniqueDirSlug(db, root, base) {
  let s = db.uniqueProjectSlug(base);
  for (let n = 2; existsSync(join(root, s)); n++) s = db.uniqueProjectSlug(`${base}-${n}`);
  return s;
}

// Turn a manifest-less archive into the same shape as a manifest.
function manifestFromLooseFiles(files, fallbackName) {
  const groups = new Map();
  for (const f of files) {
    const parts = f.name.split("/");
    const top = parts.length > 1 ? parts[0] : fallbackName;
    const rel = parts.length > 1 ? parts.slice(1).join("/") : parts[0];
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push({ ...f, rel });
  }
  const projects = [];
  for (const [name, list] of groups) {
    const slug = slugify(name);
    // Pictures in a plain archive become the project's images, in name order.
    const images = [];
    for (const f of list.filter((x) => IMAGE_EXT.includes(extname(x.rel).toLowerCase()))
      .sort((a, b) => a.rel.localeCompare(b.rel))) {
      let file = basename(f.rel);
      for (let n = 2; images.some((i) => i.file === `projects/${slug}/images/${file}`); n++) {
        file = `${basename(f.rel, extname(f.rel))}-${n}${extname(f.rel)}`;
      }
      f.rel = `images/${file}`;
      images.push({ file: `projects/${slug}/${f.rel}`, caption: "" });
    }
    const stems = new Map();
    for (const f of list) {
      const ext = extname(f.rel).toLowerCase();
      if (!ITEM_EXT.includes(ext)) continue;
      const stem = basename(f.rel, extname(f.rel));
      if (!stems.has(stem)) stems.set(stem, {});
      const s = stems.get(stem);
      const key = ext === ".scad" ? "scad" : ext === ".gcode" || ext === ".gx" ? "gcode" : ext === ".stl" ? "stl" : null;
      if (key && !s[key]) s[key] = `projects/${slug}/${f.rel}`;
    }
    projects.push({
      slug,
      name,
      notes: "",
      tags: [],
      images,
      items: [...stems].filter(([, s]) => s.stl || s.scad || s.gcode).map(([stem, s]) => ({
        slug: slugify(stem),
        name: stem,
        status: "pending",
        revisions: [{ rev: 1, files: { stl: s.stl || null, scad: s.scad || null, gcode: s.gcode || null }, decision: "pending" }],
      })),
      _files: list.map((f) => ({ name: `projects/${slug}/${f.rel}`, data: f.data })),
    });
  }
  return { format: FORMAT, version: VERSION, loose: true, projects };
}

// mode: "skip" leaves projects whose slug already exists alone;
//       "copy" imports them again under a new slug. Nothing is ever overwritten.
export function importProjects(db, cfg, buf, { mode = "skip", dryRun = false, archiveName = "" } = {}) {
  if (!["skip", "copy"].includes(mode)) throw new Error('mode must be "skip" or "copy"');
  const files = readZip(buf);
  const byName = new Map(files.map((f) => [f.name, f.data]));
  let manifest;
  if (byName.has("manifest.json")) {
    try { manifest = JSON.parse(byName.get("manifest.json").toString("utf8")); }
    catch { throw new Error("manifest.json is not valid JSON"); }
    if (manifest.format !== FORMAT) throw new Error(`not a ${FORMAT} archive`);
    if (manifest.version > VERSION) throw new Error(`archive version ${manifest.version} is newer than this dashboard supports`);
  } else {
    const fallback = basename(archiveName || `Imported ${stamp()}`, ".zip") || `Imported ${stamp()}`;
    manifest = manifestFromLooseFiles(files, fallback);
  }

  const plan = [];
  const reserved = new Set();
  for (const mp of manifest.projects || []) {
    const origSlug = slugify(mp.slug || mp.name);
    const prefix = `projects/${mp.slug}/`;
    const projFiles = mp._files || files.filter((f) => f.name.startsWith(prefix))
      .map((f) => ({ name: f.name, data: f.data }));
    const exists = Boolean(db.project(origSlug)) || existsSync(join(cfg.projectsRoot, origSlug)) || reserved.has(origSlug);
    let action = "new", slug = origSlug;
    if (exists && mode === "skip") action = "skip";
    else if (exists) {
      slug = uniqueDirSlug(db, cfg.projectsRoot, origSlug);
      while (reserved.has(slug)) slug = uniqueDirSlug(db, cfg.projectsRoot, `${slug}-x`);
      action = "copy";
    }
    reserved.add(slug);
    plan.push({
      name: String(mp.name || origSlug),
      from: origSlug,
      slug,
      action,
      items: (mp.items || []).length,
      files: projFiles.length,
      bytes: projFiles.reduce((n, f) => n + f.data.length, 0),
      _mp: mp,
      _files: projFiles,
      _prefix: mp._files ? `projects/${origSlug}/` : prefix,
    });
  }
  const summary = () => ({
    format: manifest.loose ? "loose files" : `${FORMAT} v${manifest.version}`,
    exportedAt: manifest.exportedAt || null,
    projects: plan.map(({ _mp, _files, _prefix, ...p }) => p),
  });
  if (dryRun) return { dryRun: true, ...summary() };

  for (const p of plan) {
    if (p.action === "skip") continue;
    const dir = join(cfg.projectsRoot, p.slug);
    const written = [];
    const remap = (archivePath) => {
      if (!archivePath || !String(archivePath).startsWith(p._prefix)) return null;
      const dest = join(dir, ...String(archivePath).slice(p._prefix.length).split("/"));
      return inside(dir, dest) && existsSync(dest) ? dest : null;
    };
    try {
      mkdirSync(dir, { recursive: true });
      for (const f of p._files) {
        const dest = join(dir, ...f.name.slice(p._prefix.length).split("/"));
        if (!inside(dir, dest)) continue;
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, f.data);
        written.push(dest);
      }
      db.tx(() => {
        const mp = p._mp;
        const proj = db.createProject({ name: p.name, slug: p.slug, dir, notes: String(mp.notes || ""), tags: mp.tags || [] });
        db.run("UPDATE projects SET status = ?, created_at = COALESCE(?, created_at), updated_at = COALESCE(?, updated_at) WHERE id = ?",
          mp.status === "archived" ? "archived" : "active", mp.createdAt || null, mp.updatedAt || null, proj.id);
        // Only files that landed in <dir>/images/ can be project images.
        for (const im of mp.images || []) {
          const dest = remap(im.file);
          if (!dest || !inside(join(dir, "images"), dest) || dirname(dest) !== join(dir, "images")) continue;
          if (!IMAGE_EXT.includes(extname(dest).toLowerCase())) continue;
          db.addImage(proj.id, basename(dest), String(im.caption || "").slice(0, 500), im.createdAt || null);
        }
        for (const n of mp.noteLog || []) {
          db.run("INSERT INTO notes (project_id, body, author, created_at) VALUES (?, ?, ?, ?)",
            proj.id, String(n.body || ""), String(n.author || "user"), n.createdAt || new Date().toISOString());
        }
        for (const mi of mp.items || []) {
          const item = db.createItem({ projectId: proj.id, name: String(mi.name || mi.slug), slug: slugify(mi.slug || mi.name), tags: mi.tags || [] });
          for (const r of mi.revisions || []) {
            db.run(
              `INSERT INTO revisions (item_id, rev, stl_path, scad_path, gcode_path, layer_count, est_seconds,
                 filament_g, filament_type, note, decision, decision_note, decided_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              item.id, Number(r.rev) || 1,
              remap(r.files?.stl), remap(r.files?.scad), remap(r.files?.gcode),
              r.layerCount ?? null, r.estSeconds ?? null, r.filamentG ?? null, r.filamentType ?? null,
              String(r.note || ""), ["approved", "rejected"].includes(r.decision) ? r.decision : "pending",
              String(r.decisionNote || ""), r.decidedAt || null, r.createdAt || new Date().toISOString());
          }
          const status = ["draft", "pending", "approved", "rejected"].includes(mi.status) ? mi.status : "pending";
          db.run("UPDATE items SET status = ?, created_at = COALESCE(?, created_at), updated_at = COALESCE(?, updated_at) WHERE id = ?",
            status, mi.createdAt || null, mi.updatedAt || null, item.id);
          for (const n of mi.notes || []) {
            db.run("INSERT INTO notes (item_id, body, author, created_at) VALUES (?, ?, ?, ?)",
              item.id, String(n.body || ""), String(n.author || "user"), n.createdAt || new Date().toISOString());
          }
          for (const pr of mi.prints || []) {
            db.run(
              `INSERT INTO prints (item_id, gcode_name, started_at, ended_at, result, layers, est_seconds,
                 actual_seconds, filament_g, filament_type, outcome, outcome_note)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              item.id, String(pr.gcodeName || ""), pr.startedAt || new Date().toISOString(), pr.endedAt || null,
              pr.result === "running" ? "unknown" : String(pr.result || "unknown"), pr.layers ?? null,
              pr.estSeconds ?? null, pr.actualSeconds ?? null, pr.filamentG ?? null, pr.filamentType ?? null,
              pr.outcome ?? null, String(pr.outcomeNote || ""));
          }
        }
      });
      p.imported = true;
    } catch (e) {
      // Leave nothing half-imported behind.
      for (const f of written) rmSync(f, { force: true });
      if (existsSync(dir) && !readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
      p.action = "failed";
      p.error = String(e.message || e);
    }
  }
  return { dryRun: false, ...summary() };
}

// --- MakerWorld package ------------------------------------------------------
//
// MakerWorld has no public upload API and its terms forbid automated access,
// so the dashboard prepares everything an upload needs and the user uploads it
// on makerworld.com while signed in to their own Bambu Lab account.

function render(openscad, stl, png) {
  const dir = mkdtempSync(join(tmpdir(), "mwrender-"));
  const scad = join(dir, "view.scad");
  writeFileSync(scad, `import("${stl.replace(/\\/g, "/").replace(/"/g, '\\"')}");\n`);
  const r = spawnSync(openscad, [
    "--camera=0,0,0,55,0,25,0", "--autocenter", "--viewall", "--imgsize=1600,1200",
    "--colorscheme=Tomorrow", "-o", png, scad,
  ], { timeout: 120000 });
  rmSync(dir, { recursive: true, force: true });
  return r.status === 0 && existsSync(png);
}

const fmtTime = (s) => (s ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : "—");

export function makerworldPackage(db, cfg, slug, { openscad = "", printerModel = "Adventurer 5M Pro" } = {}) {
  const p = db.project(slug);
  if (!p) throw new Error("no such project");
  const items = db.itemsOf(p.id);
  const chosen = items.map((it) => {
    const rev = it.revisions.find((r) => r.decision === "approved" && r.stl_path) || it.revisions.find((r) => r.stl_path);
    return rev ? { it, rev } : null;
  }).filter(Boolean);
  if (!chosen.length) throw new Error("this project has no STL to publish");

  const entries = [];
  const work = mkdtempSync(join(tmpdir(), "makerworld-"));
  const rendered = [];
  const warnings = [];

  // The project's own pictures come first, in the order set in the dashboard:
  // the first is the cover. Real photos sell a model far better than renders.
  const photos = [];
  for (const img of db.images(p.id)) {
    const f = join(p.dir, "images", img.file);
    if (!inside(join(p.dir, "images"), f) || !existsSync(f)) { warnings.push(`image ${img.file} is missing`); continue; }
    const n = String(photos.length + 1).padStart(2, "0");
    entries.push({ name: `images/${n}-${img.file}`, data: readFileSync(f) });
    photos.push({ name: `images/${n}-${img.file}`, caption: img.caption });
  }

  for (const { it, rev } of chosen) {
    if (!existsSync(rev.stl_path)) { warnings.push(`${it.name}: STL file missing`); continue; }
    entries.push({ name: `models/${it.slug}.stl`, data: readFileSync(rev.stl_path) });
    if (rev.scad_path && existsSync(rev.scad_path)) {
      entries.push({ name: `source/${it.slug}.scad`, data: readFileSync(rev.scad_path) });
    }
    if (openscad) {
      const png = join(work, `${it.slug}.png`);
      if (render(openscad, rev.stl_path, png)) {
        entries.push({ name: `images/renders/${String(rendered.length + 1).padStart(2, "0")}-${it.slug}.png`, data: readFileSync(png) });
        rendered.push(it.name);
      } else warnings.push(`${it.name}: preview render failed`);
    }
    if (rev.decision !== "approved") warnings.push(`${it.name}: revision v${rev.rev} is not approved yet`);
  }
  rmSync(work, { recursive: true, force: true });
  if (!photos.length) warnings.push("no photos: add at least one picture of the printed part in the dashboard (Images)");

  const tags = [...new Set([...p.tags, "openscad", "flashforge"])];
  const rows = chosen.map(({ it, rev }) =>
    `| ${it.name} | ${rev.filament_type || "PLA"} | ${rev.filament_g ? `${Number(rev.filament_g).toFixed(0)} g` : "—"} | ${fmtTime(rev.est_seconds)} | ${rev.layer_count || "—"} |`);
  const listing = `# ${p.name}

> Draft listing for MakerWorld. Edit it, then copy each section into the upload form.

## Title
${p.name}

## Summary
${(p.notes || `${p.name}, designed in OpenSCAD.`).split(/(?<=[.!?])\s/)[0]}

## Description
${p.notes || "Describe what it is, what it is for and how it fits together."}

Parts:
${chosen.map(({ it }) => `- **${it.name}**`).join("\n")}

${chosen.some(({ rev }) => rev.scad_path) ? "Designed in OpenSCAD with the BOSL2 library. The parametric source is included in the attachments.\n" : ""}
## Print settings

Sliced for a Flashforge ${printerModel}, 0.4 mm nozzle, Flash Studio profiles. Times and weights are slicer estimates.

| Part | Filament | Weight | Time | Layers |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

## Tags
${tags.join(", ")}

## Images (in this order)
${photos.length
    ? photos.map((ph, i) => `${i + 1}. \`${ph.name}\`${i === 0 ? " — cover" : ""}${ph.caption ? ` — ${ph.caption}` : ""}`).join("\n")
    : "(no photos yet — add them in the dashboard)"}
${rendered.length ? `\nRenders (optional, after the photos): \`images/renders/\`` : ""}

## Category
(choose on MakerWorld)

## License
(choose on MakerWorld — e.g. Standard Digital File License, or a Creative Commons licence)
`;
  const checklist = `# Uploading "${p.name}" to MakerWorld

1. Open https://makerworld.com and sign in with your Bambu Lab account
   (your password and 2-step code stay on makerworld.com; this dashboard never sees them).
2. Click **Upload** and choose to upload model files.
3. Files: add everything in \`models/\` (and \`source/\` as attachments if the form allows it).
4. Images: add the files in \`images/\` in their numbered order (01 is the cover), then
   the renders in \`images/renders/\` if you want them.
5. Copy title, summary, description, tags from \`LISTING.md\`. Pick category and licence.
6. Print profile: MakerWorld print profiles are made with Bambu Studio for Bambu Lab
   printers. For a Flashforge-only model, publish the model files and keep the slicer
   settings in the description.
7. Only publish your own designs. If a part is a remix, credit and link the original and
   respect its licence.
8. Review and publish.

${warnings.length ? `## Warnings\n\n${warnings.map((w) => `- ${w}`).join("\n")}\n` : ""}`;
  entries.unshift(
    { name: "LISTING.md", data: Buffer.from(listing) },
    { name: "UPLOAD.md", data: Buffer.from(checklist) },
  );
  return {
    zip: createZip(entries),
    filename: `makerworld-${p.slug}-${stamp()}.zip`,
    parts: chosen.length,
    images: entries.filter((e) => e.name.startsWith("images/")).length,
    warnings,
  };
}
