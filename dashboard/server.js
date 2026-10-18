#!/usr/bin/env node
// Flashforge Adventurer 5M / 5M Pro dashboard: projects, review queue, print
// history, live camera and printer settings.
//
// The printer is only ever read (/detail, plus its camera while someone is
// watching). Nothing here starts, pauses, cancels or uploads a job — the agent
// does that through the openscad MCP server once the user has released a queue
// entry here.

import http from "node:http";
import {
  readFileSync, existsSync, statSync, readdirSync, watch,
  mkdirSync, copyFileSync, writeFileSync, chmodSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join, dirname, basename, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces, homedir } from "node:os";
import { parseGcode, encodeToolpath, gcodeStats } from "./gcode-parse.js";

// node:sqlite landed in Node 22. Say so plainly rather than dying inside the
// module loader with ERR_UNKNOWN_BUILTIN_MODULE.
if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error(
    `This dashboard needs Node 22 or newer for node:sqlite. Running ${process.version} ` +
    `from ${process.execPath}.\nInstall a newer Node, or point run-dashboard.cmd at one.`,
  );
  process.exit(1);
}
const { openDb, slugify, now } = await import("./db.js");
const { exportProjects, importProjects, makerworldPackage } = await import("./projects-io.js");

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const PORT_PRINTER = 8898;

const fileCfg = existsSync(join(ROOT, "config.json"))
  ? JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8").replace(/^﻿/, ""))
  : {};

// The printer login lives in printer.json, never in the repo. Settings saves
// back to whichever file was loaded, or to ~/.print3d/printer.json when there
// is none yet - the same places the openscad MCP server reads.
const PRINTER_DEFAULT_FILE = process.env.PRINTER_CONFIG || join(homedir(), ".print3d", "printer.json");
let printerFile = null;

function loadPrinterFile() {
  const candidates = [
    process.env.PRINTER_CONFIG,
    join(ROOT, "printer.json"),
    join(ROOT, "..", "printer.json"),
    join(homedir(), ".print3d", "printer.json"),
    join(homedir(), "source", "ai-3d-print", "printer.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));
      if (j && (j.ip || j.serial || j.checkCode)) { printerFile = p; return j; }
    } catch { /* skip bad json */ }
  }
  return {};
}

const printer = loadPrinterFile();

// Values set in the environment win over printer.json, so Settings cannot
// change them. Reported to the UI rather than silently ignored.
const ENV_LOCKED = ["PRINTER_IP", "PRINTER_SERIAL", "PRINTER_CHECKCODE"].filter((k) => process.env[k]);

// Your models are yours and live outside this repo — point `library` in
// config.json at wherever you keep them. With no config at all we fall back to
// a `library/` folder beside the checkout, so a fresh clone runs as-is.
const LIBRARY = resolve(process.env.PRINT_LIBRARY || fileCfg.library || join(ROOT, "..", "library"));

const CFG = {
  ip: process.env.PRINTER_IP || printer.ip || "",
  serial: process.env.PRINTER_SERIAL || printer.serial || "",
  checkCode: process.env.PRINTER_CHECKCODE || printer.checkCode || "",
  // "" = detect from the printer. Shown in the header and used by the MCP
  // server to pick slicer profiles.
  model: printer.model || "",
  // The 5M Pro ships a camera; on the plain 5M it is an add-on.
  camera: printer.camera !== false,
  cameraUrl: printer.cameraUrl || fileCfg.cameraUrl || "",
  port: Number(process.env.DASH_PORT || fileCfg.port || 3470),
  // Port 80 lets a phone open http://<host> with no port, but needs root on
  // Linux. Set "listen80": false in config.json to skip it.
  listen80: fileCfg.listen80 !== false,
  // Settings can change where the dashboard points, so by default only a
  // browser on this computer may save them.
  allowRemoteSettings: fileCfg.allowRemoteSettings === true,
  library: LIBRARY,
  projectsRoot: resolve(process.env.PROJECTS_ROOT || fileCfg.projectsRoot || join(LIBRARY, "projects")),
  // The database describes the library, not the code, so it lives with the
  // library. That keeps this repo pure tooling and lets one checkout serve
  // whichever library config.json points at.
  db: resolve(process.env.DASH_DB || fileCfg.db || join(LIBRARY, "dashboard.db")),
  pollMs: Number(process.env.DASH_POLL_MS || fileCfg.pollMs || 2000),
  // What a spool costs, so grams can be shown as money. Defaults to a 1.1 kg
  // spool at $20 — override per filament in config.json.
  filament: {
    spoolGrams: Number(fileCfg.filament?.spoolGrams) || 1100,
    spoolCost: Number(fileCfg.filament?.spoolCost) || 20,
    currency: fileCfg.filament?.currency || "$",
  },
  gcodeDirs: (process.env.GCODE_DIRS
    ? process.env.GCODE_DIRS.split(";").map((s) => s.trim()).filter(Boolean)
    : fileCfg.gcodeDirs) || [LIBRARY],
};

const configured = () => Boolean(CFG.ip && CFG.serial && CFG.checkCode);

if (!configured()) {
  console.log("Printer not configured yet - open the dashboard and go to Settings.");
}

mkdirSync(CFG.projectsRoot, { recursive: true });
const db = openDb(CFG.db);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".map": "application/json",
  ".stl": "model/stl",
};

// --- printer polling -------------------------------------------------------
//
// Strictly viewer-driven. A client that has auto-refresh off connects with
// live=0 and the server issues no printer requests at all on its behalf.

const clients = new Set();
let lastStatus = { online: false, detail: null, error: "not polled yet", ts: 0, printerIp: CFG.ip };
let pollInFlight = false;
let pollTimer = null;
let printerHits = 0;

const liveViewers = () => [...clients].filter((c) => c.live).length;

// Product ids from /detail. Firmware has been seen sending both a decimal
// number (36) and a zero-padded hex string ("0024"), so accept either.
const PIDS = { 35: "Adventurer 5M", 36: "Adventurer 5M Pro", 38: "AD5X" };

function modelFromPid(pid) {
  const s = String(pid ?? "").trim();
  if (!s) return "";
  const n = /^0[0-9a-f]{3}$/i.test(s) ? parseInt(s, 16) : Number(s);
  return PIDS[n] || "";
}

const modelName = () => CFG.model || modelFromPid(lastStatus.detail?.pid) || "Adventurer 5M";

async function printerPost(path, body = {}, creds = CFG) {
  if (!creds.ip || !creds.serial || !creds.checkCode) {
    throw new Error("printer not configured - open Settings");
  }
  printerHits += 1;
  const r = await fetch(`http://${creds.ip}:${PORT_PRINTER}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serialNumber: creds.serial, checkCode: creds.checkCode, ...body }),
    signal: AbortSignal.timeout(8000),
  });
  const t = await r.text();
  let json;
  try { json = JSON.parse(t); }
  catch { throw new Error(`Non-JSON from ${path}`); }
  if (json.code !== undefined && json.code !== 0 && json.code !== 200) {
    throw new Error(json.message || `code ${json.code}`);
  }
  return json;
}

async function poll(force = false) {
  if (pollInFlight) return lastStatus;
  if (!force && !liveViewers()) return lastStatus;
  pollInFlight = true;
  try {
    const j = await printerPost("/detail");
    lastStatus = { online: true, detail: j.detail || {}, error: null, ts: Date.now(), printerIp: CFG.ip };
    try { trackPrint(lastStatus.detail); }
    catch (e) { console.error("history:", e.message); }
  } catch (e) {
    const m = String(e.cause?.code || e.message || e);
    lastStatus = {
      online: false,
      detail: lastStatus.detail,
      error: /timeout|aborted|EHOSTDOWN|EHOSTUNREACH|ETIMEDOUT/i.test(m)
        ? `no answer from ${CFG.ip}: printer off or asleep?`
        : /ECONNREFUSED/.test(m) ? `${CFG.ip} refused: is LAN mode on?` : m,
      ts: Date.now(),
      printerIp: CFG.ip,
    };
  } finally {
    pollInFlight = false;
  }
  broadcast();
  return lastStatus;
}

function syncPolling() {
  const want = liveViewers() > 0;
  if (want && !pollTimer) {
    console.log("live viewer — polling printer");
    pollTimer = setInterval(() => poll(), CFG.pollMs);
    poll();
  } else if (!want && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log("no live viewers — printer untouched");
  }
}

// --- print history ---------------------------------------------------------

const DONE_RESULT = {
  completed: "completed",
  ready: "completed",
  cancel: "cancelled",
  cancelled: "cancelled",
  error: "failed",
};

let openPrintId = null;

function itemForGcode(name) {
  const base = basename(String(name || "")).toLowerCase();
  if (!base) return {};
  for (const r of db.all("SELECT id, item_id, gcode_path FROM revisions WHERE gcode_path IS NOT NULL ORDER BY id DESC")) {
    if (basename(r.gcode_path).toLowerCase() === base) return { itemId: r.item_id, revisionId: r.id };
  }
  return {};
}

function trackPrint(d) {
  if (!d) return;
  const status = String(d.status || "").toLowerCase();
  const job = d.printFileName || "";
  const printing = status === "printing" || status === "pause" || status === "paused";

  if (printing && job) {
    let row = openPrintId ? db.get("SELECT * FROM prints WHERE id = ?", openPrintId) : null;
    if (row && (row.gcode_name !== job || row.result !== "running")) row = null;
    if (!row) row = db.openPrint(job);
    if (!row || row.gcode_name !== job) {
      // A different job than the one we were tracking: close the old one blind.
      if (openPrintId) db.endPrint(openPrintId, "unknown");
      const link = itemForGcode(job);
      const local = findGcode(job);
      const st = local ? gcodeStats(local) : null;
      const elapsed = Number(d.printDuration) || 0;
      row = db.startPrint({
        ...link,
        queueId: queueEntryForItem(link.itemId),
        gcodeName: job,
        startedAt: new Date(Date.now() - elapsed * 1000).toISOString(),
        layers: Number(d.targetPrintLayer) || st?.layerCount || null,
        lastLayer: Number(d.printLayer) || 0,
        estSeconds: st?.estSeconds ?? null,
        filamentG: st?.filamentG ?? null,
        filamentType: d.rightFilamentType || d.leftFilamentType || st?.filamentType || null,
      });
      if (row.queue_id) db.setQueueState(row.queue_id, "printing", { startedAt: row.started_at });
      console.log(`print started: ${job}`);
    }
    openPrintId = row.id;
    db.touchPrint(row.id, Number(d.printLayer) || 0);
    return;
  }

  if (openPrintId) {
    const row = db.get("SELECT * FROM prints WHERE id = ?", openPrintId);
    if (row && row.result === "running") {
      const result = DONE_RESULT[status] ||
        (row.layers && row.last_layer >= row.layers - 1 ? "completed" : "unknown");
      db.endPrint(openPrintId, result, Number(d.printDuration) || null);
      console.log(`print ${result}: ${row.gcode_name}`);
    }
    openPrintId = null;
  }
}

function queueEntryForItem(itemId) {
  if (!itemId) return null;
  const q = db.get(
    "SELECT id FROM queue WHERE item_id = ? AND state IN ('ready','waiting') ORDER BY position LIMIT 1",
    itemId,
  );
  return q ? q.id : null;
}

// Adopt a print that was already running before this process started.
(function adoptRunningPrint() {
  const row = db.get("SELECT * FROM prints WHERE result = 'running' ORDER BY started_at DESC LIMIT 1");
  if (row) openPrintId = row.id;
})();

// --- g-code lookup ---------------------------------------------------------

const toolCache = new Map();

function* walk(dir, depth) {
  if (depth < 0 || !existsSync(dir)) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth - 1);
    else yield p;
  }
}

function findGcode(name) {
  const base = basename(String(name || ""));
  if (!base || base !== basename(base) || base.includes("\0")) return null;
  const roots = [CFG.projectsRoot, ...CFG.gcodeDirs];
  for (const dir of roots) {
    const direct = join(dir, base);
    if (existsSync(direct) && statSync(direct).isFile()) return direct;
  }
  for (const dir of roots) {
    for (const p of walk(dir, 3)) {
      if (basename(p) === base) return p;
    }
  }
  return null;
}

function getToolpath(name) {
  const file = findGcode(name);
  if (!file) return null;
  const st = statSync(file);
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  const hit = toolCache.get(name);
  if (hit && hit.key === key) return hit;
  const parsed = parseGcode(file);
  const rec = { key, file, meta: parsed.meta, buf: encodeToolpath(parsed) };
  toolCache.set(name, rec);
  return rec;
}

// --- helpers ---------------------------------------------------------------

function send(res, code, type, body, extra = {}) {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": extra.cache || "no-store",
    ...extra.headers,
  });
  res.end(body);
}

const json = (res, code, obj) => send(res, code, "application/json", JSON.stringify(obj));

function isLoopback(req) {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function readJson(req) {
  return new Promise((ok, bad) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 4e6) { req.destroy(); bad(new Error("body too large")); }
    });
    req.on("end", () => {
      try { ok(b ? JSON.parse(b) : {}); }
      catch { bad(new Error("bad json")); }
    });
    req.on("error", bad);
  });
}

// Every path we hand out or read must sit under the library or the projects
// root — never anywhere else on disk.
function inLibrary(p) {
  const abs = resolve(p);
  for (const root of [CFG.library, CFG.projectsRoot, ...CFG.gcodeDirs]) {
    const r = resolve(root);
    if (abs === r || abs.startsWith(r + sep)) return true;
  }
  return false;
}

function statePayload() {
  return {
    ...lastStatus,
    configured: configured(),
    model: modelName(),
    camera: CFG.camera,
    stale: !lastStatus.ts || Date.now() - lastStatus.ts > CFG.pollMs * 3,
    pollMs: CFG.pollMs,
    filament: {
      ...CFG.filament,
      perGram: CFG.filament.spoolCost / CFG.filament.spoolGrams,
    },
    polling: Boolean(pollTimer),
    viewers: clients.size,
    liveViewers: liveViewers(),
    queue: db.queue(),
    pendingReviews: db.all(`
      SELECT i.id, i.name, i.slug, p.name AS project_name, p.slug AS project_slug,
             r.id AS revision_id, r.rev
      FROM items i
      JOIN projects p ON p.id = i.project_id
      JOIN revisions r ON r.id = (SELECT MAX(id) FROM revisions WHERE item_id = i.id)
      WHERE i.status = 'pending'
      ORDER BY r.created_at
    `),
  };
}

function broadcast() {
  if (!clients.size) return;
  const payload = `data: ${JSON.stringify(statePayload())}\n\n`;
  for (const c of clients) {
    try { c.res.write(payload); }
    catch { clients.delete(c); }
  }
}

// --- camera ----------------------------------------------------------------
//
// The printer runs MJPG-Streamer, which copes badly with more than one viewer
// and is only reachable on the LAN by IP. So the dashboard holds at most one
// upstream connection, opened only while someone is watching, and fans the
// frames out to every viewer. Frames are cut on JPEG SOI/EOI markers rather
// than trusting the upstream multipart framing, so a viewer that joins mid
// stream always starts on a whole frame.

// Settings > what the printer reports > MJPG-Streamer's usual address.
const cameraUrl = () => process.env.CAMERA_URL || CFG.cameraUrl ||
  lastStatus.detail?.cameraStreamUrl || (CFG.ip ? `http://${CFG.ip}:8080/?action=stream` : "");
const snapshotUrl = () => cameraUrl().replace("action=stream", "action=snapshot");
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const BOUNDARY = "camframe";

const cam = { viewers: new Set(), req: null, buf: Buffer.alloc(0), last: null, lastTs: 0, retry: null, error: "" };

function camEmit(frame) {
  cam.last = frame;
  cam.lastTs = Date.now();
  cam.error = "";
  for (const res of cam.viewers) {
    // A viewer on slow Wi-Fi skips frames instead of buffering without bound.
    if (res.writableLength > 1_000_000) continue;
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    res.write(frame);
    res.write("\r\n");
  }
}

function camData(chunk) {
  cam.buf = cam.buf.length ? Buffer.concat([cam.buf, chunk]) : chunk;
  for (;;) {
    const start = cam.buf.indexOf(SOI);
    if (start < 0) { cam.buf = Buffer.alloc(0); return; }
    const end = cam.buf.indexOf(EOI, start + 2);
    if (end < 0) {
      cam.buf = cam.buf.subarray(start);
      if (cam.buf.length > 5_000_000) cam.buf = Buffer.alloc(0);
      return;
    }
    camEmit(Buffer.from(cam.buf.subarray(start, end + 2)));
    cam.buf = cam.buf.subarray(end + 2);
  }
}

function camStart() {
  if (cam.req || !cam.viewers.size) return;
  clearTimeout(cam.retry);
  let req;
  try {
    req = http.get(cameraUrl(), (up) => {
      if (up.statusCode !== 200) { up.resume(); return camFail(req, `camera answered HTTP ${up.statusCode}`); }
      up.on("data", (c) => { if (cam.req === req) camData(c); });
      up.on("end", () => camFail(req, "camera stream ended"));
      up.on("error", (e) => camFail(req, e.message));
    });
  } catch (e) {
    // A malformed camera URL from Settings throws synchronously.
    cam.error = String(e.message || e);
    return;
  }
  // Socket idle timeout: a stalled stream is dropped and retried.
  req.setTimeout(10000, () => req.destroy(new Error("camera did not respond")));
  req.on("error", (e) => camFail(req, e.message));
  cam.req = req;
}

function camFail(req, why) {
  if (cam.req !== req) return;
  cam.req = null;
  cam.buf = Buffer.alloc(0);
  cam.error = why;
  if (cam.viewers.size) cam.retry = setTimeout(camStart, 3000);
}

function camStop() {
  if (cam.viewers.size) return;
  clearTimeout(cam.retry);
  const req = cam.req;
  cam.req = null;
  cam.buf = Buffer.alloc(0);
  req?.destroy();
}

// After Settings changes the printer or camera address: drop the old
// connection and, if anyone is watching, reconnect to the new one.
function camRestart() {
  clearTimeout(cam.retry);
  const req = cam.req;
  cam.req = null;
  cam.buf = Buffer.alloc(0);
  cam.last = null;
  cam.error = "";
  req?.destroy();
  if (!CFG.camera) {
    for (const res of cam.viewers) res.end();
    cam.viewers.clear();
    return;
  }
  camStart();
}

// --- routes ----------------------------------------------------------------

const routes = [];
const on = (method, pattern, handler, opts = {}) =>
  routes.push({ method, pattern, handler, local: Boolean(opts.local) });

on("GET", /^\/api\/status$/, (req, res) => json(res, 200, statePayload()));

on("GET", /^\/api\/events$/, (req, res, _m, url) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const client = { res, live: url.searchParams.get("live") !== "0" };
  clients.add(client);
  try { res.write(`data: ${JSON.stringify(statePayload())}\n\n`); }
  catch { clients.delete(client); return; }
  req.on("close", () => { clients.delete(client); syncPolling(); });
  syncPolling();
});

// One printer read on demand, regardless of the auto-refresh toggle.
on("POST", /^\/api\/refresh$/, async (req, res) => {
  await poll(true);
  json(res, 200, statePayload());
});

on("GET", /^\/api\/camera\/stream$/, (req, res) => {
  if (!CFG.camera) return json(res, 404, { error: "camera disabled in Settings" });
  if (!cameraUrl()) return json(res, 503, { error: "printer not configured - open Settings" });
  res.writeHead(200, {
    "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    "Cache-Control": "no-store",
    Connection: "close",
  });
  cam.viewers.add(res);
  // Show something at once rather than waiting for the next frame.
  if (cam.last && Date.now() - cam.lastTs < 2000) {
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${cam.last.length}\r\n\r\n`);
    res.write(cam.last);
    res.write("\r\n");
  }
  req.on("close", () => { cam.viewers.delete(res); camStop(); });
  camStart();
});

on("GET", /^\/api\/camera\/snapshot$/, async (req, res) => {
  const headers = { "Content-Disposition": `inline; filename="camera-${Date.now()}.jpg"` };
  if (!CFG.camera) return json(res, 404, { error: "camera disabled in Settings" });
  if (cam.last && Date.now() - cam.lastTs < 2000) return send(res, 200, "image/jpeg", cam.last, { headers });
  if (!snapshotUrl()) return json(res, 503, { error: "printer not configured - open Settings" });
  let r;
  try { r = await fetch(snapshotUrl(), { signal: AbortSignal.timeout(8000) }); }
  catch (e) { return json(res, 502, { error: `camera unreachable: ${e.cause?.code || e.message}` }); }
  if (!r.ok) return json(res, 502, { error: `camera answered HTTP ${r.status}` });
  send(res, 200, "image/jpeg", Buffer.from(await r.arrayBuffer()), { headers });
});

// --- settings --------------------------------------------------------------
//
// The check code is write-only: it is never sent back to a browser. Saving is
// limited to this computer unless config.json sets allowRemoteSettings.

const canEditSettings = (req) => CFG.allowRemoteSettings || isLoopback(req);
const MODELS = ["", ...Object.values(PIDS)];
const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const CODE_RE = /^[A-Za-z0-9]{4,40}$/;

function settingsPayload(req) {
  const edit = canEditSettings(req);
  return {
    configured: configured(),
    canEdit: edit,
    ip: CFG.ip,
    // The serial is half the login; show it in full only where it can be edited.
    serial: edit ? CFG.serial : CFG.serial.replace(/.(?=.{4})/g, "•"),
    checkCodeSet: Boolean(CFG.checkCode),
    model: CFG.model,
    detectedModel: modelFromPid(lastStatus.detail?.pid),
    camera: CFG.camera,
    cameraUrl: CFG.cameraUrl,
    cameraUrlInUse: cameraUrl(),
    models: MODELS,
    envLocked: ENV_LOCKED,
    file: edit ? (printerFile || PRINTER_DEFAULT_FILE) : null,
  };
}

// Validate a Settings form. An empty check code keeps the saved one, so the
// form never needs to hold it.
function settingsFromBody(b) {
  const out = {
    ip: String(b.ip ?? CFG.ip).trim(),
    serial: String(b.serial ?? CFG.serial).trim(),
    checkCode: String(b.checkCode || "").trim() || CFG.checkCode,
    model: String(b.model ?? CFG.model).trim(),
    camera: b.camera === undefined ? CFG.camera : Boolean(b.camera),
    cameraUrl: String(b.cameraUrl ?? CFG.cameraUrl).trim(),
  };
  if (!IP_RE.test(out.ip)) throw new Error("IP address looks wrong");
  if (!CODE_RE.test(out.serial)) throw new Error("serial number looks wrong (letters and digits only)");
  if (!CODE_RE.test(out.checkCode)) throw new Error("check code looks wrong (letters and digits only)");
  if (!MODELS.includes(out.model)) throw new Error(`model must be one of: ${MODELS.filter(Boolean).join(", ")}`);
  if (out.cameraUrl && !/^https?:\/\/[^\s]+$/i.test(out.cameraUrl)) throw new Error("camera URL must start with http://");
  return out;
}

on("GET", /^\/api\/settings$/, (req, res) => json(res, 200, settingsPayload(req)));

on("POST", /^\/api\/settings\/test$/, async (req, res) => {
  if (!canEditSettings(req)) return json(res, 403, { error: "open the dashboard on the computer that runs it to change Settings" });
  let s;
  try { s = settingsFromBody(await readJson(req)); }
  catch (e) { return json(res, 400, { error: e.message }); }
  try {
    const j = await printerPost("/detail", {}, s);
    const d = j.detail || {};
    json(res, 200, {
      ok: true,
      model: modelFromPid(d.pid) || `unknown (pid ${d.pid})`,
      firmware: d.firmwareVersion || "?",
      status: d.status || "?",
      camera: Boolean(d.cameraStreamUrl),
    });
  } catch (e) {
    const m = String(e.cause?.code || e.message || e);
    const hint = /ECONNREFUSED/.test(m) ? "port 8898 refused: is LAN mode on?"
      : /timeout|ETIMEDOUT|EHOSTUNREACH|EHOSTDOWN|aborted/i.test(m) ? "no answer: wrong IP, or printer off / asleep"
      : m;
    json(res, 200, { ok: false, error: hint });
  }
});

on("POST", /^\/api\/settings\/discover$/, async (req, res) => {
  if (!canEditSettings(req)) return json(res, 403, { error: "open the dashboard on the computer that runs it to change Settings" });
  json(res, 200, await discoverPrinters());
});

on("POST", /^\/api\/settings$/, async (req, res) => {
  if (!canEditSettings(req)) return json(res, 403, { error: "open the dashboard on the computer that runs it to change Settings" });
  let s;
  try { s = settingsFromBody(await readJson(req)); }
  catch (e) { return json(res, 400, { error: e.message }); }

  const file = printerFile || PRINTER_DEFAULT_FILE;
  let existing = {};
  try { existing = JSON.parse(readFileSync(file, "utf8")); } catch { /* new file */ }
  const out = { ...existing, ip: s.ip, serial: s.serial, checkCode: s.checkCode, model: s.model, camera: s.camera };
  if (s.cameraUrl) out.cameraUrl = s.cameraUrl; else delete out.cameraUrl;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  printerFile = file;

  const printerChanged = s.ip !== CFG.ip || s.serial !== CFG.serial;
  if (!ENV_LOCKED.includes("PRINTER_IP")) CFG.ip = s.ip;
  if (!ENV_LOCKED.includes("PRINTER_SERIAL")) CFG.serial = s.serial;
  if (!ENV_LOCKED.includes("PRINTER_CHECKCODE")) CFG.checkCode = s.checkCode;
  Object.assign(CFG, { model: s.model, camera: s.camera, cameraUrl: s.cameraUrl });
  if (printerChanged) lastStatus = { online: false, detail: null, error: "not polled yet", ts: 0, printerIp: CFG.ip };
  console.log(`settings saved to ${file} (printer ${CFG.ip})`);

  camRestart();
  await poll(true);
  json(res, 200, settingsPayload(req));
});

on("GET", /^\/api\/camera$/, (req, res) => json(res, 200, {
  enabled: CFG.camera,
  url: cameraUrl(),
  viewers: cam.viewers.size,
  connected: Boolean(cam.req),
  lastFrameAgoMs: cam.lastTs ? Date.now() - cam.lastTs : null,
  error: cam.error || null,
}));

on("GET", /^\/api\/info$/, (req, res) => json(res, 200, {
  port: CFG.port,
  printerIp: CFG.ip,
  library: CFG.library,
  projectsRoot: CFG.projectsRoot,
  db: CFG.db,
  urls: ["127.0.0.1", ...lanAddrs()].map((a) => `http://${a}:${CFG.port}`),
  viewOnly: true,
  viewers: clients.size,
  liveViewers: liveViewers(),
  polling: Boolean(pollTimer),
  pollMs: CFG.pollMs,
  printerHits,
}));

// --- projects --------------------------------------------------------------

on("GET", /^\/api\/projects$/, (req, res, _m, url) => json(res, 200, {
  projects: db.projects({
    search: url.searchParams.get("q") || "",
    tag: url.searchParams.get("tag") || "",
    includeArchived: url.searchParams.get("archived") === "1",
  }),
  tags: db.allTags(),
}));

on("POST", /^\/api\/projects$/, async (req, res) => {
  const b = await readJson(req);
  const name = String(b.name || "").trim();
  if (!name) return json(res, 400, { error: "name required" });
  const slug = slugify(b.slug || name);
  const dir = join(CFG.projectsRoot, slug);
  mkdirSync(dir, { recursive: true });
  const p = db.createProject({ name, slug, dir, notes: String(b.notes || ""), tags: b.tags || [] });
  console.log(`project created: ${p.slug}`);
  broadcast();
  json(res, 200, p);
}, { local: true });

on("GET", /^\/api\/projects\/([^/]+)$/, (req, res, m) => {
  const p = db.project(decodeURIComponent(m[1]));
  if (!p) return json(res, 404, { error: "no such project" });
  json(res, 200, {
    ...p,
    items: db.itemsOf(p.id),
    prints: db.prints({ projectId: p.id, limit: 30 }),
    notes: db.all("SELECT * FROM notes WHERE project_id = ? ORDER BY created_at DESC", p.id),
  });
});

on("PATCH", /^\/api\/projects\/(\d+)$/, async (req, res, m) => {
  const b = await readJson(req);
  const p = db.updateProject(Number(m[1]), b);
  broadcast();
  json(res, 200, p);
});

// --- export / import / MakerWorld --------------------------------------------

function readRaw(req, limit = 1024 ** 3) {
  return new Promise((ok, bad) => {
    const parts = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { req.destroy(); bad(new Error("upload too large (1 GB max)")); return; }
      parts.push(c);
    });
    req.on("end", () => ok(Buffer.concat(parts)));
    req.on("error", bad);
  });
}

const zipHeaders = (filename) => ({
  "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"`,
});

// ?projects=slug1,slug2 (default: all)  &gcode=0 to leave G-code out
on("GET", /^\/api\/export$/, (req, res, _m, url) => {
  const slugs = (url.searchParams.get("projects") || "").split(",").map((s) => s.trim()).filter(Boolean);
  let out;
  try { out = exportProjects(db, { slugs, gcode: url.searchParams.get("gcode") !== "0" }); }
  catch (e) { return json(res, 400, { error: e.message }); }
  console.log(`export: ${out.projects} project(s), ${out.files} file(s), ${(out.zip.length / 1e6).toFixed(1)} MB`);
  send(res, 200, "application/zip", out.zip, { headers: zipHeaders(out.filename) });
});

// Body: the ZIP. ?mode=skip|copy  &dryRun=1 to preview  &name=<original file name>
on("POST", /^\/api\/import$/, async (req, res, _m, url) => {
  if (!canEditSettings(req)) return json(res, 403, { error: "import from a browser on the computer that runs the dashboard" });
  let buf;
  try { buf = await readRaw(req); }
  catch (e) { return json(res, 413, { error: e.message }); }
  try {
    const out = importProjects(db, CFG, buf, {
      mode: url.searchParams.get("mode") || "skip",
      dryRun: url.searchParams.get("dryRun") === "1",
      archiveName: url.searchParams.get("name") || "",
    });
    if (!out.dryRun) {
      const done = out.projects.filter((p) => p.imported).length;
      console.log(`import: ${done} project(s) imported, ${out.projects.length - done} skipped or failed`);
      broadcast();
    }
    json(res, 200, out);
  } catch (e) { json(res, 400, { error: e.message }); }
});

const OPENSCAD = process.env.OPENSCAD_BIN || ["/opt/homebrew/bin/openscad", "/usr/local/bin/openscad",
  "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD", "/usr/bin/openscad"].find((p) => existsSync(p)) || "";

on("GET", /^\/api\/projects\/([^/]+)\/makerworld$/, (req, res, m) => {
  let out;
  try {
    out = makerworldPackage(db, CFG, decodeURIComponent(m[1]), { openscad: OPENSCAD, printerModel: modelName() });
  } catch (e) { return json(res, 400, { error: e.message }); }
  console.log(`makerworld package: ${m[1]} (${out.parts} part(s), ${out.images} image(s))`);
  send(res, 200, "application/zip", out.zip, {
    headers: { ...zipHeaders(out.filename), "X-Warnings": encodeURIComponent(out.warnings.join(" | ")) },
  });
});

// --- items -----------------------------------------------------------------

on("POST", /^\/api\/items$/, async (req, res) => {
  const b = await readJson(req);
  const project = db.project(b.project);
  if (!project) return json(res, 400, { error: `no project "${b.project}"` });

  const name = String(b.name || "").trim();
  if (!name) return json(res, 400, { error: "name required" });

  // Copy the sources into the project directory so a project is self-contained.
  const stored = {};
  for (const [key, col] of [["stl", "stlPath"], ["scad", "scadPath"], ["gcode", "gcodePath"]]) {
    const src = b[key] ? resolve(String(b[key])) : "";
    if (!src) continue;
    if (!existsSync(src) || !statSync(src).isFile()) {
      return json(res, 400, { error: `no ${key} file at ${src}` });
    }
    const dest = join(project.dir, basename(src));
    if (resolve(dest) !== src) {
      mkdirSync(project.dir, { recursive: true });
      copyFileSync(src, dest);
    }
    stored[col] = dest;
  }
  if (!stored.stlPath && !stored.gcodePath) {
    return json(res, 400, { error: "an stl or gcode path is required" });
  }

  const slug = slugify(b.slug || name);
  let item = db.get("SELECT * FROM items WHERE project_id = ? AND slug = ?", project.id, slug);
  if (!item) item = db.createItem({ projectId: project.id, name, slug, tags: b.tags || [] });
  else if (b.tags) db.setTags("item", item.id, b.tags);

  const st = stored.gcodePath ? gcodeStats(stored.gcodePath) : null;
  const rev = db.addRevision(item.id, {
    ...stored,
    layerCount: st?.layerCount ?? null,
    estSeconds: st?.estSeconds ?? null,
    filamentG: st?.filamentG ?? null,
    filamentType: st?.filamentType ?? null,
    note: String(b.note || ""),
  });
  console.log(`item revision: ${project.slug}/${slug} v${rev.rev}`);
  broadcast();
  json(res, 200, { item: db.item(item.id), revision: rev });
}, { local: true });

on("GET", /^\/api\/items\/(\d+)$/, (req, res, m) => {
  const it = db.item(Number(m[1]));
  if (!it) return json(res, 404, { error: "no such item" });
  json(res, 200, { ...it, prints: db.prints({ itemId: it.id, limit: 20 }) });
});

on("POST", /^\/api\/items\/(\d+)\/decide$/, async (req, res, m) => {
  const b = await readJson(req);
  const decision = b.action === "approve" ? "approved" : b.action === "reject" ? "rejected" : "";
  if (!decision) return json(res, 400, { error: "action must be approve or reject" });
  const it = db.item(Number(m[1]));
  if (!it || !it.revision) return json(res, 404, { error: "no revision to decide on" });
  if (b.revisionId && Number(b.revisionId) !== it.revision.id) {
    return json(res, 409, { error: "that revision has been superseded", item: it });
  }
  db.decide(it.revision.id, decision, String(b.note || ""));
  if (b.note) db.addNote({ itemId: it.id, body: String(b.note), author: "user" });
  console.log(`${decision}: ${it.projectSlug}/${it.slug} v${it.revision.rev}`);
  broadcast();
  json(res, 200, db.item(it.id));
});

on("POST", /^\/api\/items\/(\d+)\/notes$/, async (req, res, m) => {
  const b = await readJson(req);
  const body = String(b.body || "").trim();
  if (!body) return json(res, 400, { error: "body required" });
  db.addNote({ itemId: Number(m[1]), body, author: b.author || "user" });
  broadcast();
  json(res, 200, db.item(Number(m[1])));
});

on("PATCH", /^\/api\/items\/(\d+)$/, async (req, res, m) => {
  const b = await readJson(req);
  const id = Number(m[1]);
  if (b.tags) db.setTags("item", id, b.tags);
  if (b.name) db.run("UPDATE items SET name = ?, updated_at = ? WHERE id = ?", b.name, now(), id);
  if (b.status) db.setItemStatus(id, b.status);
  broadcast();
  json(res, 200, db.item(id));
});

on("GET", /^\/api\/revisions\/(\d+)\/stl$/, (req, res, m) => {
  const rev = db.get("SELECT * FROM revisions WHERE id = ?", Number(m[1]));
  if (!rev?.stl_path || !existsSync(rev.stl_path)) return json(res, 404, { error: "no stl" });
  if (!inLibrary(rev.stl_path)) return json(res, 403, { error: "outside the library" });
  send(res, 200, "model/stl", readFileSync(rev.stl_path), { cache: "private, max-age=300" });
});

// --- queue -----------------------------------------------------------------

on("GET", /^\/api\/queue$/, (req, res) => json(res, 200, {
  queue: db.queue(),
  history: db.queueHistory(20),
}));

on("POST", /^\/api\/queue$/, async (req, res) => {
  const b = await readJson(req);
  const ids = Array.isArray(b.items) ? b.items : [b.item].filter(Boolean);
  if (!ids.length) return json(res, 400, { error: "items required" });
  const added = ids.map((id) => db.enqueue(Number(id), b.revisionId || null, String(b.note || "")));
  broadcast();
  json(res, 200, { added, queue: db.queue() });
});

on("DELETE", /^\/api\/queue\/(\d+)$/, (req, res, m) => {
  db.dequeue(Number(m[1]));
  broadcast();
  json(res, 200, { queue: db.queue() });
});

on("POST", /^\/api\/queue\/reorder$/, async (req, res) => {
  const b = await readJson(req);
  if (!Array.isArray(b.ids)) return json(res, 400, { error: "ids required" });
  db.reorderQueue(b.ids.map(Number));
  broadcast();
  json(res, 200, { queue: db.queue() });
});

// The peel-off gate. Nothing moves to the next item until this is called.
on("POST", /^\/api\/queue\/release$/, async (req, res) => {
  const b = await readJson(req);

  // The machine may be busy with a job that never came from this queue, so take
  // one fresh reading on this explicit action rather than trusting the cache.
  const s = await poll(true);
  const st = String(s.detail?.status || "").toLowerCase();
  if (s.online && ["printing", "pause", "paused", "busy"].includes(st)) {
    return json(res, 409, {
      error: `the printer is ${st} "${s.detail?.printFileName || "a job"}" — wait for it to finish`,
    });
  }

  const out = db.releaseNext(b.id || null);
  if (out.error) return json(res, 409, out);
  console.log(`queue released: entry ${out.entry.id}`);
  broadcast();
  json(res, 200, { ...out, queue: db.queue() });
});

on("POST", /^\/api\/queue\/(\d+)\/state$/, async (req, res, m) => {
  const b = await readJson(req);
  const state = String(b.state || "");
  if (!["waiting", "ready", "printing", "done", "failed", "skipped"].includes(state)) {
    return json(res, 400, { error: "bad state" });
  }
  const entry = db.setQueueState(Number(m[1]), state, {
    startedAt: state === "printing" ? now() : undefined,
    endedAt: ["done", "failed", "skipped"].includes(state) ? now() : undefined,
    note: b.note,
  });
  broadcast();
  json(res, 200, { entry, queue: db.queue() });
});

// --- history and stats -----------------------------------------------------

on("GET", /^\/api\/prints$/, (req, res, _m, url) => json(res, 200, {
  prints: db.prints({ limit: Number(url.searchParams.get("limit")) || 100 }),
  stats: db.stats(),
}));

on("POST", /^\/api\/prints\/(\d+)\/outcome$/, async (req, res, m) => {
  const b = await readJson(req);
  const p = db.setOutcome(Number(m[1]), String(b.outcome || ""), String(b.note || ""));
  broadcast();
  json(res, 200, p);
});

// --- model rendering -------------------------------------------------------

on("GET", /^\/api\/model$/, (req, res, _m, url) => {
  const name = url.searchParams.get("name") || lastStatus.detail?.printFileName;
  if (!name) return json(res, 404, { error: "no job" });
  const rec = getToolpath(name);
  if (!rec) return json(res, 404, { error: "gcode not found locally", name });
  send(res, 200, "application/octet-stream", rec.buf, {
    headers: {
      "X-Model-Name": encodeURIComponent(basename(rec.file)),
      "X-Layer-Count": String(rec.meta.layerCount),
    },
  });
});

on("GET", /^\/api\/model-meta$/, (req, res, _m, url) => {
  const name = url.searchParams.get("name") || lastStatus.detail?.printFileName;
  if (!name) return json(res, 404, { error: "no job" });
  const rec = getToolpath(name);
  if (!rec) return json(res, 404, { error: "gcode not found locally", name });
  json(res, 200, { name: basename(rec.file), ...rec.meta });
});

// --- static ----------------------------------------------------------------

function serveStatic(urlPath, res) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  rel = rel.replace(/^\/+/, "").replace(/\\/g, "/");
  const abs = resolve(PUBLIC, rel);
  const root = resolve(PUBLIC) + sep;
  if (abs !== resolve(PUBLIC) && !abs.startsWith(root)) return send(res, 403, "text/plain", "forbidden");
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    // Client-side routes fall back to the app shell.
    if (!rel.includes(".")) return send(res, 200, MIME[".html"], readFileSync(join(PUBLIC, "index.html")));
    return send(res, 404, "text/plain", "not found");
  }
  const ext = extname(abs).toLowerCase();
  send(res, 200, MIME[ext] || "application/octet-stream", readFileSync(abs), {
    cache: rel.startsWith("vendor/") ? "public, max-age=86400" : "no-store",
  });
}

function lanAddrs() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) if (n.family === "IPv4" && !n.internal) out.push(n.address);
  }
  return out;
}

// Printers announce themselves over UDP in a format nobody has documented, so
// look for port 8898 across this computer's /24 networks instead.
function probe(ip, ms = 400) {
  return new Promise((done) => {
    const s = createConnection({ host: ip, port: PORT_PRINTER });
    const end = (v) => { s.destroy(); done(v); };
    s.setTimeout(ms);
    s.on("connect", () => end(ip));
    s.on("timeout", () => end(null));
    s.on("error", () => end(null));
  });
}

async function discoverPrinters() {
  const bases = [...new Set(lanAddrs().map((a) => a.split(".").slice(0, 3).join(".")))];
  const found = [];
  for (const base of bases) {
    const targets = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
    for (let i = 0; i < targets.length; i += 64) {
      found.push(...(await Promise.all(targets.slice(i, i + 64).map((t) => probe(t)))).filter(Boolean));
    }
  }
  return { found, scanned: bases.map((b) => `${b}.0/24`) };
}

async function onRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    if (r.local && !isLoopback(req)) return json(res, 403, { error: "this endpoint is local only" });
    try { return await r.handler(req, res, m, url); }
    catch (e) {
      console.error(`${req.method} ${path}:`, e.message);
      if (!res.headersSent) return json(res, 500, { error: String(e.message || e) });
      return res.end();
    }
  }

  if (req.method === "GET") return serveStatic(path, res);
  send(res, 405, "text/plain", "method not allowed");
}

for (const dir of [CFG.projectsRoot, ...CFG.gcodeDirs]) {
  if (!existsSync(dir)) continue;
  try { watch(dir, { persistent: false }, () => toolCache.clear()); }
  catch { /* watch is optional */ }
}

function listenOn(port) {
  const s = http.createServer(onRequest);
  s.on("error", (e) => console.error(`Could not listen on ${port}: ${e.code || e.message}`));
  s.listen(port, "0.0.0.0", () => {
    for (const a of ["127.0.0.1", ...lanAddrs()]) {
      console.log(`  ${port === 80 ? `http://${a}` : `http://${a}:${port}`}`);
    }
  });
  return s;
}

console.log("Flashforge Adventurer 5M / 5M Pro dashboard — projects, queue, history (printer is read-only)");
console.log(`  library  ${CFG.library}`);
console.log(`  projects ${CFG.projectsRoot}`);
console.log(`  db       ${CFG.db}`);
listenOn(CFG.port);
if (CFG.listen80 && CFG.port !== 80) listenOn(80);
console.log(configured()
  ? `Printer ${CFG.ip}:${PORT_PRINTER} is read only while a tab has auto-refresh on.`
  : "No printer yet: open Settings in the dashboard.");
