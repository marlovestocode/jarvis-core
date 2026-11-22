'use strict';
// What a routine is about to change, read before the run, and the way back. Only the state the steps touch is read.
// Snapshot: { at, volume?, output?, focus?, brightness?, powerPlanId?, nightLight?, bluetooth?, apps? }; a key whose
// read failed holds null. Keys are stored in the order the steps first touch them; undo restores in reverse.
const WEEK_MS = 7 * 864e5;

const KEY_OF = {
  set_system_volume: 'volume', audio_output_set: 'output', focus_assist: 'focus', brightness_set: 'brightness',
  power_plan_set: 'powerPlanId', night_light: 'nightLight', bluetooth_set: 'bluetooth', routine_close: 'apps',
};
const WORDS = { volume: 'volume', output: 'sound output', focus: 'focus assist', brightness: 'brightness', powerPlanId: 'power plan', nightLight: 'night light', bluetooth: 'Bluetooth' };
const onOff = v => (v ? 'on' : 'off');
const why = err => String(err?.message || err);

async function takeSnapshot({ host, media, steps, isOpen, now = Date.now }) {
  const snap = { at: now() };
  const read = {
    volume: async () => { const v = (await media.state())?.system?.volume; return Number.isFinite(v) ? Math.round(v * 100) : null; },
    output: async () => { const d = (await host.audioDevices()).find(x => x.default); return d ? { id: d.id, name: d.name } : null; },
    focus: async () => { const v = await host.focusAssist(); return typeof v === 'boolean' ? v : null; },
    brightness: async () => { const v = await host.brightness(); return Number.isFinite(v) ? v : null; },
    powerPlanId: async () => (await host.powerPlans()).find(p => p.active)?.id ?? null,
    nightLight: async () => { const v = await host.nightLight(); return typeof v === 'boolean' ? v : null; },
    bluetooth: async () => { const v = await host.bluetooth(); return typeof v?.enabled === 'boolean' ? v.enabled : null; },
  };
  for (const s of steps) {
    const key = KEY_OF[s.tool];
    if (!key || key === 'apps') continue;
    if (key in snap) continue;
    try { snap[key] = await read[key](); } catch { snap[key] = null; }
  }
  const names = [];
  for (const s of steps) {
    if (s.tool !== 'routine_close' || !s.args?.name) continue;
    let open = false;
    try { open = !!(await isOpen(s.args.name)); } catch { /* unknown: leave it out */ }
    if (open && !names.includes(s.args.name)) names.push(s.args.name);
  }
  if (names.length) snap.apps = names.map(name => ({ name }));
  return snap;
}

async function undoSnapshot({ host, media, openApp, snapshot, now = Date.now }) {
  if (!snapshot || typeof snapshot !== 'object') return { ok: false, lines: ['There is nothing to undo.'] };
  if (now() - snapshot.at > WEEK_MS) return { ok: false, lines: ['That run is more than a week old; I will not undo it.'] };
  const restore = {
    volume: async v => { const r = await media.act({ action: 'volume', set: v / 100 }); if (r && r.ok === false) throw new Error(r.message || 'Windows refused'); return `volume to ${v}%`; },
    output: async o => { if (!(await host.audioSetDefault(o.id))) throw new Error(`Windows would not switch to ${o.name}`); return `sound output to ${o.name}`; },
    focus: async v => { if ((await host.focusAssist(v)) === null) throw new Error('not available'); return `focus assist ${onOff(v)}`; },
    brightness: async v => { await host.setBrightness(v); return `brightness to ${v}%`; },
    powerPlanId: async id => { if (!(await host.setPowerPlan(id))) throw new Error('Windows refused'); return 'the power plan'; },
    nightLight: async v => { if ((await host.nightLight(v)) === null) throw new Error('not available'); return `night light ${onOff(v)}`; },
    bluetooth: async v => { if (!(await host.setBluetooth(v))) throw new Error('Windows refused'); return `Bluetooth ${onOff(v)}`; },
  };
  const keys = Object.keys(snapshot).filter(k => k !== 'at');
  const lines = [];
  let ok = true;
  for (const key of keys.reverse()) {
    if (key === 'apps') {
      for (const a of snapshot.apps || []) {
        try { await openApp(a.name); lines.push(`Reopened ${a.name}.`); } catch (err) { ok = false; lines.push(`Could not restore ${a.name}: ${why(err)}.`); }
      }
      continue;
    }
    if (!restore[key]) continue;
    if (snapshot[key] === null) { lines.push(`Skipped ${WORDS[key]} (it was not readable before).`); continue; }
    try { lines.push(`Restored ${await restore[key](snapshot[key])}.`); } catch (err) { ok = false; lines.push(`Could not restore ${WORDS[key]}: ${why(err)}.`); }
  }
  if (!lines.length) return { ok: false, lines: ['There is nothing to undo.'] };
  return { ok, lines };
}

module.exports = { takeSnapshot, undoSnapshot, KEY_OF };
