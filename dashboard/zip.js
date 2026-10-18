// Minimal ZIP writer and reader, so export/import needs no dependencies.
//
// Writes deflate (or store, when deflate does not help) with UTF-8 names.
// Reads store and deflate entries, checks CRCs, and refuses anything that
// could escape the destination folder. No ZIP64: archives stay under 4 GB.

import { deflateRawSync, inflateRawSync, crc32 } from "node:zlib";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const UTF8 = 0x0800;

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// entries: [{ name, data: Buffer, mtime?: Date }]
export function createZip(entries) {
  if (entries.length > 0xffff) throw new Error("too many files for one archive");
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const deflated = deflateRawSync(data, { level: 6 });
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const crc = crc32(data);
    const { time, date } = dosTime(e.mtime || new Date());
    if (offset + 30 + name.length + body.length > 0xffffffff) throw new Error("archive larger than 4 GB");

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(UTF8, 6);
    lh.writeUInt16LE(store ? 0 : 8, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CENTRAL, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(UTF8, 8);
    ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += 30 + name.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// A safe relative path, or null for anything that must not be extracted:
// absolute paths, "..", drive letters, and macOS/Windows metadata.
export function safeEntryName(raw) {
  const name = String(raw).replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!name || name.startsWith("/") || /^[a-z]:/i.test(name)) return null;
  const parts = name.split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p === ".")) return null;
  if (parts[0] === "__MACOSX" || parts.at(-1) === ".DS_Store" || parts.at(-1) === "Thumbs.db") return null;
  return parts.join("/");
}

// Returns [{ name, data }] for every file entry. Directories are skipped.
export function readZip(buf, { maxEntries = 10000, maxBytes = 2 * 1024 ** 3 } = {}) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_END) { end = i; break; }
  }
  if (end < 0) throw new Error("not a ZIP archive");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  if (count > maxEntries) throw new Error(`archive has ${count} files, the limit is ${maxEntries}`);

  const out = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error("corrupt ZIP central directory");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith("/")) continue;
    const name = safeEntryName(rawName);
    if (!name) continue;
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error("ZIP64 archives are not supported");
    total += usize;
    if (total > maxBytes) throw new Error("archive too large once unpacked");

    if (buf.readUInt32LE(local) !== SIG_LOCAL) throw new Error(`corrupt ZIP entry ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = inflateRawSync(body, { maxOutputLength: Math.max(usize, 1) });
    else throw new Error(`${name}: unsupported compression method ${method}`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`${name}: checksum mismatch`);
    out.push({ name, data });
  }
  return out;
}
