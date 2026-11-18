// Radar around home from NOAA's MRMS (NEXRAD mosaic) image service: map frames for the wallpaper, and storm cells for the threat rules.
// Host: mapservices.weather.noaa.gov (allowlisted, source 'weather'). Only a map box around home and a time go out. US coverage only.
// A frame is a transparent RGBA PNG of reflectivity colours. Colours map to approximate dBZ (the service sends no values), so cell
// strength is a class, not a measurement: it is only used to pick out strong echoes (orange and above, about 45+ dBZ).
const zlib = require('node:zlib');

const BASE = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer/exportImage';
const R_EARTH = 6378137, MERC = 20037508.34;
const FRAME_TTL = 5 * 60000;

function radarBox(place, halfKm = 150) {
  const lat = place.lat * Math.PI / 180;
  const cx = place.lon * MERC / 180, cy = Math.log(Math.tan(Math.PI / 4 + lat / 2)) * R_EARTH;
  const half = halfKm * 1000 / Math.cos(lat);   // Web Mercator stretches distances by 1 / cos(lat)
  return { xmin: Math.round(cx - half), ymin: Math.round(cy - half), xmax: Math.round(cx + half), ymax: Math.round(cy + half) };
}

const radarUrl = (b, timeMs, size = 256) => `${BASE}?bbox=${b.xmin},${b.ymin},${b.xmax},${b.ymax}&bboxSR=3857&imageSR=3857&size=${size},${size}&format=png32&transparent=true&time=${Math.round(timeMs)}&f=image`;

// oldest first; the newest is a little behind now because the service lags (the very latest moment comes back empty)
function frameTimes(now, { n = 6, stepMin = 10, lagMin = 10 } = {}) {
  return Array.from({ length: n }, (_, i) => now - (lagMin + (n - 1 - i) * stepMin) * 60000);
}

async function getRadarFrame(fetcher, place, timeMs, { size = 256, halfKm = 150 } = {}) {
  const r = await fetcher.getBytes('weather', radarUrl(radarBox(place, halfKm), timeMs, size), { ttlMs: FRAME_TTL });
  return r.data;
}

// ---- PNG: RGBA, 8-bit, not interlaced (what the service sends); anything else is null ----
function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let o = 8, w = 0, h = 0, ok = false; const idat = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ok = d[8] === 8 && d[9] === 6 && d[12] === 0; }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (!ok || !w || !h || w * h > 4e6) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = w * 4;
  if (raw.length < h * (stride + 1)) return null;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i], a = i >= 4 ? out[dst + i - 4] : 0, b = y ? out[dst - stride + i] : 0, c = i >= 4 && y ? out[dst - stride + i - 4] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + b; else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else return null;
      out[dst + i] = v & 255;
    }
  }
  return { w, h, data: out };
}

// colour → approximate dBZ class (NWS reflectivity ramp): blue light, green moderate, yellow, orange, red heavy, magenta extreme
function dbzOf(r, g, b, a) {
  if (a < 40) return 0;
  if (r > 150 && b > 150 && g < 110) return 65;
  if (r >= 100 && g < 90 && b < 90) return r >= 150 ? 55 : 50;
  if (r >= 200 && g >= 100 && g < 190 && b < 100) return 47;
  if (r >= 200 && g >= 190 && b < 130) return 40;
  if (g > r && g > b) return 28;
  if (b >= r && b >= g) return 15;
  return 10;
}

// Strong echoes (>= minDbz) joined into cells. x east and y north of home (the image centre), in km.
function findCells(img, { kmPerPx, minDbz = 45, minPx = 4 }) {
  if (!img) return [];
  const { w, h, data } = img, dbz = new Uint8Array(w * h), seen = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { const v = dbzOf(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]); dbz[i] = v >= minDbz ? v : 0; }
  const cells = [];
  for (let s = 0; s < w * h; s++) {
    if (!dbz[s] || seen[s]) continue;
    const stack = [s]; seen[s] = 1; let n = 0, sx = 0, sy = 0, max = 0;
    while (stack.length) {
      const p = stack.pop(), px = p % w, py = (p - px) / w;
      n++; sx += px; sy += py; if (dbz[p] > max) max = dbz[p];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (dbz[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (n >= minPx) cells.push({ x: ((sx / n) + .5 - w / 2) * kmPerPx, y: -(((sy / n) + .5) - h / 2) * kmPerPx, dbz: max, px: n });
  }
  return cells;
}

// cells of the last two frames (oldest first), dtMs apart → { dbz, distKm, approachKmh } per newest cell; a cell with no match has approach 0
function trackCells(frames, dtMs) {
  const prev = frames[frames.length - 2] || [], cur = frames[frames.length - 1] || [], hrs = dtMs / 3600000;
  const reach = Math.max(15, 200 * hrs);
  return cur.map(c => {
    let best = null, bd = Infinity;
    for (const p of prev) { const d = Math.hypot(c.x - p.x, c.y - p.y); if (d < bd) { bd = d; best = p; } }
    const dist = Math.hypot(c.x, c.y);
    let approach = 0;
    if (best && bd <= reach && dist > 0 && hrs > 0) approach = (((c.x - best.x) / hrs) * (-c.x / dist)) + (((c.y - best.y) / hrs) * (-c.y / dist));
    return { dbz: c.dbz, distKm: dist, approachKmh: approach, x: c.x, y: c.y };
  });
}

// storm cells around home right now, with how fast each is closing; null when the service has nothing usable (outside the US, down)
async function getRadarCells(fetcher, place, now = Date.now(), { size = 256, halfKm = 150, stepMin = 10 } = {}) {
  const times = frameTimes(now, { n: 2, stepMin, lagMin: 10 });
  const frames = [];
  for (const t of times) { try { frames.push(findCells(decodePng(await getRadarFrame(fetcher, place, t, { size, halfKm })), { kmPerPx: 2 * halfKm / size })); } catch { return null; } }
  return { cells: trackCells(frames, stepMin * 60000), frames: frames.length };
}

// For the wallpaper: the frame times for the last hour (kept 5 min so frame numbers stay valid) and each frame's PNG. Home is used here and never leaves.
function createRadarProvider({ fetcher, getConfig, now = Date.now, size = 512, halfKm = 150 }) {
  let cur = null;
  const home = () => { const l = getConfig().location || {}; return Number.isFinite(l.lat) && Number.isFinite(l.lon) && (!l.country || l.country === 'US') ? { lat: l.lat, lon: l.lon } : null; };
  const times = () => { if (!cur || now() - cur.at > FRAME_TTL) cur = { at: now(), times: frameTimes(now(), { n: 6, stepMin: 10, lagMin: 10 }) }; return cur.times; };
  return {
    async frames() { return home() ? { halfKm, times: times() } : null; },
    async frame(i) { const h = home(), t = h ? times()[i] : undefined; return t === undefined ? null : getRadarFrame(fetcher, h, t, { size, halfKm }); },
  };
}

module.exports = { createRadarProvider, radarBox, radarUrl, frameTimes, getRadarFrame, getRadarCells, decodePng, dbzOf, findCells, trackCells };
