// Generates drawings/jarvis-disc-technical.svg (section, exploded view, LED map) and
// drawings/jarvis-disc-wiring.svg (block wiring diagram). Run: node tools/make-technical.js
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, '..', 'drawings');
fs.mkdirSync(out, { recursive: true });
const rad = d => d * Math.PI / 180;
const f = n => Math.round(n * 100) / 100;
const FONT = `'Helvetica Neue', Helvetica, Arial, sans-serif`;
const INK = '#cdd6df', DIM = '#7d8c9c', GOLD = '#d9b87c', BG = '#0b0f14';
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const T = (x, y, s, o = {}) => `<text x="${f(x)}" y="${f(y)}" font-family="${FONT}" font-size="${o.size || 14}" fill="${o.fill || INK}" text-anchor="${o.anchor || 'start'}" ${o.weight ? `font-weight="${o.weight}"` : ''} ${o.ls ? `letter-spacing="${o.ls}"` : ''}>${esc(s)}</text>`;
const L = (x1, y1, x2, y2, o = {}) => `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${o.c || DIM}" stroke-width="${o.w || 1}" ${o.dash ? `stroke-dasharray="${o.dash}"` : ''}/>`;

// ============================================================================
// Technical sheet
// ============================================================================
function technical() {
  const W = 2400, H = 1900;
  let b = `<rect width="${W}" height="${H}" fill="${BG}"/>\n`;
  b += T(80, 90, 'JARVIS DISC  MK I', { size: 30, fill: GOLD, ls: 10 }) + T(80, 128, 'Assembly drawing: section, exploded view, LED map', { size: 17, fill: DIM, ls: 2 }) + '\n';
  b += T(W - 80, 90, 'All dimensions in mm', { size: 15, anchor: 'end', fill: DIM }) + T(W - 80, 116, 'Third-party part sizes are placeholders: verify against the parts you buy', { size: 15, anchor: 'end', fill: DIM }) + '\n';

  // ---------------- section (scale 8) ----------------
  const S = 8, cx = 980, yb = 760, DZ = 16.5;   // DZ: the plinth is 16.5 taller for the 32 mm deep driver
  const X = x => cx + x * S, Z = z => yb - (z >= 21 ? z + 1.5 + DZ : z >= 13 ? z + DZ : z) * S, Zr = z => yb - z * S;   // above z 21 the neck is 1.5 taller
  const poly = (pts, fill, o = {}) => {
    const mk = sgn => pts.map(([r, z]) => `${f(X(sgn * r))},${f(Z(z))}`).join(' ');
    return [1, -1].map(sg => `<polygon points="${mk(sg)}" fill="${fill}" stroke="${o.stroke || '#06080b'}" stroke-width="${o.sw || 1.2}" ${o.op ? `fill-opacity="${o.op}"` : ''}/>`).join('\n') + '\n';
  };
  const rect = (x0, z0, x1, z1, fill, o = {}) => `<rect x="${f(X(x0))}" y="${f(Z(z1))}" width="${f((x1 - x0) * S)}" height="${f((z1 - z0) * S)}" fill="${fill}" stroke="${o.stroke || '#06080b'}" stroke-width="${o.sw || 1}" ${o.op ? `fill-opacity="${o.op}"` : ''} ${o.dash ? `stroke-dasharray="${o.dash}"` : ''}/>\n`;
  const rectR = (x0, z0, x1, z1, fill, o = {}) => `<rect x="${f(X(x0))}" y="${f(Zr(z1))}" width="${f((x1 - x0) * S)}" height="${f((z1 - z0) * S)}" fill="${fill}" stroke="${o.stroke || '#06080b'}" stroke-width="${o.sw || 1}"/>\n`;
  const sym = (x0, z0, x1, z1, fill, o = {}) => rect(x0, z0, x1, z1, fill, o) + rect(-x1, z0, -x0, z1, fill, o);
  const symR = (x0, z0, x1, z1, fill, o = {}) => rectR(x0, z0, x1, z1, fill, o) + rectR(-x1, z0, -x0, z1, fill, o);
  b += T(80, 190, 'SECTION THROUGH THE CENTRE', { size: 15, fill: DIM, ls: 5 }) + '\n';
  b += L(X(-96), Z(0), X(96), Z(0), { c: '#46525f', w: 1.5 }) + '\n';
  // feet (ghosted: they sit at 45 deg positions, r = 40)
  b += sym(23.3, 0, 33.3, 3, '#1a1f26', { stroke: '#46525f', dash: '3 3' });
  // plinth wall + floor
  b += poly([[0, 5], [49.6, 5], [49.6, 13], [43.6, 13], [43.6, 21], [0, 21]], '#1b4f75', { op: 0.5, stroke: '#4a90c0' });   // sealed chamber
  b += poly([[26, 3], [50, 3], [52, 5], [52, 15], [46, 15], [46, 21], [43.6, 21], [43.6, 13], [49.6, 13], [49.6, 5], [26, 5]], '#2d3844');
  // ghost posts that join body and plinth (at 0/120/240 deg, r = 38)
  b += sym(34, 5, 42, 21, '#1d252e', { stroke: '#46525f', dash: '4 3' });
  // speaker driver (face down)
  b += rectR(-26, 5, 26, 5.5, '#c9c2a8', { sw: 0.4 });   // 0.5 mm foam gasket
  b += rectR(-26, 5.5, 26, 8.5, '#6b7380', { sw: 1.2 }) + rectR(-19, 8.5, 19, 20, '#59616f', { sw: 1 }) + rectR(-13, 20, 13, 36.3, '#4b5260', { sw: 1.2 }) + rectR(-22, 5.5, 22, 8.5, '#aab3bf', { sw: 0.6 });
    // controller + amp boards on the plinth floor
  b += symR(24, 9, 44, 10.6, '#17261e', { stroke: '#46525f', dash: '3 3' }) + symR(31, 5, 37, 9, '#4b5663', { stroke: '#06080b', sw: 0.6 });
  // LED strip on the neck + diffuser sleeve
  b += sym(46, 15.5, 47.6, 20.5, '#e5a84a', { sw: 0.6 });
  b += sym(48.2, 15, 49.6, 21, '#f2efe6', { op: 0.45, stroke: '#cfc9b8' });
  // upper body
  b += poly([[12, 21], [67.5, 21], [69.5, 23], [69.5, 30.4], [68.3, 30.4], [68.3, 31], [66.3, 32.8], [64, 34], [62.2, 34], [62.2, 23], [12, 23]], '#222c37');
  // mic board on standoffs, with sound channels up to the window
  b += sym(31, 23, 33, 24, '#4b5663', { sw: 0.6 });
  b += rect(-41, 24, 41, 25.6, '#2b6a4a') + rect(-31.5 - 1.3, 25.6, -31.5 + 1.3, 26.9, '#1c1f24') + rect(31.5 - 1.3, 25.6, 31.5 + 1.3, 26.9, '#1c1f24');
  for (const sg of [-1, 1]) b += L(X(sg * 31.5), Z(26.9), X(sg * 31.5), Z(34), { c: '#6fb8d8', dash: '3 3', w: 1.2 }) + '\n';
  // PCB posts (ghost, at 60 / 300 deg)
  b += sym(48.1, 22.9, 54.1, 27.4, '#1d252e', { stroke: '#46525f', dash: '4 3' });
  // LED PCB + LEDs on the y = 0 axis
  b += rect(-62, 27.4, 62, 29, '#2b6a4a');
  const ledX = [17, 35, 54];
  for (const sg of [-1, 1]) for (const x of ledX) b += rect(sg * x - 1.75, 29, sg * x + 1.75, 30.2, '#e8b45a', { sw: 0.5 });
  // baffle with holes at the LEDs
  const holes = []; for (const sg of [-1, 1]) for (const x of ledX) holes.push([sg * x - 2.1, sg * x + 2.1]);
  holes.sort((p, q) => p[0] - q[0]);
  let cur = -61.8; for (const [h0, h1] of holes) { b += rect(cur, 29, h0, 31, '#101215'); cur = h1; } b += rect(cur, 29, 61.8, 31, '#101215');
  // diffuser + acrylic
  b += rect(-61.8, 31, 61.8, 32, '#f2f2f2', { op: 0.55, stroke: '#cfd3d8' });
  b += rect(-62, 32, 62, 34, '#0d1824', { op: 0.9, stroke: '#3b4a5a' });
  for (let i = 0; i < 24; i++) { const x = 55.8 + i * 0.22; if (i % 8 === 0) for (const sg of [-1, 1]) b += L(X(sg * (55.8 + i * 0.2)), Z(34), X(sg * (55.8 + i * 0.2)), Z(33.4), { c: '#8ea2b6', w: 0.8 }) + '\n'; }
  // gold bezel
  b += poly([[61.2, 34], [64, 34], [66.3, 32.8], [68.3, 31], [68.3, 30.4], [69.5, 30.4], [69.5, 31.9], [67.1, 33.7], [64.8, 35.3], [61.2, 35.3]], '#b08a52', { stroke: '#2c200d' });
  // centre line
  b += L(cx, Z(-2), cx, Z(48), { c: '#46525f', dash: '10 4 2 4', w: 1 }) + '\n';

  // callouts
  const calls = [
    [1, 66.3, 33.8, 66, 40, 'r'], [2, -52, 33, -52, 42, 'l'], [3, 50, 31.5, 50, 40.5, 'r'], [4, 44, 30, 44, 45, 'r'],
    [5, -45, 28.2, -45, 48, 'l'], [6, -37, 25, -78, 18, 'l'], [7, 69.5, 26.5, 82, 26.5, 'r'], [8, -51, 25, -78, 28, 'l'],
    [9, 49, 18, 82, 16, 'r'], [10, -52, 9, -80, 9, 'l'], [11, -20, 6.5, -58, -6, 'l'], [12, 39, 6.1, 82, 6, 'r'],
    [13, -38, 15, -80, 14, 'l'], [14, 28.3, 1.5, 40, -8, 'c'], [15, -46, 11, -80, 3.5, 'l'],
  ];
  for (const [n, px, pz, lx, lz] of calls) {
    b += L(X(px), Z(pz), X(lx), Z(lz), { c: GOLD, w: 1 }) + `<circle cx="${f(X(px))}" cy="${f(Z(pz))}" r="2.5" fill="${GOLD}"/>`;
    b += `<circle cx="${f(X(lx))}" cy="${f(Z(lz))}" r="13" fill="${BG}" stroke="${GOLD}" stroke-width="1.2"/>` + T(X(lx), Z(lz) + 5, String(n), { size: 14, anchor: 'middle', fill: GOLD, weight: 500 }) + '\n';
  }
  // dimensions
  const hdim = (x0, x1, y, txt) => L(X(x0), y, X(x1), y, { c: INK }) + L(X(x0), y - 6, X(x0), y + 6, { c: INK }) + L(X(x1), y - 6, X(x1), y + 6, { c: INK }) + T((X(x0) + X(x1)) / 2, y - 8, txt, { anchor: 'middle', size: 15 }) + '\n';
  b += hdim(-69.5, 69.5, Z(0) + 130, 'Ø139') + hdim(-52, 52, Z(0) + 90, 'Ø104 plinth') + hdim(-62, 62, Z(0) + 170, 'Ø124 stack (acrylic, baffle, PCB)') + '\n';
  const vdim = (z0, z1, x, txt) => L(x, Z(z0), x, Z(z1), { c: INK }) + L(x - 6, Z(z0), x + 6, Z(z0), { c: INK }) + L(x - 6, Z(z1), x + 6, Z(z1), { c: INK }) + T(x - 10, (Z(z0) + Z(z1)) / 2 + 5, txt, { anchor: 'end', size: 15 }) + '\n';
  b += vdim(0, 3, X(-69.5) - 130, '3 feet') + vdim(3, 15, X(-69.5) - 130, '28.5 plinth') + vdim(15, 21, X(-69.5) - 130, '7.5 light band') + vdim(21, 35.3, X(-69.5) - 130, '14.3 body');
  b += vdim(0, 35.3, X(-69.5) - 250, '53.3 overall');

  // legend
  const legend = [
    ['1', 'Bezel', 'Gold: CNC aluminium, anodised (or printed + paint)'], ['2', 'Top window', '2 mm smoked acrylic, laser-etched (laser/top_window.svg)'],
    ['3', 'Diffuser sheet', '1 mm opal acrylic or frosted film'], ['4', 'LED baffle', 'Printed black, holes over every LED (stl/04)'],
    ['5', 'LED PCB', '70 addressable LEDs, positions in led_layout.csv'], ['6', 'Mic modules', '2 x INMP441, ports up to the window (blue dashes)'],
    ['7', 'Upper body', 'Printed (stl/03): grille, engraving, PCB posts'], ['8', 'PCB posts', '6 x M2, hold the LED PCB'],
    ['9', 'Light band', 'Frosted sleeve (stl/02) over a 5 mm LED strip, 7.5 tall'], ['10', 'Plinth', 'Printed (stl/01): speaker opening, board bay, USB-C slot'],
    ['11', 'Speaker', 'Dayton CE52N-4: 52 mm, 4 ohm, 5 W, 30.8 deep, faces down'], ['12', 'Controller + amp', 'XIAO ESP32-S3 + Adafruit 3006 amp, flat on 4 mm pads beside the driver'],
    ['13', 'M3 posts', '3 x posts join body to plinth (ghosted, off the cut plane)'], ['14', 'Feet', '4 x 10 mm rubber feet, 3 mm tall'],
    ['15', 'Sealed chamber', 'About 0.2 L, the plinth interior: see the speaker sheet'],
  ];
  const lx = 1790, ly = 220;
  b += T(lx, ly - 30, 'PARTS', { size: 15, fill: DIM, ls: 5 });
  legend.forEach(([n, t, d], i) => {
    const y = ly + i * 46;
    b += `<circle cx="${lx + 13}" cy="${y - 5}" r="13" fill="${BG}" stroke="${GOLD}" stroke-width="1.2"/>` + T(lx + 13, y, n, { size: 13, anchor: 'middle', fill: GOLD, weight: 500 }) + T(lx + 40, y - 5, t, { size: 16, weight: 500 }) + T(lx + 40, y + 14, d, { size: 13, fill: DIM }) + '\n';
  });

  // ---------------- exploded view ----------------
  const ex = 420, eyTop = 1030, sc = 2.0, k = 0.3, step = 80;
  b += T(80, 975, 'EXPLODED VIEW', { size: 15, fill: DIM, ls: 5 }) + '\n';
  const items = [
    [1, 'Bezel', 69.5, 5, '#a9844c', 61.2], [2, 'Smoked acrylic', 62, 3, '#0f1a27'], [3, 'Diffuser', 61.8, 2, '#e6e6e6'], [4, 'Baffle', 61.8, 3.5, '#16181b'],
    [5, 'LED PCB', 62, 3, '#2b6a4a'], [6, 'Mic modules', 41, 3, '#2b6a4a'], [7, 'Upper body', 69.5, 16, '#232d38'], [9, 'Light band', 49.6, 9, '#d9d2bd'],
    [10, 'Plinth', 52, 28.5, '#2d3844'], [14, 'Feet', 52, 3, '#101215'],
  ];
  items.forEach(([n, name, r, h, col, hole], i) => {
    const y = eyTop + i * step, R = r * sc, th = h * sc * 0.6;
    b += `<path d="M${f(ex - R)} ${f(y)} v${f(th)} A${f(R)} ${f(R * k)} 0 0 0 ${f(ex + R)} ${f(y + th)} v${f(-th)} Z" fill="${col}" stroke="#05070a" stroke-width="1"/>`;
    b += `<ellipse cx="${ex}" cy="${f(y)}" rx="${f(R)}" ry="${f(R * k)}" fill="${col}" stroke="#05070a" stroke-width="1" ${n === 2 || n === 3 ? 'fill-opacity="0.7"' : ''}/>`;
    if (hole) b += `<ellipse cx="${ex}" cy="${f(y)}" rx="${f(hole * sc)}" ry="${f(hole * sc * k)}" fill="#0b0f14"/>`;
    b += L(ex + R + 10, y + th / 2, ex + 330, y + th / 2, { c: '#46525f', dash: '2 3' }) + `<circle cx="${ex + 345}" cy="${f(y + th / 2)}" r="12" fill="${BG}" stroke="${GOLD}"/>` + T(ex + 345, y + th / 2 + 5, String(n), { size: 13, anchor: 'middle', fill: GOLD, weight: 500 }) + T(ex + 368, y + th / 2 + 5, name, { size: 15 }) + '\n';
  });
  b += L(ex, eyTop - 40, ex, eyTop + 9 * step + 70, { c: '#46525f', dash: '10 4 2 4' }) + '\n';

  // ---------------- LED map ----------------
  const mx = 1620, my = 1320, ms = 4.2;
  b += T(1330, 975, 'LED MAP: VIEW FROM ABOVE, FRONT AT THE BOTTOM', { size: 15, fill: DIM, ls: 5 }) + '\n';
  const IP = (r, a) => [mx - r * ms * Math.sin(rad(a)), my + r * ms * Math.cos(rad(a))];
  b += `<circle cx="${mx}" cy="${my}" r="${62 * ms}" fill="#0a0d11" stroke="#46525f" stroke-width="1.5"/>\n`;
  [17, 35, 54].forEach(r => b += `<circle cx="${mx}" cy="${my}" r="${r * ms}" fill="none" stroke="#2a3440" stroke-dasharray="4 4"/>`);
  const leds = [];
  for (let k2 = 0; k2 < 3; k2++) for (let i = 0; i < [12, 24, 36][k2]; i++) { const a = i * 360 / [12, 24, 36][k2]; if (k2 === 2 && Math.min(a, 360 - a) < 11.5) continue; leds.push([IP([17, 35, 54][k2], a), k2]); }
  leds.push([IP(59.5, 0), 3]);
  leds.forEach(([[x, y], kk], i) => { b += `<circle cx="${f(x)}" cy="${f(y)}" r="${kk === 3 ? 5.5 : 4.2}" fill="${kk === 3 ? '#ffd9a0' : '#e8b45a'}"/>`; });
  for (const a of [45, 135, 225, 315]) { const [x, y] = IP(44.5, a); b += `<circle cx="${f(x)}" cy="${f(y)}" r="5" fill="none" stroke="#6fb8d8" stroke-width="1.5"/>`; }
  for (let kk = 0; kk < 6; kk++) { const [x, y] = IP(59, kk * 60); b += `<circle cx="${f(x)}" cy="${f(y)}" r="4" fill="none" stroke="${INK}" stroke-width="1"/>` + L(x - 6, y, x + 6, y, { c: INK }) + L(x, y - 6, x, y + 6, { c: INK }); }
  b += T(mx, my + 62 * ms + 36, 'FRONT', { size: 15, anchor: 'middle', fill: GOLD, ls: 6 });
  b += T(mx + 62 * ms + 30, my - 40, 'Ring 1: 12 LEDs at r 17', { size: 14 }) + T(mx + 62 * ms + 30, my - 18, 'Ring 2: 24 LEDs at r 35', { size: 14 }) + T(mx + 62 * ms + 30, my + 4, 'Ring 3: 33 LEDs at r 54', { size: 14 }) + T(mx + 62 * ms + 30, my + 26, '(3 skipped at the front notch)', { size: 12, fill: DIM }) + T(mx + 62 * ms + 30, my + 56, 'Front marker LED at r 59.5', { size: 14 });
  b += `<circle cx="${mx + 62 * ms + 20}" cy="${my + 51}" r="5" fill="#ffd9a0"/>` + `<circle cx="${mx + 62 * ms + 20}" cy="${my + 100}" r="5" fill="none" stroke="#6fb8d8" stroke-width="1.5"/>` + T(mx + 62 * ms + 30, my + 105, 'Mic ports, r 44.5 at 45 / 135 / 225 / 315', { size: 14 }) + `<circle cx="${mx + 62 * ms + 20}" cy="${my + 130}" r="4" fill="none" stroke="${INK}"/>` + T(mx + 62 * ms + 30, my + 135, 'M2 PCB mounts, r 59, every 60', { size: 14 }) + T(mx + 62 * ms + 30, my + 165, '70 LEDs in chain order: 0-11, 12-35, 36-68, marker 69', { size: 13, fill: DIM }) + '\n';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><title>Jarvis Disc Mk I technical drawing</title>\n${b}</svg>\n`;
}
fs.writeFileSync(path.join(out, 'jarvis-disc-technical.svg'), technical());
console.log('wrote jarvis-disc-technical.svg');

// ============================================================================
// Wiring diagram
// ============================================================================
function wiring() {
  const W = 2000, H = 1250;
  let b = `<rect width="${W}" height="${H}" fill="${BG}"/>\n`;
  b += T(80, 90, 'JARVIS DISC  MK I', { size: 30, fill: GOLD, ls: 10 }) + T(80, 128, 'Wiring diagram: build with XIAO ESP32-S3, two I2S mics and a MAX98357A amp', { size: 17, fill: DIM, ls: 2 }) + '\n';
  const box = (x, y, w, h, title, lines = [], o = {}) => {
    let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${o.fill || '#121820'}" stroke="${o.stroke || '#3a4756'}" stroke-width="1.5"/>` + T(x + 18, y + 30, title, { size: 17, weight: 500, fill: o.tc || INK });
    lines.forEach((ln, i) => s += T(x + 18, y + 56 + i * 22, ln, { size: 14, fill: DIM }));
    return s + '\n';
  };
  const wire = (pts, c, label, lx, ly, w = 2) => `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linejoin="round"/>` + (label ? T(lx, ly, label, { size: 13, fill: c }) : '') + '\n';
  const PWR = '#e0605a', GND = '#7d8c9c', I2S = '#6fb8d8', DATA = '#e8b45a', GRN = '#6fd29a';

  // power
  b += box(80, 220, 260, 150, 'USB-C power in', ['USB-C PD sink / negotiated input', 'regulated 5 V rail sized from tests', 'do not assume 5 V / 3 A'], { stroke: PWR });
  b += box(420, 220, 220, 150, 'Protection', ['protection sized to wiring and load', 'then regulated 5 V distribution'], { stroke: PWR });
  b += wire([[340, 295], [420, 295]], PWR, '5 V', 365, 285);
  b += box(720, 150, 330, 130, 'LED supply', ['1000 uF at LED PCB input', '87 pixels: 5.22 A full-white bound', 'set cap after measured power design'], { stroke: PWR });
  b += wire([[640, 295], [680, 295], [680, 215], [720, 215]], PWR, '5 V', 650, 210);
  // controller
  b += box(720, 380, 360, 470, 'XIAO ESP32-S3', ['5V in from the rail, 3V3 out', '', 'D0  GPIO1   I2S out BCLK', 'D1  GPIO2   I2S out LRC', 'D2  GPIO3   I2S out DIN', 'D3  GPIO4   LED data (via shifter)', 'D5  GPIO6   mute-state sense only', 'D8  GPIO7   I2S in BCLK', 'D9  GPIO8   I2S in WS', 'D10 GPIO9   I2S in data', '', 'GND common to everything'], { stroke: GOLD, tc: GOLD });
  b += wire([[640, 330], [680, 330], [680, 415], [720, 415]], PWR, '5 V', 650, 325);
  // amp + speaker
  b += box(1260, 330, 330, 170, 'Adafruit 3006: MAX98357A amp', ['VIN 5 V, GND', 'BCLK, LRC, DIN from the ESP32', 'GAIN open (9 dB), SD to 3V3', 'OUT+  OUT-  to the speaker'], { stroke: I2S });
  b += box(1700, 360, 260, 110, 'Speaker: Dayton CE52N-4', ['4 ohm, 5 W, 52 mm round', 'sealed plinth, faces down'], { stroke: I2S });
  b += wire([[1080, 495], [1180, 495], [1180, 360], [1260, 360]], I2S, 'BCLK / LRC / DIN', 1100, 488);
  b += wire([[1590, 415], [1700, 415]], I2S, 'OUT+ / OUT-', 1600, 405);
  // mics
  b += box(1260, 570, 330, 190, 'Mics: 2 x INMP441 (I2S)', ['VDD 3V3, GND', 'SCK <- D8, WS <- D9', 'SD (both mics) -> D10', 'L/R: one to GND, one to 3V3', 'hardware isolation required when muted'], { stroke: I2S });
  b += wire([[1080, 710], [1260, 710]], I2S, 'SCK / WS / SD', 1110, 702);
  b += `<rect x="1260" y="800" width="670" height="70" rx="8" fill="none" stroke="#3a4756" stroke-dasharray="6 5"/>` + T(1280, 830, 'Better option: ReSpeaker XVF3800 4-mic array on XIAO ESP32-S3. It adds echo cancellation,', { size: 14, fill: DIM }) + T(1280, 852, 'so you can talk over Jarvis. Its I2S pins are fixed on the board; use its pin table instead.', { size: 14, fill: DIM }) + '\n';
  // LED chain
  b += box(720, 920, 360, 150, '74AHCT125 level shifter', ['powered from 5 V', 'in <- D3 (3.3 V), out -> 330 ohm', 'then to the LED data line'], { stroke: DATA });
  b += wire([[900, 850], [900, 920]], DATA, 'GPIO4', 910, 890);
  b += box(1260, 920, 330, 150, 'LED PCB, 70 LEDs', ['5 V, GND, DIN', 'chain order: 0-11, 12-35,', '36-68, marker 69'], { stroke: DATA });
  b += box(1700, 920, 230, 150, 'Seam strip', ['17 LEDs, 5-6 mm wide', 'DIN from the PCB DOUT'], { stroke: DATA });
  b += wire([[1080, 995], [1260, 995]], DATA, '330 ohm, data', 1100, 985);
  b += wire([[1590, 995], [1700, 995]], DATA, 'DOUT to DIN', 1600, 985);
  b += wire([[1050, 215], [1985, 215], [1985, 1100], [1425, 1100], [1425, 1070]], PWR, '5 V and GND to the LED PCB and seam strip', 1560, 205);
  // mute switch
  b += box(80, 460, 430, 190, 'Physical mic mute: latching 4PDT + aux contact', ['4 poles open mic 3V3, BCLK, WS and SD in MUTED', 'Auxiliary dry contact reports position to D5 / GPIO6', 'D5 is read-only; firmware cannot defeat isolation', 'Break-before-make switch; verify pinout and back-power'], { stroke: GRN });
  b += wire([[510, 555], [720, 555]], GRN, 'aux state only', 565, 547);
  // notes
  b += T(80, 1134, 'Every 5 V consumer (ESP32, amp, level shifter, LED PCB, seam strip) hangs off the fused 5 V rail; red lines show the main paths only.', { size: 14, fill: DIM });
  b += T(80, 1160, 'Pin numbers are for the Seeed XIAO ESP32-S3 (D0 to D10 = GPIO1, 2, 3, 4, 5, 6, 43, 44, 7, 8, 9). The I2S pins can be moved; verify against the datasheet before ordering.', { size: 14, fill: DIM });
  b += T(80, 1186, 'Keep the LED data wire short, join all grounds at one point, and never connect the 5 V rail to a 3.3 V pin (INMP441 and the ESP32 inputs are 3.3 V only).', { size: 14, fill: DIM });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><title>Jarvis Disc Mk I wiring diagram</title>\n${b}</svg>\n`;
}
fs.writeFileSync(path.join(out, 'jarvis-disc-wiring.svg'), wiring());
console.log('wrote jarvis-disc-wiring.svg');

// ============================================================================
// Speaker + chamber sheet
// ============================================================================
function speakerSheet() {
  const W = 2200, H = 1600;
  let b = `<rect width="${W}" height="${H}" fill="${BG}"/>\n`;
  b += T(80, 90, 'JARVIS DISC  MK I', { size: 30, fill: GOLD, ls: 10 }) + T(80, 128, 'Speaker and chamber: placement, sealed volume, expected response (taller plinth, Dayton CE52N-4)', { size: 17, fill: DIM, ls: 2 }) + '\n';
  b += T(W - 80, 90, 'All dimensions in mm', { size: 15, anchor: 'end', fill: DIM }) + T(W - 80, 116, 'Volumes are estimates; depth 30.8 is from the maker page, the mounting-hole pattern is not specified', { size: 15, anchor: 'end', fill: DIM }) + '\n';
  const BLUE = '#4a90c0', CH = '#1b4f75';
  // ---- numbers (true z, table = 0; plinth lifted 16.5 over the low version)
  const zS = 5, zStep = 29.5, zTop = 39;                                   // chamber floor, step to the neck, top of the neck
  const vLow = Math.PI * 4.96 ** 2 * (zStep - zS) / 10, vUp = Math.PI * 4.36 ** 2 * (zTop - zStep) / 10;   // cm3
  const ded = [['Driver body in the chamber', 25], ['Controller + amp boards', 4], ['3 posts', 5], ['Wires, foam, glue', 3]];
  const net = vLow + vUp - ded.reduce((a, d) => a + d[1], 0);
  const Fs = 164, Qts = 0.59, Vas = 0.17;   // Dayton CE52N-4 spec table, litres
  const Qtc = vb => Qts * Math.sqrt(1 + Vas / vb), Fc = vb => Fs * Math.sqrt(1 + Vas / vb);
  const f3 = vb => { const q = Qtc(vb), a = 1 / (q * q) - 2; return Fc(vb) * Math.sqrt((a + Math.sqrt(a * a + 4)) / 2); };
  const peak = q => q > Math.SQRT1_2 ? 20 * Math.log10(q * q / Math.sqrt(q * q - 0.25)) : 0;

  // ---- A: section through the centre (scale 6.5)
  const S = 6.5, cx = 640, yb = 700;
  const X = x => cx + x * S, Z = z => yb - z * S;
  const poly = (pts, fill, o = {}) => [1, -1].map(sg => `<polygon points="${pts.map(([r, z]) => `${f(X(sg * r))},${f(Z(z))}`).join(' ')}" fill="${fill}" stroke="${o.stroke || '#06080b'}" stroke-width="${o.sw || 1.2}" ${o.op ? `fill-opacity="${o.op}"` : ''} ${o.dash ? `stroke-dasharray="${o.dash}"` : ''}/>`).join('\n') + '\n';
  const rect = (x0, z0, x1, z1, fill, o = {}) => `<rect x="${f(X(x0))}" y="${f(Z(z1))}" width="${f((x1 - x0) * S)}" height="${f((z1 - z0) * S)}" fill="${fill}" stroke="${o.stroke || '#06080b'}" stroke-width="${o.sw || 1}" ${o.op ? `fill-opacity="${o.op}"` : ''} ${o.dash ? `stroke-dasharray="${o.dash}"` : ''}/>\n`;
  const sym = (x0, z0, x1, z1, fill, o = {}) => rect(x0, z0, x1, z1, fill, o) + rect(-x1, z0, -x0, z1, fill, o);
  const symR = (x0, z0, x1, z1, fill, o = {}) => rectR(x0, z0, x1, z1, fill, o) + rectR(-x1, z0, -x0, z1, fill, o);
  b += T(80, 190, 'A. SECTION THROUGH THE CENTRE: SEALED CHAMBER', { size: 15, fill: DIM, ls: 5 }) + '\n';
  b += L(X(-70), Z(0), X(70), Z(0), { c: '#46525f', w: 1.5 }) + T(X(70) - 4, Z(0) + 18, 'table', { size: 13, fill: DIM, anchor: 'end' }) + '\n';
  b += poly([[0, zS], [49.6, zS], [49.6, zStep], [43.6, zStep], [43.6, zTop], [0, zTop]], CH, { op: 0.55, stroke: BLUE });
  b += poly([[25, 3], [50, 3], [52, 5], [52, 31.5], [46, 31.5], [46, zTop], [43.6, zTop], [43.6, zStep], [49.6, zStep], [49.6, 5], [25, 5]], '#2d3844');
  b += sym(46, 32, 47.6, 38.5, '#e5a84a', { sw: 0.6 }) + sym(48.2, 31.5, 49.6, 39, '#f2efe6', { op: 0.45, stroke: '#cfc9b8' });   // light band on the neck
  b += poly([[12, zTop], [69.5, zTop], [69.5, zTop + 2], [12, zTop + 2]], '#222c37');                          // body floor (body above, not drawn)
  b += rect(-13.5, zTop - 0.5, -12, zTop + 2.4, '#d9b87c', { sw: 0.5 }) + rect(12, zTop - 0.5, 13.5, zTop + 2.4, '#d9b87c', { sw: 0.5 });   // foam plug in the cable hole
  b += rect(-26, 5, 26, 5.5, '#c9c2a8', { sw: 0.4 });
  b += rect(-26, 5.5, 26, 8.5, '#6b7380', { sw: 1.2 });
  b += rect(-19, 8.5, 19, 20, '#59616f', { sw: 1, op: 0.9 });
  b += rect(-13, 20, 13, 36.3, '#4b5260', { sw: 1.2 });
  b += rect(-22, 5.5, 22, 8.5, '#aab3bf', { sw: 0.8 });
  b += T(X(0), Z(29), 'DRIVER', { size: 15, anchor: 'middle', fill: '#e8edf2', ls: 3 }) + T(X(0), Z(25.5), 'CE52N-4', { size: 13, anchor: 'middle', fill: '#cfd6de' }) + T(X(0), Z(22.5), '52 round, 30.8 deep', { size: 12, anchor: 'middle', fill: '#cfd6de' }) + '\n';
  b += sym(24, 9, 44, 10.6, '#17261e', { stroke: '#46525f', dash: '3 3' }) + sym(31, 5, 37, 9, '#4b5663', { stroke: '#06080b', sw: 0.6 }) + '\n';
  for (const sg of [-1, 1]) {
    b += L(X(sg * 22), Z(4), X(sg * 22), Z(2), { c: '#e8b45a', w: 2 }) + L(X(sg * 22), Z(1.5), X(sg * 66), Z(1.5), { c: '#e8b45a', w: 2, dash: '8 5' }) + `<polygon points="${f(X(sg * 68))},${f(Z(1.5))} ${f(X(sg * 65))},${f(Z(2.6))} ${f(X(sg * 65))},${f(Z(0.4))}" fill="#e8b45a"/>\n`;
  }
  b += T(X(0), Z(-1.8), 'sound leaves through the 3 mm gap under the plinth', { size: 13, anchor: 'middle', fill: '#e8b45a' }) + '\n';
  b += L(cx, Z(-3), cx, Z(zTop + 5), { c: '#46525f', dash: '10 4 2 4' }) + '\n';
  const lab = (x, z, tx, tz, t1, t2) => L(X(x), Z(z), X(tx), Z(tz), { c: GOLD }) + `<circle cx="${f(X(x))}" cy="${f(Z(z))}" r="2.5" fill="${GOLD}"/>` + T(X(tx) + (tx > 0 ? 8 : -8), Z(tz) + 4, t1, { size: 15, anchor: tx > 0 ? 'start' : 'end', weight: 500 }) + T(X(tx) + (tx > 0 ? 8 : -8), Z(tz) + 22, t2, { size: 13, anchor: tx > 0 ? 'start' : 'end', fill: DIM }) + '\n';
  b += lab(47, 18, 64, 28, 'Lower chamber: ' + vLow.toFixed(0) + ' cm3', 'z 5 to 29.5, r 49.6') + lab(40, 34, 64, 46, 'Neck: ' + vUp.toFixed(1) + ' cm3', 'z 29.5 to 39, r 43.6');
  b += lab(-30, 5.2, -44, 16, 'Foam gasket 0.5 mm', 'closed cell, seals the flange') + lab(-12.7, 40, -26, 51, 'Foam plug in cable hole', 'seals the 24 mm hole in the floor') + lab(-34, 10.6, -58, 28, 'Boards on 4 mm pads', 'beside the driver, above the flange');
  b += lab(49, 35, 64, 58, 'Light band moves up', 'under the body, z 31.5 to 39');
  const hd = (x0, x1, y, t) => L(X(x0), y, X(x1), y, { c: INK }) + L(X(x0), y - 6, X(x0), y + 6, { c: INK }) + L(X(x1), y - 6, X(x1), y + 6, { c: INK }) + T((X(x0) + X(x1)) / 2, y + 22, t, { anchor: 'middle', size: 15 }) + '\n';
  b += hd(-24, 24, Z(0) + 60, 'opening 48 round (provisional)') + hd(-26, 26, Z(0) + 115, 'driver flange 52');

  // ---- B: plan view of the plinth interior
  const pcx = 1660, pcy = 560, ps = 6.5;
  const IP = (r, a) => [pcx - r * ps * Math.sin(rad(a)), pcy + r * ps * Math.cos(rad(a))];
  b += T(1280, 190, 'B. PLAN VIEW OF THE PLINTH, LID OFF (FRONT AT THE BOTTOM)', { size: 15, fill: DIM, ls: 5 }) + '\n';
  b += `<circle cx="${pcx}" cy="${pcy}" r="${f(49.6 * ps)}" fill="${CH}" fill-opacity="0.4" stroke="${BLUE}" stroke-width="2"/>\n<circle cx="${pcx}" cy="${pcy}" r="${f(43.6 * ps)}" fill="none" stroke="${BLUE}" stroke-dasharray="6 4"/>\n`;
  b += `<circle cx="${pcx}" cy="${pcy}" r="${f(23 * ps)}" fill="#0b0f14" stroke="#e8b45a" stroke-dasharray="6 4"/>\n`;
  b += `<circle cx="${pcx}" cy="${pcy}" r="${f(26 * ps)}" fill="#6b7380" fill-opacity="0.8" stroke="#aab3bf" stroke-width="1.5"/>\n<circle cx="${pcx}" cy="${pcy}" r="${f(21 * ps)}" fill="#8f98a6" stroke="#2a3038"/>\n<circle cx="${pcx}" cy="${pcy}" r="${f(13 * ps)}" fill="#4b5260"/>\n`;
  // mounting-hole pattern is not specified by manufacturer; retention not designed
  for (const a of [0, 135, 225]) { const [x, y] = IP(38, a); b += `<circle cx="${f(x)}" cy="${f(y)}" r="${4 * ps}" fill="#4b5663" stroke="#06080b"/><circle cx="${f(x)}" cy="${f(y)}" r="${1.45 * ps}" fill="#0b0f14"/>`; }
  for (const a of [45, 315, 180]) { const [x, y] = IP(34, a); b += `<rect x="${f(x - 3 * ps)}" y="${f(y - 3 * ps)}" width="${6 * ps}" height="${6 * ps}" rx="6" fill="#4b5663" stroke="#06080b"/>`; }
  for (const a of [45, 315]) {   // boards on the pads, tangent to the wall
    const [x, y] = IP(34, a), ux = -Math.sin(rad(a)), uy = Math.cos(rad(a)), tx = -uy, ty = ux, hl = 10.5 * ps, hw = 9 * ps;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => `${f(x + tx * hl * i + ux * hw * j)},${f(y + ty * hl * i + uy * hw * j)}`).join(' ');
    b += `<polygon points="${pts}" fill="#17261e" fill-opacity="0.85" stroke="#46525f" stroke-dasharray="3 3"/>`;
  }
  { const [x, y] = IP(50, 180); b += `<rect x="${f(x - 6 * ps)}" y="${f(y - 1)}" width="${12 * ps}" height="${3 * ps}" fill="#0b0f14" stroke="${GOLD}"/>` + T(x, y - 14, 'USB-C slot (seal)', { size: 13, anchor: 'middle', fill: GOLD }); }
  { const [x, y] = IP(50, 215); b += `<circle cx="${f(x)}" cy="${f(y)}" r="${3.1 * ps}" fill="#0b0f14" stroke="${GOLD}"/>` + T(x - 30, y - 6, 'mute button', { size: 13, anchor: 'end', fill: GOLD }); }
  b += T(pcx, pcy + 49.6 * ps + 34, 'FRONT', { size: 15, anchor: 'middle', fill: GOLD, ls: 6 });
  b += T(1300, 962, 'Grey disc = driver flange (52); dashed gold = Ø48 provisional opening in the plinth floor; its manufacturer drawing does not specify mounting holes.', { size: 13, fill: DIM }) + T(1300, 982, 'Dark green = controller and amp boards on 4 mm pads at r 34, just above the flange; M3 posts at r 38 merge into the neck wall.', { size: 13, fill: DIM }) + '\n';

  // ---- C: volume budget + response table
  let y0 = 1040;
  b += T(80, y0, 'C. CHAMBER VOLUME BUDGET (ESTIMATE)', { size: 15, fill: DIM, ls: 5 }) + '\n';
  const row = (y, a, c, o = {}) => T(80, y, a, { size: 15, weight: o.w }) + T(500, y, c, { size: 15, anchor: 'end', weight: o.w, fill: o.fill }) + '\n';
  b += row(y0 + 36, 'Lower chamber, z 5 to 29.5', vLow.toFixed(1) + ' cm3') + row(y0 + 62, 'Neck, z 29.5 to 39', vUp.toFixed(1) + ' cm3') + row(y0 + 88, 'Gross', (vLow + vUp).toFixed(1) + ' cm3', { w: 500 });
  ded.forEach((d, i) => b += row(y0 + 118 + i * 24, '  minus ' + d[0].toLowerCase(), '-' + d[1].toFixed(0) + ' cm3'));
  b += L(80, y0 + 218, 500, y0 + 218, { c: INK }) + row(y0 + 244, 'Net sealed volume (about)', net.toFixed(0) + ' cm3 = ' + (net / 1000).toFixed(2) + ' L', { w: 500, fill: GOLD }) + '\n';
  b += T(80, y0 + 272, 'The cone breathes into the 3 mm gap under the plinth, the back into this chamber.', { size: 13, fill: DIM }) + '\n';

  const tx = 640;
  b += T(tx, y0, 'SEALED-BOX BEHAVIOUR', { size: 15, fill: DIM, ls: 5 }) + T(tx + 290, y0, 'Fs 164, Qts 0.59, Vas 0.17 L (Dayton spec table)', { size: 13, fill: DIM }) + '\n';
  const cols = [tx, tx + 110, tx + 200, tx + 310, tx + 410, tx + 520];
  ['Chamber', 'Qtc', 'Fc', '-3 dB at', 'Peak'].forEach((h, i) => b += T(cols[i], y0 + 36, h, { size: 14, fill: DIM }));
  const vbs = [[net / 1000, 'this plinth'], [0.15, ''], [0.097, 'the old low plinth'], [0.5, 'not possible here']];
  vbs.forEach(([vb, note], i) => { const y = y0 + 66 + i * 28, hl = i === 0 ? GOLD : INK, q = Qtc(vb); b += T(cols[0], y, vb.toFixed(3) + ' L', { size: 15, fill: hl, weight: i === 0 ? 500 : 0 }) + T(cols[1], y, q.toFixed(2), { size: 15, fill: hl }) + T(cols[2], y, Fc(vb).toFixed(0) + ' Hz', { size: 15, fill: hl }) + T(cols[3], y, f3(vb).toFixed(0) + ' Hz', { size: 15, fill: hl }) + T(cols[4], y, peak(q) > 0 ? '+' + peak(q).toFixed(1) + ' dB' : 'none', { size: 15, fill: hl }) + T(cols[5], y, note, { size: 13, fill: DIM }); });
  b += T(tx, y0 + 192, 'Qtc 0.7 is flat. This driver gives about ' + Qtc(net / 1000).toFixed(2) + ' here: a tiny bump, no EQ needed.', { size: 13, fill: DIM }) + T(tx, y0 + 212, 'Expect a clean desk speaker down to about ' + (Math.round(f3(net / 1000) / 10) * 10) + ' Hz: still not a bass speaker.', { size: 13, fill: DIM }) + T(tx, y0 + 232, 'Xmax is only 0.85 mm: high-pass at 150 Hz in firmware and keep the volume moderate.', { size: 13, fill: DIM }) + '\n';

  // ---- D: speaker + notes
  const dx = 1280;
  b += T(dx, y0, 'D. SPEAKER CHOICE: DAYTON AUDIO CE52N-4 (4 OHM)', { size: 15, fill: DIM, ls: 5 }) + '\n';
  const spec = ['2 inch dual-neodymium full range, 4 ohm, 5 W RMS (10 W max), about US$8', 'Sensitivity 85 dB (2.83 V, 1 m), Re 3.3 ohm, 120 Hz to 20 kHz as rated', 'Sd 12.6 cm2, Xmax 0.85 mm, Mms 1.3 g, BL 2.5 Tm', 'Fs 164 Hz, Qts 0.59, Vas 0.17 L: gives Qtc 0.8 in this chamber', 'Frame 52 mm, baffle cutout 47.5 mm, overall depth 30.8 mm'];
  spec.forEach((t, i) => b += T(dx, y0 + 34 + i * 24, t, { size: 14 }));
  b += T(dx, y0 + 170, 'CHECK BEFORE ORDERING', { size: 14, fill: GOLD, ls: 3 }) + '\n';
  ['Mounting hole pattern and flange thickness are not on the maker page: open the spec sheet drawing.', 'Depth 30.8 leaves 2.7 mm under the neck top; the lift could drop to 15 if you want it shorter.', 'Parts Express may be out of stock; Sound Imports (EU) lists it. Buy 2 to 3, they are cheap.', 'Check the cone moves freely before gluing the gasket: it only has 0.85 mm of travel.'].forEach((t, i) => b += T(dx, y0 + 196 + i * 22, t, { size: 13, fill: DIM }));
  b += T(dx, y0 + 296, 'SEAL EVERYTHING, THE BOX MUST BE AIRTIGHT', { size: 14, fill: GOLD, ls: 3 }) + '\n';
  ['Cable hole in the body floor: foam plug or grommet around the wires', 'Body-to-neck joint: 1 mm closed-cell foam ring or a bead of silicone', 'USB-C slot and mute-button hole: silicone or hot glue around the part', 'Driver flange: 0.5 mm foam gasket; retention design and fastener count are not yet validated'].forEach((t, i) => b += T(dx, y0 + 322 + i * 22, t, { size: 13, fill: DIM }));
  b += T(80, H - 60, 'Slit under the plinth: 327 mm x 3 mm = about 980 mm2 against a 1260 mm2 cone: close enough. Feet of 4 mm (+1 mm overall) would match it.', { size: 13, fill: DIM }) + '\n';
  b += T(80, H - 36, 'jarvis_disc.scad is updated (lift 16.5, round 48 opening (provisional), 4 mm board pads) but the STL files are not re-exported: OpenSCAD is not installed on this machine.', { size: 13, fill: DIM });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><title>Jarvis Disc Mk I speaker and chamber</title>\n${b}</svg>\n`;
}
fs.writeFileSync(path.join(out, 'jarvis-disc-speaker.svg'), speakerSheet());
console.log('wrote jarvis-disc-speaker.svg');
