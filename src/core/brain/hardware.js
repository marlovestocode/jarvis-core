// Static facts about this PC, gathered once in the background (local commands only).
const nodeOs = require('node:os');
const { execFile } = require('node:child_process');

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(String(out))));
});

function createHardwareProbe({ os = nodeOs, exec = run } = {}) {
  let result = null, pending = null;

  async function gpu() {
    try {
      const line = (await exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])).trim().split(/\r?\n/)[0];
      const [name, mib] = line.split(',').map(s => s.trim());
      if (name) return mib ? `${name}, ${Math.round(+mib / 1024)} GB VRAM` : name;
    } catch { /* not NVIDIA, or no driver tools */ }
    try {
      const out = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name']);
      const name = out.trim().split(/\r?\n/)[0];
      if (name) return name;
    } catch { /* unknown */ }
    return undefined;
  }

  async function probe() {
    const cpus = os.cpus() || [];
    const out = {};
    if (cpus.length) out.cpu = `${cpus[0].model.trim().replace(/\s+/g, ' ')} (${cpus.length} threads)`;
    out.ramGB = Math.round(os.totalmem() / 2 ** 30 * 10) / 10;
    const g = await gpu();
    if (g) out.gpu = g;
    const build = +(os.release().split('.')[2] || 0);
    if (os.platform() === 'win32') out.os = `Windows ${build >= 22000 ? 11 : 10} (build ${build})`;
    return out;
  }

  return {
    get() {
      if (result) return Promise.resolve(result);
      if (!pending) pending = probe().then(r => { result = r; return r; });
      return pending;
    },
    cached: () => result,
  };
}

module.exports = { createHardwareProbe };
