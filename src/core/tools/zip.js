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

function readZip(buf, opts = {}) {
  const entries = listZip(buf, opts);
  return entries.filter(e => opts.only === undefined || e.name === opts.only).map(e => ({ name: e.name, data: readEntry(buf, e) }));
}

module.exports = { readZip, listZip, MAX_ENTRIES, MAX_TOTAL };
