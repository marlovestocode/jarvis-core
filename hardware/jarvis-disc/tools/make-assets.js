// Generates led_layout.csv (for the LED PCB) and laser/top_window.svg (for the smoked acrylic top).
// Run: node tools/make-assets.js   (from hardware/jarvis-disc)
// Same numbers as jarvis_disc.scad. Front of the device is +Y in CAD; both files below are
// drawn as seen from above with the front at the BOTTOM of the page.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const RING_R = [17, 35, 54], RING_N = [12, 24, 36];
const MARKER_R = 59.5, MIC_R = 44.5, POST_R = 59, R_ACRYLIC = 62;
const rad = d => d * Math.PI / 180;
const cad = (r, a) => [r * Math.sin(rad(a)), r * Math.cos(rad(a))];      // CAD x, y (front = +Y)
const img = (r, a) => [-r * Math.sin(rad(a)), r * Math.cos(rad(a))];      // page x, y as seen from above, front at bottom
const f = n => (Math.round(n * 1000) / 1000).toString();

// ---- LED list in data-chain order ---------------------------------------------------
const leds = [];
for (let k = 0; k < 3; k++) {
  for (let i = 0; i < RING_N[k]; i++) {
    const a = i * 360 / RING_N[k];
    if (k === 2 && Math.min(a, 360 - a) < 11.5) continue;                 // notch beside the front marker
    leds.push({ ring: k, a, r: RING_R[k] });
  }
}
leds.push({ ring: 'marker', a: 0, r: MARKER_R });
const rows = ['index,ring,radius_mm,angle_from_front_deg,x_mm,y_mm'];
leds.forEach((l, i) => {
  const [x, y] = cad(l.r, l.a);
  rows.push([i, l.ring, l.r, f(l.a), f(x), f(y)].join(','));
});
const extra = ['', '# non-LED features on the PCB (same x/y convention, front = +Y)',
  'feature,radius_mm,angle_from_front_deg,x_mm,y_mm'];
for (let k = 0; k < 6; k++) { const [x, y] = cad(POST_R, k * 60); extra.push(['mount_hole_M2', POST_R, k * 60, f(x), f(y)].join(',')); }
for (const a of [45, 135, 225, 315]) { const [x, y] = cad(MIC_R, a); extra.push(['mic_port_clearance', MIC_R, a, f(x), f(y)].join(',')); }
fs.writeFileSync(path.join(root, 'led_layout.csv'), rows.concat(extra).join('\n') + '\n');
console.log('LEDs on top PCB:', leds.length);

// ---- laser SVG (mm) -----------------------------------------------------------------
const W = 150, C = W / 2;
const P = (r, a) => { const [x, y] = img(r, a); return [C + x, C + y]; };
let s = '';
const cut = 'fill="none" stroke="#ff0000" stroke-width="0.1"';
const eng = 'fill="none" stroke="#0000ff" stroke-width="0.1"';
s += `<circle cx="${C}" cy="${C}" r="${R_ACRYLIC}" ${cut}/>\n`;
for (const a of [45, 135, 225, 315]) { const [x, y] = P(MIC_R, a); s += `<circle cx="${f(x)}" cy="${f(y)}" r="0.75" ${cut}/>\n`; }
// tick scale: 120 ticks, longer every tenth; skip the ones over the front marker LED
for (let i = 0; i < 120; i++) {
  const a = i * 3, off = Math.min(a, 360 - a);
  if (off < 4) continue;
  const r0 = i % 10 === 0 ? 0.9 * R_ACRYLIC : 0.935 * R_ACRYLIC, r1 = 0.985 * R_ACRYLIC;
  const [x0, y0] = P(r0, a), [x1, y1] = P(r1, a);
  s += `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" ${eng}/>\n`;
}
// broken hairline arcs, placed away from the mic ports
const arc = (r, a0, a1) => {
  const [x0, y0] = P(r, a0), [x1, y1] = P(r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `<path d="M${f(x0)} ${f(y0)} A${r} ${r} 0 ${large} 0 ${f(x1)} ${f(y1)}" ${eng}/>\n`;
};
for (const [r, list] of [[26, [[15, 75], [100, 130], [200, 300]]], [44.6, [[60, 120], [150, 205], [250, 300]]]])
  for (const [a0, a1] of list) s += arc(r, a0, a1);
// room name, centred, readable from the front
s += `<text x="${C}" y="${C + 1.6}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="300" font-size="3" letter-spacing="0.8" fill="none" stroke="#0000ff" stroke-width="0.1">ROOM NAME</text>\n`;
// registration cross outside the part
s += `<path d="M${C - 3} 6 H${C + 3} M${C} 3 V9" ${eng}/>\n`;
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Jarvis Disc Mk I: smoked acrylic top window, 2 mm. Red = cut, blue = engrave (surface scan).
     View is from above, front of the device at the bottom. For a second-surface engrave from
     the underside, mirror the file. Replace ROOM NAME, and convert text to outlines in your laser software. -->
<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${W}mm" viewBox="0 0 ${W} ${W}">
${s}</svg>
`;
fs.mkdirSync(path.join(root, 'laser'), { recursive: true });
fs.writeFileSync(path.join(root, 'laser', 'top_window.svg'), svg);
console.log('wrote led_layout.csv and laser/top_window.svg');
