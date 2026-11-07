import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { slugify } from "../db.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = "test-token";
const servers = [];
const dirs = [];

// Start `node server.js` with every path overridden into a temp folder, so the
// real library in config.json is never touched. Retries on a busy port.
async function startServer(env = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "dash-upload-"));
  dirs.push(tmp);
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = 34000 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        DASH_PORT: String(port),
        DASH_LISTEN80: "0",
        DASH_DB: join(tmp, "dash.db"),
        PRINT_LIBRARY: join(tmp, "lib"),
        PROJECTS_ROOT: join(tmp, "projects"),
        GCODE_DIRS: join(tmp, "gcode"),
        PRINTER_IP: "", PRINTER_SERIAL: "", PRINTER_CHECKCODE: "",
        PRINTER_CONFIG: join(tmp, "none.json"),
        SKETCH_UPLOAD_TOKEN: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 100 && child.exitCode === null; i++) {
      if (out.includes(`Could not listen on ${port}`)) break;
      try { if ((await fetch(`${base}/api/settings`)).ok) { up = true; break; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (up) { servers.push(child); return { base, tmp, child }; }
    child.kill();
  }
  throw new Error("could not start the dashboard");
}

const post = (base, path, body, headers = {}) => fetch(base + path, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const auth = { authorization: `Bearer ${TOKEN}` };

const payload = (over = {}) => ({
  project: "bracket-project",
  name: "bracket",
  note: "from sketch2d rev 7",
  source: "https://sketch.lacrete.casa/#/s/parts/bracket.sketch.json",
  files: {
    stl: { name: "bracket.stl", base64: Buffer.from("solid x\nendsolid x\n").toString("base64") },
    scad: { name: "bracket.scad", text: "cube(10);\n" },
    sketch: { name: "bracket.sketch.json", text: '{"format":"sketch2d","version":1}' },
  },
  ...over,
});

let S, projectDir;
before(async () => {
  S = await startServer({ SKETCH_UPLOAD_TOKEN: TOKEN });
  const r = await post(S.base, "/api/projects", { name: "bracket project" });
  assert.equal(r.status, 200);
  projectDir = (await r.json()).dir;
});
after(() => {
  for (const c of servers) c.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const inside = (p) => resolve(p).startsWith(resolve(projectDir) + "/");

test("no token -> 401", async () => {
  assert.equal((await post(S.base, "/api/items/upload", payload())).status, 401);
});

test("wrong token -> 401 (also a different length)", async () => {
  for (const t of ["nope", "test-tokeX", "x".repeat(200)]) {
    assert.equal((await post(S.base, "/api/items/upload", payload(), { authorization: `Bearer ${t}` })).status, 401);
  }
});

test("server without SKETCH_UPLOAD_TOKEN -> 404", async () => {
  const S2 = await startServer();
  const r = await post(S2.base, "/api/items/upload", payload(), auth);
  assert.equal(r.status, 404);
});

test("uploads stl + scad + sketch", async () => {
  const r = await post(S.base, "/api/items/upload", payload(), auth);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.revision.rev, 1);
  assert.equal(j.revision.source_url, "https://sketch.lacrete.casa/#/s/parts/bracket.sketch.json");
  assert.equal(j.revision.note, "from sketch2d rev 7");
  for (const f of ["bracket-r1.stl", "bracket-r1.scad", "bracket-r1.sketch.json"]) {
    assert.ok(existsSync(join(projectDir, f)), f);
  }
  assert.equal(j.revision.stl_path, join(projectDir, "bracket-r1.stl"));
  assert.equal(j.revision.scad_path, join(projectDir, "bracket-r1.scad"));
  assert.equal(readFileSync(join(projectDir, "bracket-r1.stl"), "utf8"), "solid x\nendsolid x\n");
  assert.equal(readFileSync(join(projectDir, "bracket-r1.scad"), "utf8"), "cube(10);\n");
});

test("second upload with the same name -> revision 2, revision 1 untouched", async () => {
  const p = payload({ name: "plate", files: { stl: { name: "plate.stl", base64: "QQ==" } } });
  const j1 = await (await post(S.base, "/api/items/upload", p, auth)).json();
  const j2 = await (await post(S.base, "/api/items/upload", p, auth)).json();
  assert.equal(j1.revision.rev, 1);
  assert.equal(j2.revision.rev, 2);
  assert.equal(j2.item.id, j1.item.id);
  assert.ok(existsSync(join(projectDir, "plate-r1.stl")));
  assert.ok(existsSync(join(projectDir, "plate-r2.stl")));
  assert.equal(j2.revision.stl_path, join(projectDir, "plate-r2.stl"));
  const item = await (await fetch(`${S.base}/api/items/${j1.item.id}`)).json();
  const r1 = item.revisions.find((r) => r.rev === 1);
  assert.equal(r1.stl_path, j1.revision.stl_path);
});

test("bad extension -> 400, nothing written", async () => {
  const p = payload({ name: "evil", files: { stl: { name: "x.exe", base64: "QQ==" } } });
  const r = await post(S.base, "/api/items/upload", p, auth);
  assert.equal(r.status, 400);
  assert.ok(!existsSync(join(projectDir, "x-r1.exe")));
});

test("path traversal in the file name is reduced to the base name", async () => {
  const p = payload({ name: "trav", files: { stl: { name: "../../x.stl", base64: "QQ==" } } });
  const r = await post(S.base, "/api/items/upload", p, auth);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.revision.stl_path, join(projectDir, "x-r1.stl"));
  assert.ok(inside(j.revision.stl_path));
  assert.ok(existsSync(join(projectDir, "x-r1.stl")));
});

test("non-ASCII item name is slugified, files stay in the project folder", async () => {
  const name = "Staffa à 90°";
  const p = payload({
    name,
    files: {
      stl: { name: "Staffa à 90°.stl", base64: "QQ==" },
      sketch: { name: "Staffa à 90°.sketch.json", text: "{}" },
    },
  });
  const r = await post(S.base, "/api/items/upload", p, auth);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.item.slug, slugify(name));
  assert.ok(inside(j.revision.stl_path));
  assert.ok(existsSync(j.revision.stl_path));
  assert.equal(j.revision.stl_path, join(projectDir, `${slugify("Staffa à 90°")}-r1.stl`));
  assert.ok(existsSync(join(projectDir, `${slugify("Staffa à 90°")}-r1.sketch.json`)));
});

test("validation errors", async () => {
  const bad = async (over, status) => {
    const r = await post(S.base, "/api/items/upload", payload(over), auth);
    assert.equal(r.status, status, JSON.stringify(over).slice(0, 80));
  };
  await bad({ project: "" }, 400);
  await bad({ name: " " }, 400);
  await bad({ files: {} }, 400);
  await bad({ files: { stl: { name: "a.stl" } } }, 400);
  await bad({ source: "javascript:alert(1)" }, 400);
  await bad({ source: "not a url" }, 400);
  await bad({ note: "x".repeat(2001) }, 400);
  await bad({ files: { stl: { name: "a.stl", base64: "QQ==" }, scad: { name: "a.txt", text: "" } } }, 400);
  await bad({ project: "no-such-project" }, 404);
  const r = await post(S.base, "/api/items/upload", "{not json", auth);
  assert.equal(r.status, 400);
});

test("optional fields may be omitted", async () => {
  const p = { project: "bracket-project", name: "minimal", files: { stl: { name: "m.stl", base64: "QQ==" } } };
  const r = await post(S.base, "/api/items/upload", p, auth);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.revision.source_url, null);
  assert.equal(j.revision.scad_path, null);
});

test("body over 60 MB -> 413", async () => {
  const big = "A".repeat(61 * 1024 * 1024);
  let status;
  try {
    status = (await post(S.base, "/api/items/upload", payload({ files: { stl: { name: "b.stl", base64: big } } }), auth)).status;
  } catch {
    status = 413; // connection reset while streaming the oversized body
  }
  assert.equal(status, 413);
});
