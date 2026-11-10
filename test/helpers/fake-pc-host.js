// Test-only stand-in for src/core/pc/host.js: in-memory windows and processes, no real PowerShell.
// launch(target) opens a window for targets listed in `opens`; recycle(path) moves the file into
// `binDir` (so "gone from its folder" can be checked on disk).
const fs = require('node:fs');
const path = require('node:path');

function createFakePcHost({ windows = [], opens = {}, binDir = null, stubborn = [], focusOk = true, lockOk = true } = {}) {
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
    async windows() { log('windows'); return wins.filter(w => alive.has(w.pid)).map(w => ({ ...w })); },
    async alive(pids) { log('alive', pids); return pids.filter(p => alive.has(p)); },
    async closeMain(pid) { log('closeMain', pid); if (!stubborn.includes(pid)) alive.delete(pid); return true; },
    async kill(pid) { log('kill', pid); alive.delete(pid); return true; },
    async focus(hwnd) { log('focus', hwnd); return focusOk; },
    async recycle(p) {
      log('recycle', p);
      if (!binDir) return false;
      fs.renameSync(p, path.join(binDir, path.basename(p) + '.' + calls.length));
      return true;
    },
    async lock() { log('lock'); return lockOk; },
    async power(mode) { log('power', mode); return true; },
  };
}

module.exports = { createFakePcHost };
