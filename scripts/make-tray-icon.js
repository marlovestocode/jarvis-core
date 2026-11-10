// Writes assets/tray.png: a 32x32 cyan ring with a core dot. No dependencies.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const S = 32;
const px = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  px[y * (S * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    const d = Math.hypot(x + 0.5 - S / 2, y + 0.5 - S / 2);
    const ring = Math.max(0, 1 - Math.abs(d - 12) / 1.6);
    const core = Math.max(0, 1 - d / 5);
    const a = Math.min(1, ring + core);
    const o = y * (S * 4 + 1) + 1 + x * 4;
    px[o] = 63; px[o + 1] = 215; px[o + 2] = 255; px[o + 3] = Math.round(a * 255);
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'tray.png'), png);
console.log('wrote assets/tray.png', png.length, 'bytes');
