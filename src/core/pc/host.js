// Typed client for pc-host.ps1 (one long-lived PowerShell process, see createSpeechHost).
// Arguments are checked here before anything is sent; the script only ever receives JSON fields.
// request(cmd, args) → Promise<result>
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'pc-host.ps1');
const POWER = ['shutdown', 'restart', 'sleep'];

// ConvertTo-Json turns a one-item array into a bare value; null means none
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
    windows: wrap(async () => list(await call('windows')).filter(w => w && isId(w.hwnd) && isId(w.pid) && typeof w.title === 'string').map(w => ({ hwnd: w.hwnd, pid: w.pid, app: String(w.app || ''), title: w.title }))),
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

module.exports = { createPcHost, SCRIPT };
