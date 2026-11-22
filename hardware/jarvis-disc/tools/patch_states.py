# One-off: makes the hero illustration render in all five states (speaking, listening, thinking, idle, muted).
import os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
p = 'tools/make-drawings.js'
s = open(p, encoding='utf8').read()

def rep(old, new):
    global s
    assert old in s, old[:80]
    s = s.replace(old, new)

rep("function hero() {\n  const W = 1800,", """function hero(state = 'speaking') {
  const PAL = { speaking: [255, 179, 71], listening: [112, 214, 255], thinking: [176, 156, 255], idle: [255, 200, 130], muted: [255, 78, 62] };
  const C = PAL[state];
  const mix = (c, t, a) => c.map((v, i) => Math.round(v + (t[i] - v) * a));
  const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
  const cMain = hex(C), cHi = hex(mix(C, [255, 255, 255], 0.7)), cDark = hex(mix(C, [0, 0, 0], 0.62)), cMid = hex(mix(C, [0, 0, 0], 0.2)), cLight = hex(mix(C, [255, 255, 255], 0.5));
  const floorA = { speaking: 0.42, listening: 0.34, thinking: 0.3, idle: 0.14, muted: 0.1 }[state];
  const sleeveA = { speaking: 0.85, listening: 0.7, thinking: 0.6, idle: 0.35, muted: 0.3 }[state];
  const W = 1800,""")
rep("grad('gGlow', [[0, '#5c3a0c'], [0.2, '#c98a30'], [0.5, '#ffd9a0'], [0.8, '#c98a30'], [1, '#5c3a0c']]);",
    "grad('gGlow', [[0, cDark], [0.2, cMid], [0.5, cLight], [0.8, cMid], [1, cDark]]);")
rep('<stop offset="0" stop-color="#ffb347" stop-opacity="0.42"/><stop offset="0.45" stop-color="#ffb347" stop-opacity="0.12"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/>',
    '<stop offset="0" stop-color="${cMain}" stop-opacity="${floorA}"/><stop offset="0.45" stop-color="${cMain}" stop-opacity="${f(floorA * 0.3)}"/><stop offset="1" stop-color="${cMain}" stop-opacity="0"/>')
rep("""<g filter="url(#blurL)" opacity="0.8">${frustum(49.6, 15, 49.6, 21, '#ffa94a')}</g>""",
    """<g filter="url(#blurL)" opacity="${sleeveA}">${frustum(49.6, 15, 49.6, 21, cMain)}</g>""")
i0 = s.index("  // LEDs: a speaking-state frame")
i1 = s.index("  body += LEDG.join('\\n') + '\\n';")
new_leds = """  // LEDs: one frame per state (the same effects the firmware would draw)
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
"""
s = s[:i0] + new_leds + s[i1:]
rep("gold bezel  ·  speaking state shown", "gold bezel  ·  ${state} state shown")
rep("fs.writeFileSync(path.join(out, 'jarvis-disc-illustration.svg'), hero());\nconsole.log('wrote jarvis-disc-illustration.svg');",
    """fs.writeFileSync(path.join(out, 'jarvis-disc-illustration.svg'), hero('speaking'));
for (const st of ['idle', 'listening', 'thinking', 'speaking', 'muted'])
  fs.writeFileSync(path.join(out, `jarvis-disc-illustration-${st}.svg`), hero(st));
console.log('wrote jarvis-disc-illustration.svg and 5 state variants');""")
open(p, 'w', encoding='utf8').write(s)
print('ok')
