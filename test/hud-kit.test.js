const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UI = path.join(__dirname, '../src/ui');
const css = fs.readFileSync(path.join(UI, 'hud.css'), 'utf8');
const js = fs.readFileSync(path.join(UI, 'hud.js'), 'utf8');

test('hud.css defines the shared classes, motion tokens and a reduced-motion block', () => {
  for (const c of ['.hud-panel', '.hud-readout', '.hud-ring', '.hud-switch', '.hud-seg', '.hud-chip', '.hud-reveal', '.hud-pulse']) assert.ok(css.includes(c), c);
  for (const v of ['--ease', '--t-fast', '--t-mid', '--t-slow']) assert.ok(css.includes(v), v);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('hud.css has no inline-style hazards: no @import or url() to outside hosts', () => {
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/);
});

function load() {
  const made = [];
  const mk = tag => { const e = { tag, attrs: {}, children: [], style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute(k, v) { this.attrs[k] = String(v); }, append(...c) { this.children.push(...c); }, set textContent(v) { this._t = v; }, get textContent() { return this._t; } }; made.push(e); return e; };
  const window = { matchMedia: () => ({ matches: false }), requestAnimationFrame: f => setTimeout(() => f(Date.now()), 0) };
  const sandbox = { window, document: { createElementNS: (_n, t) => mk(t) }, matchMedia: window.matchMedia, requestAnimationFrame: window.requestAnimationFrame, module: { exports: {} } };
  vm.runInNewContext(js, sandbox);
  return { HUD: window.HUD, made };
}

test('hud.js exposes HUD with countUp, reveal, ring, spark, reduced', () => {
  const { HUD } = load();
  for (const k of ['countUp', 'reveal', 'ring', 'spark']) assert.strictEqual(typeof HUD[k], 'function', k);
  assert.strictEqual(typeof HUD.reduced, 'boolean');
});

test('spark and ring never emit NaN for empty, single, null-holed or flat data', () => {
  const { HUD } = load();
  for (const data of [[], [5], [null, null], [1, null, 3], [2, 2, 2]]) {
    const svg = HUD.spark(data, { w: 100, h: 20 });
    const all = JSON.stringify(svg, (_k, v) => (typeof v === 'function' ? undefined : v));
    assert.doesNotMatch(all, /NaN|Infinity/, JSON.stringify(data));
  }
  for (const v of [null, undefined, -5, 0, 50, 100, 140, NaN]) {
    const all = JSON.stringify(HUD.ring(v, { size: 44 }), (_k, x) => (typeof x === 'function' ? undefined : x));
    assert.doesNotMatch(all, /NaN|Infinity/, String(v));
  }
});

test('live links: settings health goes preload → ipc → serviceHealth, analytics reads only the public stream', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('src/main/preload.js'), /health:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('settings:health'\)/);
  assert.match(read('src/main/ipc.js'), /h\('settings:health',\s*\(\)\s*=>\s*ctx\.serviceHealth\?\.\(\)\s*\?\?\s*\{\}\)/);
  assert.match(read('src/main/main.js'), /ctx\.serviceHealth\s*=\s*serviceHealth/);
  const dash = read('src/ui/dashboard/dashboard.js');
  assert.match(dash, /new EventSource\('\/ai\/stream'\)/);
  assert.doesNotMatch(dash, /innerHTML/, 'stream data is only ever set as text');
});
