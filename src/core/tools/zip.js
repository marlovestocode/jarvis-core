// Minimal zip reader on node:zlib (stored and deflate entries only). No new dependency.
// readZip(buf, { only?, maxEntries?, maxTotal? }) → [{ name, data }]. Names are returned exactly as stored
// (callers that write files must check them: ".." and absolute names are theirs to refuse).
const zlib = require('node:zlib');

const MAX_ENTRIES = 10000;
const MAX_TOTAL = 500 * 1024 * 1024;

function findEnd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('This is not a zip file');
}

// central directory: [{ name, method, csize, size, offset }]
function listZip(buf, { maxEntries = MAX_ENTRIES, maxTotal = MAX_TOTAL } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('This is not a zip file');
  const end = findEnd(buf);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  if (count > maxEntries) throw new Error(`The zip has ${count} entries; I read at most ${maxEntries}`);
  const out = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The zip is damaged');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x0800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen);
    total += size;
    if (total > maxTotal) throw new Error(`The zip would expand to more than ${Math.round(maxTotal / 1048576)} MB`);
    out.push({ name, method, csize, size, offset, encrypted: !!(flags & 1) });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

function readEntry(buf, e) {
  if (e.encrypted) throw new Error(`${e.name} is encrypted`);
  if (e.name.endsWith('/')) return Buffer.alloc(0);
  const o = e.offset;
  if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) throw new Error('The zip is damaged');
  const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
  const raw = buf.subarray(start, start + e.csize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: e.size + 1 });
  throw new Error(`${e.name} uses a compression I do not support`);
}

// the bytes of one entry from listZip's list
const entryData = readEntry;

function readZip(buf, opts = {}) {
  const entries = listZip(buf, opts);
  return entries.filter(e => opts.only === undefined || e.name === opts.only).map(e => ({ name: e.name, data: readEntry(buf, e) }));
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf);
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name, data }]; a name ending in "/" is a folder. Deflate, UTF-8 names.
function writeZip(entries, { now = Date.now() } = {}) {
  const d = new Date(now);
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nm = Buffer.from(name, 'utf8');
    const isDir = name.endsWith('/');
    const raw = isDir ? Buffer.alloc(0) : Buffer.from(data);
    const comp = isDir || raw.length === 0 ? raw : zlib.deflateRawSync(raw);
    const method = comp === raw ? 0 : 8;
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    locals.push(lh, nm, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(isDir ? 0x10 : 0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nm);
    offset += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length & 0xffff, 8); end.writeUInt16LE(entries.length & 0xffff, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

module.exports = { readZip, listZip, writeZip, entryData, MAX_ENTRIES, MAX_TOTAL };
