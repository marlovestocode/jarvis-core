// Typed client for pc-host.ps1 (one long-lived PowerShell process, see createSpeechHost).
// Arguments are checked here before anything is sent; the script only ever receives JSON fields.
// request(cmd, args) → Promise<result>
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'pc-host.ps1');
const POWER = ['shutdown', 'restart', 'sleep'];

// ConvertTo-Json turns a one-item array into a bare value; null means none
const isRect = r => r && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(r[k]));
const cleanRect = r => ({ x: r.x, y: r.y, w: r.w, h: r.h });
const LAYOUTS = ['left', 'right', 'top_left', 'top_right', 'bottom_left', 'bottom_right', 'maximize', 'minimize', 'restore', 'center'];
const list = r => (r === null || r === undefined ? [] : [].concat(r));
const isId = n => Number.isInteger(n) && n > 0;
function needId(n, what) { if (!isId(n)) throw new Error(`Bad ${what}`); return n; }
function needText(s, what) {
  if (typeof s !== 'string' || !s.trim() || /[\r\n\0]/.test(s) || s.length > 1024) throw new Error(`Bad ${what}`);
  return s;
}

function createPcHost({ request }) {
  const call = async (cmd, args = {}) => request(cmd, args);
  const wrap = fn => async (...a) => fn(...a);   // argument errors become rejections, like host errors

  return {
    startApps: wrap(async () => list(await call('startApps')).filter(a => a && typeof a.name === 'string' && typeof a.appId === 'string' && a.name && a.appId)),
    launch: wrap(async target => { await call('launch', { target: needText(target, 'target') }); return true; }),
    // responding and rect are only present when the host reported them
    windows: wrap(async () => list(await call('windows')).filter(w => w && isId(w.hwnd) && isId(w.pid) && typeof w.title === 'string').map(w => ({ hwnd: w.hwnd, pid: w.pid, app: String(w.app || ''), title: w.title, ...(typeof w.responding === 'boolean' ? { responding: w.responding } : {}), ...(isRect(w.rect) ? { rect: cleanRect(w.rect) } : {}) }))),
    foreground: wrap(async () => { const r = await call('foreground'); return isId(r) ? r : null; }),
    monitors: wrap(async () => list(await call('monitors')).filter(m => m && Number.isInteger(m.n) && m.n > 0 && isRect(m)).map(m => ({ n: m.n, primary: !!m.primary, ...cleanRect(m) }))),
    // { ok, rect, state } read back from Windows after the move
    place: wrap(async (hwnd, layout) => {
      needId(hwnd, 'hwnd');
      if (!LAYOUTS.includes(layout)) throw new Error('Bad layout');
      const r = await call('place', { hwnd, layout });
      return { ok: r?.ok === true, rect: isRect(r?.rect) ? cleanRect(r.rect) : null, state: ['normal', 'minimized', 'maximized'].includes(r?.state) ? r.state : null };
    }),
    moveToMonitor: wrap(async (hwnd, n) => {
      needId(hwnd, 'hwnd'); needId(n, 'monitor');
      const r = await call('moveToMonitor', { hwnd, n });
      return { ok: r?.ok === true, rect: isRect(r?.rect) ? cleanRect(r.rect) : null };
    }),
    // true only when Windows is verified to be on the target desktop; false = not possible here
    desktopSwitch: wrap(async target => {
      if (target !== 'next' && target !== 'previous' && !(Number.isInteger(target) && target >= 1 && target <= 20)) throw new Error('Bad desktop');
      return (await call('desktopSwitch', { target })) === true;
    }),
    desktopMove: wrap(async (hwnd, n) => {
      needId(hwnd, 'hwnd');
      if (!(Number.isInteger(n) && n >= 1 && n <= 20)) throw new Error('Bad desktop');
      return (await call('desktopMove', { hwnd, n })) === true;
    }),
    alive: wrap(async pids => {
      if (!Array.isArray(pids)) throw new Error('Bad pid list');
      pids.forEach(p => needId(p, 'pid'));
      return list(await call('alive', { pids })).filter(isId);
    }),
    closeMain: wrap(async pid => (await call('closeMain', { pid: needId(pid, 'pid') })) === true),
    kill: wrap(async pid => (await call('kill', { pid: needId(pid, 'pid') })) === true),
    focus: wrap(async hwnd => (await call('focus', { hwnd: needId(hwnd, 'hwnd') })) === true),
    recycle: wrap(async p => {
      needText(p, 'path');
      if (!path.win32.isAbsolute(p) || /^[\\/]{2}/.test(p)) throw new Error('Recycle needs an absolute local path');
      // { gone, inBin }: gone from its folder, and found in the Recycle Bin (not erased)
      const r = await call('recycle', { path: p });
      return { gone: !!r?.gone, inBin: !!r?.inBin };
    }),
    lock: wrap(async () => (await call('lock')) === true),
    power: wrap(async mode => {
      if (!POWER.includes(mode)) throw new Error('Bad power mode');
      return (await call('power', { mode })) === true;
    }),
  };
}

module.exports = { createPcHost, SCRIPT, LAYOUTS };
