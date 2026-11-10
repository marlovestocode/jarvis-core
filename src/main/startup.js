// "Start with Windows": one startup path only. If the "JARVIS AI Core" scheduled task
// exists (Task Scheduler starts it at sign-in, independent of any terminal or IDE), the
// task is the path: enable/disable it, make it start tray-only, and remove our Run entry.
// Without the task we use the Windows login item (HKCU Run).
const { execFileSync } = require('node:child_process');
const { loginItem } = require('../core/boot');

const TASK = 'JARVIS AI Core';
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });

function createStartup({ exec = run, setLoginItem, execPath, appPath, packaged }) {
  function taskExists() {
    try { exec('schtasks', ['/Query', '/TN', TASK]); return true; } catch { return false; }
  }
  function taskArgs() {
    try {
      const xml = exec('schtasks', ['/Query', '/TN', TASK, '/XML']);
      const m = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml);
      return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') : '';
    } catch { return ''; }
  }

  function apply(enabled) {
    if (taskExists()) {
      try {
        exec('schtasks', ['/Change', '/TN', TASK, enabled ? '/ENABLE' : '/DISABLE']);
        if (enabled && !/--hidden/.test(taskArgs())) {
          const app = packaged ? '' : ` "${appPath}"`;
          exec('schtasks', ['/Change', '/TN', TASK, '/TR', `"${execPath}"${app} --hidden`]);
        }
        setLoginItem({ ...loginItem({ enabled: false, execPath, appPath, packaged }) }); // no second Run entry
        // Electron leaves its value behind in some cases; delete it explicitly (missing value is fine)
        let note;
        try { exec('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'jarvis.core', '/f']); } catch (err) {
          const msg = String(err.stderr || err.message || err).trim();
          if (!/unable to find/i.test(msg)) note = `Run entry not removed: ${msg}`;
        }
        return { via: 'task', enabled, note };
      } catch (err) {
        setLoginItem(loginItem({ enabled, execPath, appPath, packaged }));
        return { via: 'login item', enabled, note: `task not changed: ${String(err.message || err).trim()}` };
      }
    }
    setLoginItem(loginItem({ enabled, execPath, appPath, packaged }));
    return { via: 'login item', enabled };
  }

  return { apply, taskExists };
}

module.exports = { createStartup, TASK };
