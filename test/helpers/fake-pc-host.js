// Test-only stand-in for src/core/pc/host.js: in-memory windows and processes, no real PowerShell.
// launch(target) opens a window for targets listed in `opens`; recycle(path) moves the file into
// `binDir` (so "gone from its folder" can be checked on disk).
const fs = require('node:fs');
const path = require('node:path');

// monitors: work areas. desktops: false = this Windows build has no virtual-desktop support.
// placeWrong: place() claims success but leaves the window where it was (to test read-back checks).
function createFakePcHost({ windows = [], opens = {}, binDir = null, stubborn = [], focusOk = true, lockOk = true, monitors = [{ n: 1, primary: true, x: 0, y: 0, w: 1920, h: 1080 }], desktops = true, foreground = null, placeWrong = false,
  audioDevices = [], audioStuck = false, brightness = null, brightnessStuck = false, displays = [], nightLight = null, nightStuck = false } = {}) {
  const devs = audioDevices.map(d => ({ ...d }));
  let bright = brightness, night = nightLight;
  const calls = [];
  const wins = windows.map(w => ({ ...w }));
  const alive = new Set(wins.map(w => w.pid));
  let nextH = 1000, nextPid = 5000;
  const log = (cmd, arg) => calls.push(arg === undefined ? [cmd] : [cmd, arg]);
  return {
    calls,
    wins,
    async startApps() { log('startApps'); return []; },
    async launch(target) {
      log('launch', target);
      const o = opens[target];
      if (o) { const pid = nextPid++; wins.push({ hwnd: nextH++, pid, app: o.app, title: o.title }); alive.add(pid); }
      return true;
    },
    async windows() { log('windows'); return wins.filter(w => alive.has(w.pid)).map(w => ({ ...w })); },   // may carry responding and rect
    async alive(pids) { log('alive', pids); return pids.filter(p => alive.has(p)); },
    async closeMain(pid) { log('closeMain', pid); if (!stubborn.includes(pid)) alive.delete(pid); return true; },
    async kill(pid) { log('kill', pid); alive.delete(pid); return true; },
    async foreground() { log('foreground'); return foreground ?? wins.find(w => alive.has(w.pid))?.hwnd ?? null; },
    async monitors() { log('monitors'); return monitors.map(m => ({ ...m })); },
    async place(hwnd, layout) {
      log('place', { hwnd, layout });
      const w = wins.find(x => x.hwnd === hwnd);
      if (!w) throw new Error('No such window');
      if (placeWrong) return { ok: true, rect: { ...(w.rect || { x: 100, y: 100, w: 800, h: 600 }) }, state: w.state || 'normal' };
      const r = w.rect || { x: 100, y: 100, w: 800, h: 600 };
      const m = monitors.find(k => r.x + r.w / 2 >= k.x && r.x + r.w / 2 < k.x + k.w) || monitors[0];
      const hw = Math.floor(m.w / 2), hh = Math.floor(m.h / 2);
      const at = {
        left: { x: m.x, y: m.y, w: hw, h: m.h }, right: { x: m.x + hw, y: m.y, w: m.w - hw, h: m.h },
        top_left: { x: m.x, y: m.y, w: hw, h: hh }, top_right: { x: m.x + hw, y: m.y, w: m.w - hw, h: hh },
        bottom_left: { x: m.x, y: m.y + hh, w: hw, h: m.h - hh }, bottom_right: { x: m.x + hw, y: m.y + hh, w: m.w - hw, h: m.h - hh },
        center: { x: m.x + Math.floor((m.w - r.w) / 2), y: m.y + Math.floor((m.h - r.h) / 2), w: r.w, h: r.h },
      }[layout];
      if (at) { w.rect = at; w.state = 'normal'; }
      else if (layout === 'maximize') { w.rect = { x: m.x, y: m.y, w: m.w, h: m.h }; w.state = 'maximized'; }
      else if (layout === 'minimize') w.state = 'minimized';
      else if (layout === 'restore') w.state = 'normal';
      else throw new Error('Bad layout');
      return { ok: true, rect: { ...w.rect }, state: w.state };
    },
    async moveToMonitor(hwnd, n) {
      log('moveToMonitor', { hwnd, n });
      const w = wins.find(x => x.hwnd === hwnd);
      const m = monitors.find(k => k.n === n);
      if (!w || !m) throw new Error('No such window or monitor');
      const r = w.rect || { x: 100, y: 100, w: 800, h: 600 };
      w.rect = { x: m.x + 50, y: m.y + 50, w: Math.min(r.w, m.w - 100), h: Math.min(r.h, m.h - 100) };
      return { ok: true, rect: { ...w.rect } };
    },
    async audioDevices() { log('audioDevices'); return devs.map(d => ({ ...d })); },
    async audioSetDefault(id) { log('audioSetDefault', id); if (!audioStuck) for (const d of devs) d.default = d.id === id; return true; },
    async brightness() { log('brightness'); return bright; },
    async setBrightness(p) { log('setBrightness', p); if (!brightnessStuck) bright = p; return bright; },
    async displays() { log('displays'); return displays.map(d => ({ ...d })); },
    async nightLight(on) { log('nightLight', on); if (night === null) return null; if (on !== undefined && !nightStuck) night = on; return night; },
    async desktopSwitch(target) { log('desktopSwitch', target); if (!desktops) throw new Error('Virtual desktops are not available on this Windows build'); return true; },
    async desktopMove(hwnd, n) { log('desktopMove', { hwnd, n }); if (!desktops) throw new Error('Virtual desktops are not available on this Windows build'); return true; },
    async focus(hwnd) { log('focus', hwnd); return focusOk; },
    async recycle(p) {
      log('recycle', p);
      if (!binDir) return { gone: false, inBin: false };
      fs.renameSync(p, path.join(binDir, path.basename(p) + '.' + calls.length));
      return { gone: true, inBin: true };
    },
    async lock() { log('lock'); return lockOk; },
    async power(mode) { log('power', mode); return true; },
  };
}

module.exports = { createFakePcHost };
