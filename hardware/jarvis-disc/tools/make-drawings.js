// Generates the 2D drawings in drawings/*.svg from the same dimensions as jarvis_disc.scad.
// Run: node tools/make-drawings.js   (from hardware/jarvis-disc)
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, '..', 'drawings');
fs.mkdirSync(out, { recursive: true });

const rad = d => d * Math.PI / 180;
const f = n => Math.round(n * 100) / 100;
const FONT = `'Helvetica Neue', Helvetica, Arial, sans-serif`;
const RING_R = [17, 35, 54], RING_N = [12, 24, 36];

// LED list (same rules as the CAD file): ring, angle from front (deg), radius
const LEDS = [];
for (let k = 0; k < 3; k++) for (let i = 0; i < RING_N[k]; i++) {
  const a = i * 360 / RING_N[k];
  if (k === 2 && Math.min(a, 360 - a) < 11.5) continue;
  LEDS.push({ k, a, r: RING_R[k] });
}
LEDS.push({ k: 3, a: 0, r: 59.5 });

// ============================================================================
// 1. Hero illustration: three-quarter view, speaking state
// ============================================================================
function hero(state = 'speaking') {
  const PAL = { speaking: [255, 179, 71], listening: [112, 214, 255], thinking: [176, 156, 255], idle: [255, 200, 130], muted: [255, 78, 62] };
  const C = PAL[state];
  const mix = (c, t, a) => c.map((v, i) => Math.round(v + (t[i] - v) * a));
  const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
  const cMain = hex(C), cHi = hex(mix(C, [255, 255, 255], 0.7)), cDark = hex(mix(C, [0, 0, 0], 0.62)), cMid = hex(mix(C, [0, 0, 0], 0.2)), cLight = hex(mix(C, [255, 255, 255], 0.5));
  const floorA = { speaking: 0.42, listening: 0.34, thinking: 0.3, idle: 0.14, muted: 0.1 }[state];
  const sleeveA = { speaking: 0.85, listening: 0.7, thinking: 0.6, idle: 0.35, muted: 0.3 }[state];
  const W = 1800, H = 1100, s = 7.0, k = 0.42, zc = 0.906, cx = 900, yb = 860, DZ = 16.5;   // DZ: the plinth is 16.5 taller (32 mm deep driver)
  const Y = z => yb - (z >= 21 ? z + 1.5 + DZ : z >= 13 ? z + DZ : z) * s * zc;   // the neck is 1.5 taller above z 21
  let defs = '', body = '';
  const grad = (id, stops, vertical = false) => {
    defs += `<linearGradient id="${id}" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>\n`;
  };
  grad('gSteel', [[0, '#06080b'], [0.16, '#161d26'], [0.34, '#2c3744'], [0.52, '#1a222c'], [0.8, '#0c1117'], [1, '#05070a']]);
  grad('gBody', [[0, '#07090c'], [0.15, '#18202a'], [0.33, '#323f4d'], [0.5, '#1d2631'], [0.78, '#0e141a'], [1, '#06080b']]);
  grad('gGold', [[0, '#3a2a12'], [0.18, '#8a6a38'], [0.36, '#e3c58e'], [0.5, '#b08a52'], [0.8, '#5e4724'], [1, '#2c200d']]);
  grad('gGoldTop', [[0, '#7a5d30'], [0.35, '#e8cc98'], [0.6, '#a98448'], [1, '#5a4222']], false);
  grad('gGlow', [[0, cDark], [0.2, cMid], [0.5, cLight], [0.8, cMid], [1, cDark]]);
  defs += `<radialGradient id="gFloor" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${cMain}" stop-opacity="${floorA}"/><stop offset="0.45" stop-color="${cMain}" stop-opacity="${f(floorA * 0.3)}"/><stop offset="1" stop-color="${cMain}" stop-opacity="0"/></radialGradient>
<radialGradient id="gBg" cx="0.5" cy="0.58" r="0.75"><stop offset="0" stop-color="#121821"/><stop offset="1" stop-color="#05070a"/></radialGradient>
<linearGradient id="gGlass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0d1218"/><stop offset="0.55" stop-color="#05080b"/><stop offset="1" stop-color="#090d12"/></linearGradient>
<filter id="blurL" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="16"/></filter>
<filter id="blurS" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="5"/></filter>
<filter id="blurXS" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2"/></filter>\n`;
  const ell = (r, z, fill, extra = '') => `<ellipse cx="${cx}" cy="${f(Y(z))}" rx="${f(r * s)}" ry="${f(r * s * k)}" fill="${fill}" ${extra}/>`;
  const frustum = (rA, zA, rB, zB, fill, extra = '') => {
    const a = rA * s, b = rB * s, yA = Y(zA), yB = Y(zB);
    return `<path d="M${f(cx - a)} ${f(yA)} A${f(a)} ${f(a * k)} 0 0 0 ${f(cx + a)} ${f(yA)} L${f(cx + b)} ${f(yB)} A${f(b)} ${f(b * k)} 0 0 0 ${f(cx - b)} ${f(yB)} Z" fill="${fill}" ${extra}/>`;
  };
  body += `<rect width="${W}" height="${H}" fill="url(#gBg)"/>\n`;
  body += `<ellipse cx="${cx}" cy="${f(Y(0))}" rx="${f(112 * s)}" ry="${f(112 * s * k)}" fill="url(#gFloor)"/>\n`;
  body += `<ellipse cx="${cx}" cy="${f(Y(0) + 6)}" rx="${f(56 * s)}" ry="${f(56 * s * k)}" fill="#000" opacity="0.55" filter="url(#blurS)"/>\n`;
  // plinth
  body += frustum(50, 3, 52, 5, 'url(#gSteel)') + '\n' + frustum(52, 5, 52, 15, 'url(#gSteel)') + '\n';
  body += `<path d="M${f(cx - 52 * s)} ${f(Y(14.2))} A${f(52 * s)} ${f(52 * s * k)} 0 0 0 ${f(cx + 52 * s)} ${f(Y(14.2))}" fill="none" stroke="#3b4857" stroke-width="1.2" opacity="0.8"/>\n`;
  body += ell(46, 15, '#0b0f14') + '\n';
  // lit sleeve (glow behind first)
  body += `<g filter="url(#blurL)" opacity="${sleeveA}">${frustum(49.6, 15, 49.6, 21, cMain)}</g>\n`;
  body += frustum(49.6, 15, 49.6, 21, 'url(#gGlow)') + '\n';
  // body: lower chamfer, wall
  body += frustum(67.5, 21, 69.5, 23, 'url(#gBody)') + '\n' + frustum(69.5, 23, 69.5, 30.4, 'url(#gBody)') + '\n';
  body += `<path d="M${f(cx - 67.5 * s)} ${f(Y(21))} A${f(67.5 * s)} ${f(67.5 * s * k)} 0 0 0 ${f(cx + 67.5 * s)} ${f(Y(21))}" fill="none" stroke="#000" stroke-width="3" opacity="0.5"/>\n`;
  // grille slots and nameplate on the front half
  const rB = 69.5;
  const pt = (a, z) => [cx - rB * s * Math.sin(rad(a)), Y(z) + rB * s * k * Math.cos(rad(a))];
  for (let a = -86; a <= 86; a += 3.6) {
    if (a > -34 && a < 36) continue;
    const [x, y0] = pt(a, 29.5), [, y1] = pt(a, 24);
    body += `<line x1="${f(x)}" y1="${f(y0)}" x2="${f(x)}" y2="${f(y1)}" stroke="#04060a" stroke-width="${f(Math.max(1.1, 1.7 * Math.cos(rad(a))))}"/>\n`;
  }
  const letters = (txt, size, aC, z, pitch, fill, weight) => {
    let g = '';
    [...txt].forEach((c, i) => {
      if (c === ' ') return;
      const a = aC - (i - (txt.length - 1) / 2) * (pitch / rB * 180 / Math.PI);
      const [x, y] = pt(a, z);
      g += `<text transform="translate(${f(x)} ${f(y)}) scale(${f(Math.cos(rad(a)))} 1)" text-anchor="middle" font-family="${FONT}" font-weight="${weight}" font-size="${f(size * s)}" fill="${fill}">${c}</text>`;
    });
    return g + '\n';
  };
  body += letters('JARVIS', 4.7, 16, 26.3, 5.2, '#b9c6d3', 500);
  body += letters('NODE 001', 1.9, 16, 23.8, 2.4, '#5b6c7e', 400);
  body += letters('MK I', 4.7, -21, 26.3, 4.6, '#e0c08a', 500);
  const blade = [[-21 + 7, 24.6], [-21 + 5.6, 25.1], [-21 - 5.6, 25.1], [-21 - 7, 24.6], [-21 - 5.6, 24.1], [-21 + 5.6, 24.1]].map(([a, z]) => pt(a, z).map(f).join(' ')).join(' L');
  body += `<path d="M${blade} Z" fill="#8a6c3c" stroke="#b08a52" stroke-width="0.8"/>\n`;
  // gold bezel
  body += frustum(69.5, 30.4, 69.5, 31.9, 'url(#gGold)') + '\n' + frustum(69.5, 31.9, 64.8, 35.3, 'url(#gGold)') + '\n';
  // glass window sits 1.3 mm below the bezel top
  body += ell(62, 34, 'url(#gGlass)') + '\n';
  const topC = Y(34), P = (r, a) => [cx - r * s * Math.sin(rad(a)), topC + r * s * k * Math.cos(rad(a))];
  // etched tick scale and hairline arcs
  for (let i = 0; i < 120; i++) {
    const a = i * 3;
    if (Math.min(a, 360 - a) < 4) continue;
    const r0 = (i % 10 === 0 ? 0.9 : 0.935) * 62, [x0, y0] = P(r0, a), [x1, y1] = P(0.985 * 62, a);
    body += `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" stroke="#a8b8c8" stroke-opacity="${i % 10 === 0 ? 0.42 : 0.2}" stroke-width="${i % 10 === 0 ? 1.6 : 1}"/>\n`;
  }
  for (const [r, list] of [[26, [[15, 75], [100, 130], [200, 300]]], [44.6, [[60, 120], [150, 205], [250, 300]]]])
    for (const [a0, a1] of list) {
      const pts = [];
      for (let a = a0; a <= a1; a += 4) pts.push(P(r, a).map(f).join(' '));
      body += `<path d="M${pts.join(' L')}" fill="none" stroke="#a8b8c8" stroke-opacity="0.26" stroke-width="1.1"/>\n`;
    }
  body += `<text transform="translate(${cx} ${f(topC + 1.6 * s * k)}) scale(1 ${k})" text-anchor="middle" font-family="${FONT}" font-weight="300" font-size="${f(3 * s)}" letter-spacing="${f(0.8 * s)}" fill="#c9a874" fill-opacity="0.5">ROOM NAME</text>\n`;
  // LEDs: one frame per state (the same effects the firmware would draw)
  const hash = (a, k) => { const v = Math.sin(a * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); };
  const circ = (a, c, w) => { const d = Math.abs(((a - c + 540) % 360) - 180); return Math.exp(-(d * d) / (2 * w * w)); };
  const th = [0, 0.34, 0.67];
  const level = (a) => Math.min(1, 0.15 + 0.85 * Math.abs(Math.sin(rad(a) * 3 + 1) * Math.sin(rad(a) * 1.3 + 0.4)));
  const ledI = l => {
    if (l.k === 3) return { speaking: 0.55, listening: 0.5, thinking: 0.35, idle: 0.25, muted: 0.95 }[state];
    if (state === 'speaking') {
      const wave = 0.5 + 0.5 * Math.sin(rad(l.a) * 2 + l.k * 1.3);
      return Math.min(1, [0.95, 0.7, 0.42][l.k] * (0.55 + 0.6 * wave));
    }
    if (state === 'idle') return l.k === 2 ? 0.07 + 0.55 * circ(l.a, 40, 9) : 0;
    if (state === 'listening') {
      const L = level(l.a);
      return Math.min(1, (l.k === 0 ? 0.1 : 0.03) + 0.95 * Math.max(0, Math.min(1, (L - th[l.k]) / 0.3)));
    }
    if (state === 'thinking') {
      let I = hash(l.a, l.k) > 0.82 ? 0.95 : 0.07;
      if (l.k === 1) I = Math.max(I, 0.95 * circ(l.a, 120, 16));
      if (l.k === 2) I = Math.max(I, 0.8 * circ(l.a, 280, 22));
      if (l.k === 0) I = Math.max(I, 0.2);
      return I;
    }
    return l.k === 2 ? 0.1 : 0;   // muted
  };
  const LEDG = [];
  for (const l of LEDS) {
    const I = ledI(l);
    const [x, y] = P(l.r, l.a);
    const spark = state === 'thinking' && l.k !== 3 && hash(l.a, l.k) > 0.82;
    LEDG.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(2.7 * s * 0.9)}" fill="${spark ? '#bfe3ff' : cMain}" opacity="${f(I * 0.55)}" filter="url(#blurS)"/>`);
    LEDG.push(`<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(0.9 * s)}" ry="${f(0.9 * s * 0.8)}" fill="${spark ? '#eaf6ff' : cHi}" opacity="${f(0.13 + 0.87 * I)}"/>`);
  }
  body += LEDG.join('\n') + '\n';
  // bezel top ring (hole r 61.2) drawn after the glass so the lip covers the glass edge
  const oR = 64.8 * s, iR = 61.2 * s, zT = Y(35.3);
  body += `<path fill-rule="evenodd" fill="url(#gGoldTop)" d="M${f(cx - oR)} ${f(zT)} A${f(oR)} ${f(oR * k)} 0 1 0 ${f(cx + oR)} ${f(zT)} A${f(oR)} ${f(oR * k)} 0 1 0 ${f(cx - oR)} ${f(zT)} Z M${f(cx - iR)} ${f(zT)} A${f(iR)} ${f(iR * k)} 0 1 1 ${f(cx + iR)} ${f(zT)} A${f(iR)} ${f(iR * k)} 0 1 1 ${f(cx - iR)} ${f(zT)} Z"/>\n`;
  body += `<ellipse cx="${cx}" cy="${f(zT)}" rx="${f(iR)}" ry="${f(iR * k)}" fill="none" stroke="#2a1f0e" stroke-width="1.5" opacity="0.7"/>\n`;
  // captions
  body += `<g font-family="${FONT}" fill="#d4dde6">
<text x="90" y="120" font-size="22" letter-spacing="9" fill="#e0c08a">JARVIS DISC</text>
<text x="90" y="160" font-size="15" letter-spacing="4" fill="#6f8093">MK I  ·  VOICE NODE</text>
<text x="90" y="1010" font-size="14" letter-spacing="2" fill="#566779">Ø139 × 53.3 mm  ·  70 addressable LEDs  ·  smoked acrylic top  ·  gold bezel  ·  ${state} state shown</text></g>\n`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<title>Jarvis Disc Mk I illustration</title><defs>
${defs}</defs>
${body}</svg>
`;
}
fs.writeFileSync(path.join(out, 'jarvis-disc-illustration.svg'), hero('speaking'));
for (const st of ['idle', 'listening', 'thinking', 'speaking', 'muted'])
  fs.writeFileSync(path.join(out, `jarvis-disc-illustration-${st}.svg`), hero(st));
console.log('wrote jarvis-disc-illustration.svg and 5 state variants');
