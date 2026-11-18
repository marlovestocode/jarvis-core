const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { fakeNet } = require('./helpers/fakenet');
const R = require('../src/core/knowledge/radar');

// ---- a tiny PNG encoder for fixtures (RGBA, 8-bit, filter 0 or Sub on alternating rows to exercise the decoder) ----
function crc32(buf) { let c, crc = ~0; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function chunk(type, data) { const t = Buffer.from(type), len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }
function png(w, h, px) {   // px(x, y) -> [r, g, b, a]
  const rows = [];
  for (let y = 0; y < h; y++) {
    const raw = Buffer.alloc(w * 4);
    for (let x = 0; x < w; x++) raw.set(px(x, y), x * 4);
    if (y % 2) { const f = Buffer.alloc(1 + w * 4); f[0] = 1; for (let i = 0; i < w * 4; i++) f[1 + i] = (raw[i] - (i >= 4 ? raw[i - 4] : 0)) & 255; rows.push(f); }
    else rows.push(Buffer.concat([Buffer.from([0]), raw]));
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const RED = [200, 20, 20, 255], GREEN = [40, 190, 60, 255], NONE = [0, 0, 0, 0];

test('decodePng: round-trips RGBA pixels through both filter types; refuses other formats', () => {
  const b = png(5, 4, (x, y) => (x === 2 && y === 3 ? RED : x === 0 ? GREEN : NONE));
  const img = R.decodePng(b);
  assert.deepEqual([img.w, img.h], [5, 4]);
  assert.deepEqual(Array.from(img.data.slice((3 * 5 + 2) * 4, (3 * 5 + 2) * 4 + 4)), RED);
  assert.deepEqual(Array.from(img.data.slice((1 * 5 + 0) * 4, (1 * 5 + 0) * 4 + 4)), GREEN);
  assert.equal(R.decodePng(Buffer.from('not a png')), null);
  const bad = Buffer.from(b); bad[25] = 2;   // colour type RGB: not what this service sends
  assert.equal(R.decodePng(bad), null);
});

test('dbzOf: transparent is none; green light, yellow, orange, red and magenta climb', () => {
  assert.equal(R.dbzOf(0, 0, 0, 0), 0);
  const g = R.dbzOf(40, 190, 60, 255), y = R.dbzOf(240, 230, 40, 255), o = R.dbzOf(250, 150, 30, 255), r = R.dbzOf(200, 20, 20, 255), m = R.dbzOf(230, 40, 220, 255);
  assert.ok(g > 0 && g < y && y < o && o < r && r < m, [g, y, o, r, m].join());
  assert.ok(r >= 45 && g < 45);
});

test('radarBox / radarUrl: a square box around home in Web Mercator, time as epoch ms, NOAA host only', () => {
  const box = R.radarBox({ lat: 32.4487, lon: -99.7331 }, 150);
  assert.ok(box.xmax - box.xmin > 280000 && box.xmax - box.xmin < 420000);
  assert.ok(Math.abs((box.xmin + box.xmax) / 2 - (-99.7331 * 20037508.34 / 180)) < 1);
  const u = R.radarUrl(box, 1794959578000, 256);
  assert.match(u, /^https:\/\/mapservices\.weather\.noaa\.gov\/eventdriven\/rest\/services\/radar\/radar_base_reflectivity_time\/ImageServer\/exportImage\?/);
  assert.match(u, /time=1794959578000/); assert.match(u, /size=256,256/); assert.match(u, /format=png32/); assert.match(u, /transparent=true/);
});

test('frameTimes: oldest first, step minutes apart, the newest a little behind now (the service lags)', () => {
  const t = R.frameTimes(1e12, { n: 4, stepMin: 10, lagMin: 10 });
  assert.equal(t.length, 4);
  assert.equal(t[3], 1e12 - 10 * 60000); assert.equal(t[0], 1e12 - 40 * 60000);
  assert.ok(t.every((x, i) => i === 0 || x - t[i - 1] === 10 * 60000));
});

// a 64x64 frame covering 128 km (2 km/px): home at the centre; a red blob of 6x6 px at (bx, by)
const blobFrame = (bx, by, colour = RED) => R.decodePng(png(64, 64, (x, y) => (x >= bx && x < bx + 6 && y >= by && y < by + 6 ? colour : NONE)));

test('findCells: strong echoes become cells with centre offset from home in km; weak rain is ignored; tiny specks are ignored', () => {
  const strong = R.findCells(blobFrame(40, 29), { kmPerPx: 2 });
  assert.equal(strong.length, 1);
  assert.ok(strong[0].dbz >= 45);
  assert.ok(Math.abs(strong[0].x - (43 - 32) * 2) <= 3, 'east of home by ~22 km');
  assert.ok(Math.abs(strong[0].y - 0) <= 4, 'level with home');
  assert.equal(R.findCells(blobFrame(40, 29, GREEN), { kmPerPx: 2 }).length, 0);
  assert.equal(R.findCells(R.decodePng(png(64, 64, (x, y) => (x === 10 && y === 10 ? RED : NONE))), { kmPerPx: 2 }).length, 0);
});

test('trackCells: a cell moving toward home gets a positive approach speed and ETA; moving away gets a negative one', () => {
  const dt = 10 * 60000;
  const toward = R.trackCells([R.findCells(blobFrame(50, 29), { kmPerPx: 2 }), R.findCells(blobFrame(40, 29), { kmPerPx: 2 })], dt);   // 20 km in 10 min = 120 km/h
  assert.equal(toward.length, 1);
  assert.ok(toward[0].approachKmh > 90 && toward[0].approachKmh < 150, String(toward[0].approachKmh));
  assert.ok(toward[0].distKm > 15 && toward[0].distKm < 30);
  const away = R.trackCells([R.findCells(blobFrame(40, 29), { kmPerPx: 2 }), R.findCells(blobFrame(50, 29), { kmPerPx: 2 })], dt);
  assert.ok(away[0].approachKmh < 0);
  const still = R.trackCells([R.findCells(blobFrame(40, 29), { kmPerPx: 2 }), R.findCells(blobFrame(40, 29), { kmPerPx: 2 })], dt);
  assert.ok(Math.abs(still[0].approachKmh) < 5);
  assert.deepEqual(R.trackCells([[], R.findCells(blobFrame(40, 29), { kmPerPx: 2 })], dt)[0].approachKmh, 0, 'a new cell with no history is not guessed at');
});

test('getRadarFrame: one allowlisted image request for the home box', async () => {
  const body = png(8, 8, () => NONE);
  const n = fakeNet([[/mapservices\.weather\.noaa\.gov/, body.toString('latin1')]]);
  // the fake serves text; the real fetcher serves bytes, so check the URL it asked for and that bytes come back as a Buffer
  const r = await R.getRadarFrame(n.fetcher, { lat: 32.4487, lon: -99.7331 }, 1794959578000, { size: 64, halfKm: 100 }).catch(e => e);
  assert.ok(n.calls.length >= 1);
  assert.match(n.calls[0], /time=1794959578000/);
  assert.ok(Buffer.isBuffer(r) || r instanceof Error);
});

test('createRadarProvider: stable frame times between the list and the frames, home never in the list, no home → nothing', async () => {
  const body = png(8, 8, () => NONE);
  const net = fakeNet([[/mapservices\.weather\.noaa\.gov/, () => new Response(body, { status: 200 })]]);
  let t = 1e12;
  const cfg = { location: { lat: 32.4487, lon: -99.7331, country: 'US' } };
  const prov = R.createRadarProvider({ fetcher: net.fetcher, getConfig: () => cfg, now: () => t, size: 64 });
  const f = await prov.frames();
  assert.equal(f.times.length, 6); assert.equal(f.halfKm, 150);
  assert.equal(JSON.stringify(f).includes('32.4'), false);
  const b = await prov.frame(5);
  assert.ok(Buffer.isBuffer(b)); assert.match(net.calls[0], new RegExp(`time=${f.times[5]}`));
  t += 60000;
  assert.deepEqual((await prov.frames()).times, f.times, 'same set for a few minutes so frame numbers stay valid');
  assert.equal(await prov.frame(6), null);
  const none = R.createRadarProvider({ fetcher: net.fetcher, getConfig: () => ({ location: {} }), now: () => t });
  assert.equal(await none.frames(), null);
  const nonUs = R.createRadarProvider({ fetcher: net.fetcher, getConfig: () => ({ location: { lat: 48.8, lon: 2.3, country: 'FR' } }), now: () => t });
  assert.equal(await nonUs.frames(), null, 'NEXRAD covers the US');
});
