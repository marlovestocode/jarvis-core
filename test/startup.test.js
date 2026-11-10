const test = require('node:test');
const assert = require('node:assert/strict');
const { createStartup } = require('../src/main/startup');

function fakes({ task = true, tr = '"C:\\e\\electron.exe" "C:\\app"' } = {}) {
  const calls = [], login = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args[0] === '/Query') {
      if (!task) { const e = new Error('not found'); e.status = 1; throw e; }
      return args.includes('/XML') ? `<Task><Actions><Exec><Command>C:\\e\\electron.exe</Command><Arguments>${tr.split(' ').slice(1).join(' ').replace(/"/g, '&quot;')}</Arguments></Exec></Actions></Task>` : 'ok';
    }
    return 'SUCCESS';
  };
  const setLoginItem = s => login.push(s);
  return { calls, login, exec, setLoginItem };
}

test('startup: with the JARVIS AI Core task, the task is the one path: enabled, --hidden added, Run entry removed', () => {
  const f = fakes();
  const s = createStartup({ exec: f.exec, setLoginItem: f.setLoginItem, execPath: 'C:\\e\\electron.exe', appPath: 'C:\\app', packaged: false });
  const r = s.apply(true);
  assert.equal(r.via, 'task');
  assert.ok(f.calls.some(c => c.includes('/Change') && c.includes('/ENABLE')));
  assert.ok(f.calls.some(c => c.includes('/Change') && c.includes('/TR') && c.includes('--hidden')));
  assert.deepEqual(f.login.at(-1).openAtLogin, false, 'no duplicate Run entry');
  assert.ok(f.calls.some(c => c.startsWith('reg delete') && c.includes('/v jarvis.core')), 'old Run value deleted explicitly');
});

test('startup: turning it off disables the task', () => {
  const f = fakes({ tr: '"C:\\e\\electron.exe" "C:\\app" --hidden' });
  const s = createStartup({ exec: f.exec, setLoginItem: f.setLoginItem, execPath: 'C:\\e\\electron.exe', appPath: 'C:\\app', packaged: false });
  s.apply(false);
  assert.ok(f.calls.some(c => c.includes('/DISABLE')));
  assert.ok(!f.calls.some(c => c.includes('/TR')), '--hidden already there: no rewrite');
});

test('startup: no task → Windows login item as before', () => {
  const f = fakes({ task: false });
  const s = createStartup({ exec: f.exec, setLoginItem: f.setLoginItem, execPath: 'C:\\e\\electron.exe', appPath: 'C:\\app', packaged: false });
  const r = s.apply(true);
  assert.equal(r.via, 'login item');
  assert.deepEqual(f.login.at(-1), { openAtLogin: true, path: 'C:\\e\\electron.exe', args: ['C:\\app', '--hidden'] });
});

test('startup: a schtasks failure never throws; falls back to the login item', () => {
  const f = fakes();
  const exec = (cmd, args) => { if (args[0] === '/Change') throw new Error('Access is denied'); return f.exec(cmd, args); };
  const s = createStartup({ exec, setLoginItem: f.setLoginItem, execPath: 'C:\\e\\electron.exe', appPath: 'C:\\app', packaged: false });
  const r = s.apply(true);
  assert.equal(r.via, 'login item');
  assert.match(r.note, /Access is denied/);
  assert.equal(f.login.at(-1).openAtLogin, true);
});
