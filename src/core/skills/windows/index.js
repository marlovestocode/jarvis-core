// Window layout, monitors, virtual desktops and hung apps. Every move is read back from Windows before it is
// reported; what cannot be verified (or is not available on this build) is an error, never a success.
const { matchText, norm } = require('../../media/rank');
const { PROTECTED } = require('../../tools/pc');
const { LAYOUTS } = require('../../pc/host');
const { own } = require('../util');

const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });
const TOL = 16;   // px: Windows adds invisible borders, so a snapped rect is a few pixels off
const NO_DESKTOPS = 'Virtual desktops are not available on this Windows build';
const SAID = { left: 'the left', right: 'the right', top_left: 'the top left', top_right: 'the top right', bottom_left: 'the bottom left', bottom_right: 'the bottom right' };
const DONE = { maximize: 'Maximized', minimize: 'Minimized', restore: 'Restored', center: 'Centered' };
const near = (a, b) => Math.abs(a - b) <= TOL;
const sameRect = (a, b) => near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);

// where each tiling layout should land inside a monitor's work area
function tileOf(layout, m) {
  const hw = Math.floor(m.w / 2), hh = Math.floor(m.h / 2);
  return {
    left: { x: m.x, y: m.y, w: hw, h: m.h }, right: { x: m.x + hw, y: m.y, w: m.w - hw, h: m.h },
    top_left: { x: m.x, y: m.y, w: hw, h: hh }, top_right: { x: m.x + hw, y: m.y, w: m.w - hw, h: hh },
    bottom_left: { x: m.x, y: m.y + hh, w: hw, h: m.h - hh }, bottom_right: { x: m.x + hw, y: m.y + hh, w: m.w - hw, h: m.h - hh },
  }[layout];
}
const monitorAt = (monitors, r) => monitors.find(m => r.x + r.w / 2 >= m.x && r.x + r.w / 2 < m.x + m.w && r.y + r.h / 2 >= m.y && r.y + r.h / 2 < m.y + m.h);
const monitorList = ms => ms.map(m => `${m.n} (${m.primary ? 'primary, ' : ''}${m.w}x${m.h})`).join(', ');

function createWindowsTools({ host, confirm, actionLog, waitMs = 5000, pollMs = 300, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  async function poll(check) {
    for (let t = 0; ; t += pollMs) {
      if (await check()) return true;
      if (t >= waitMs) return false;
      await sleep(pollMs);
    }
  }

  // the window the user means: by app name or title words; omitted = the one in front
  async function pick(target) {
    const ws = await host.windows();
    const q = String(target || '').trim();
    if (!q) {
      const h = await host.foreground();
      const w = ws.find(x => x.hwnd === h);
      if (!w) throw new Error("I can't tell which window is in front. Say which one.");
      return w;
    }
    const best = ws.map(w => ({ w, s: Math.max(matchText(q, w.app), matchText(q, w.title)) })).filter(x => x.s >= 0.5).sort((a, b) => b.s - a.s)[0];
    if (!best) throw new Error(`No open window matches "${q}". Open windows: ${ws.slice(0, 10).map(w => w.title).join('; ') || 'none'}.`);
    return best.w;
  }

  const windowArrange = {
    name: 'window_arrange', risk: 'safe',
    hint: 'window_arrange: snap, maximize, minimize, restore or center a window. window_to_monitor: move it to another monitor. desktop_switch / window_to_desktop: virtual desktops. end_unresponsive_app: end a hung app (asks first). Say it is done only when the result says so.',
    description: `Snap, maximize, minimize, restore or center a window. layout: ${LAYOUTS.join(', ')}. target: app or title words; omit for the window in front.`,
    params: obj({ target: { description: 'app name or words from the title; omit for the window in front', type: 'string' }, layout: { description: 'where to put the window or which state to give it', type: 'string', enum: LAYOUTS } }, ['layout']),
    async run({ target, layout } = {}) {
      if (!LAYOUTS.includes(layout)) throw new Error(`Unknown layout "${layout}". Layouts: ${LAYOUTS.join(', ')}.`);
      const w = await pick(target);
      const res = await host.place(w.hwnd, layout);
      const fail = why => new Error(`${w.title} did not end up ${why}`);
      if (!res.ok) throw fail('where I asked (Windows refused the move)');
      if (layout === 'maximize' || layout === 'minimize' || layout === 'restore') {
        const want = { maximize: 'maximized', minimize: 'minimized', restore: 'normal' }[layout];
        if (res.state !== want) throw fail(`${want === 'normal' ? 'restored' : want} (it is ${res.state || 'in an unknown state'})`);
      } else {
        const ms = await host.monitors();
        if (!res.rect || !ms.length) throw new Error(`I moved ${w.title} but cannot verify where it went`);
        if (layout === 'center') {
          const m = monitorAt(ms, res.rect);
          if (!m || !near(res.rect.x + res.rect.w / 2, m.x + m.w / 2) || !near(res.rect.y + res.rect.h / 2, m.y + m.h / 2)) throw fail('centered');
        } else if (!ms.some(m => sameRect(res.rect, tileOf(layout, m)))) {
          throw fail(`in ${SAID[layout]} of the screen`);
        }
      }
      return SAID[layout] ? `Snapped ${w.title} to ${SAID[layout]}.` : `${DONE[layout]} ${w.title}.`;
    },
  };

  const windowToMonitor = {
    name: 'window_to_monitor', risk: 'safe',
    hint: 'window_to_monitor: see window_arrange.',
    description: 'Move a window to monitor number N, or to the "next" monitor. target: app or title words; omit for the window in front.',
    params: obj({ target: { description: 'app name or words from the title; omit for the window in front', type: 'string' }, monitor: { description: 'monitor number from 1, or "next"', anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', enum: ['next'] }] } }, ['monitor']),
    async run({ target, monitor } = {}) {
      const ms = await host.monitors();
      if (!ms.length) throw new Error('I cannot read the monitors');
      const w = await pick(target);
      let n = monitor;
      if (monitor === 'next') {
        if (ms.length < 2) throw new Error('There is only one monitor.');
        const cur = w.rect ? monitorAt(ms, w.rect) : null;
        const i = cur ? ms.findIndex(m => m.n === cur.n) : -1;
        n = ms[(i + 1) % ms.length].n;
      }
      if (!Number.isInteger(n) || !ms.some(m => m.n === n)) throw new Error(`Monitor ${monitor} does not exist. Monitors: ${monitorList(ms)}.`);
      const res = await host.moveToMonitor(w.hwnd, n);
      const m = ms.find(k => k.n === n);
      if (!res.ok || !res.rect || monitorAt([m], res.rect) !== m) throw new Error(`${w.title} did not end up on monitor ${n}`);
      return `Moved ${w.title} to monitor ${n}.`;
    },
  };

  const desktopSwitch = {
    name: 'desktop_switch', risk: 'safe',
    hint: 'desktop_switch: see window_arrange.',
    description: 'Switch virtual desktop: "next" or "previous". A number is only possible where Windows allows it; the result says so.',
    params: obj({ to: { description: '"next", "previous", or a desktop number from 1', anyOf: [{ type: 'string', enum: ['next', 'previous'] }, { type: 'integer', minimum: 1 }] } }, ['to']),
    async run({ to } = {}) {
      if (to !== 'next' && to !== 'previous' && !(Number.isInteger(to) && to >= 1 && to <= 20)) throw new Error('Say next, previous, or a desktop number from 1 to 20');
      if (!(await host.desktopSwitch(to))) throw new Error(`Windows stayed on the same desktop; there may be no ${typeof to === 'number' ? `desktop ${to}` : `${to} desktop`}`);
      return typeof to === 'number' ? `Switched to desktop ${to}.` : `Switched to the ${to} desktop.`;
    },
  };

  const windowToDesktop = {
    name: 'window_to_desktop', risk: 'safe',
    hint: 'window_to_desktop: see window_arrange.',
    description: 'Move a window to virtual desktop number N, where Windows allows it; the result says if not. target: app or title words; omit for the window in front.',
    params: obj({ target: { description: 'app name or words from the title; omit for the window in front', type: 'string' }, desktop: { description: 'virtual desktop number, from 1', type: 'integer', minimum: 1 } }, ['desktop']),
    async run({ target, desktop } = {}) {
      if (!(Number.isInteger(desktop) && desktop >= 1 && desktop <= 20)) throw new Error('Say a desktop number from 1 to 20');
      const w = await pick(target);
      if (!(await host.desktopMove(w.hwnd, desktop))) throw new Error(`${w.title} is not on desktop ${desktop}; there may be no such desktop`);
      return `Moved ${w.title} to desktop ${desktop}.`;
    },
  };

  const endUnresponsive = {
    name: 'end_unresponsive_app', risk: 'confirm',
    hint: 'end_unresponsive_app: see window_arrange.',
    description: 'End an app Windows reports as not responding. Only for hung windows. Asks the user first; unsaved work is lost.',
    params: obj({ name: { description: 'name of the app that is not responding', type: 'string' } }, ['name']),
    async run({ name } = {}) {
      name = String(name || '').trim();
      if (!name) throw new Error('Which app is frozen?');
      if (PROTECTED.has(norm(name))) throw new Error(`I won't end ${name}; Windows or JARVIS needs it`);
      const ws = (await host.windows()).filter(w => matchText(name, w.app) >= 0.6 || matchText(name, w.title) >= 0.6);
      if (!ws.length) throw new Error(`${name} is not open`);
      if (ws.some(w => PROTECTED.has(norm(w.app)))) throw new Error(`I won't end ${name}; Windows or JARVIS needs it`);
      const label = ws[0].app || name;
      const hung = ws.filter(w => w.responding === false);
      if (!hung.length) throw new Error(`Windows does not report ${label} as not responding, so I will not end it. I only end hung apps`);
      const pids = [...new Set(hung.map(w => w.pid))];
      return confirm.propose({
        tool: 'end_unresponsive_app', summary: `End ${label}, which is not responding. Unsaved work in it will be lost`, args: { name, pids },
        run: async () => {
          // only the processes proposed, and only if they are still hung
          const now = await host.windows();
          const still = pids.filter(pid => now.some(w => w.pid === pid && w.responding === false));
          if (!still.length) return `${label} is responding again, so I left it running.`;
          for (const pid of still) await host.kill(pid);
          if (!(await poll(async () => (await host.alive(still)).length === 0))) throw new Error(`${label} is still running after I ended it`);
          return `Ended ${label}.`;
        },
      });
    },
  };

  return [windowArrange, windowToMonitor, desktopSwitch, windowToDesktop, endUnresponsive];
}

function createGroup({ pc } = {}) {
  if (!pc) return null;
  const tools = createWindowsTools(pc);
  return {
    id: 'windows',
    label: 'Window layout, monitors, virtual desktops, hung apps',
    triggers: [
      { words: ['snap', 'maximize', 'maximise', 'minimize', 'minimise', 'restore', 'left half', 'right half', 'monitor', 'monitors', 'second screen', 'virtual desktop', 'virtual desktops', 'not responding', 'frozen', 'hung', 'unresponsive'], w: 3 },
      { re: /\b(?:next|previous|other|new) desktop\b|\bdesktop \d+\b/i, w: 3 },
      { words: ['window', 'windows', 'resize', 'desktop'], w: 1 },
    ],
    tools: tools.map(t => own(t)),
  };
}

module.exports = { createGroup, createWindowsTools };
