// PC control tools: apps, windows, files, volume, lock, power.
// risk 'safe' runs at once; risk 'confirm' only asks (confirm.propose) and runs after the user's own
// "yes" in the next turn (src/core/pc/confirm.js). Apps come from an allowlist only; files only inside
// the roots (Desktop, Documents, Downloads, Projects). Nothing here erases: removal goes to the Recycle Bin.
// Every result is checked (window seen, process gone, file at its new place) before success is claimed.
const fs = require('node:fs');
const win = require('node:path').win32;
const { resolveApp } = require('../pc/apps');
const { safePath, rootNames, inside } = require('../pc/paths');
const { matchText, norm } = require('../media/rank');

const PROTECTED = new Set(['explorer', 'dwm', 'csrss', 'winlogon', 'wininit', 'lsass', 'services', 'svchost', 'smss', 'system', 'taskmgr', 'electron', 'jarvis', 'jarvis core', 'jarvis-core']);
// opening these from a path would run a program: refused (apps go through open_app's allowlist)
const PROGRAM_EXT = new Set(['.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.scr', '.lnk', '.reg', '.hta', '.cpl', '.jar', '.appref-ms', '.url', '.pif', '.application', '.msc']);
const MAX_MOVE = 200;
const MAX_FOUND = 10;
const SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin']);
const POWER_ASK = { shutdown: 'Shut down the PC now', restart: 'Restart the PC now', sleep: 'Put the PC to sleep now' };
const POWER_DONE = { shutdown: 'Shutting down now.', restart: 'Restarting now.', sleep: 'Going to sleep.' };

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const listWords = a => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });
const globRe = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
const exists = p => fs.existsSync(p);

function createPcTools({ host, getAllowlist, roots, confirm, actionLog, media = null, waitMs = 5000, pollMs = 400, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const names = rootNames(roots);
  const where = listWords(names);
  const safe = p => safePath(p, roots);
  const isRoot = p => roots.some(r => win.relative(r, p) === '');
  // "Documents\Sorted" style name for a path inside the roots
  const disp = p => {
    const i = roots.findIndex(r => inside(p, r));
    if (i < 0) return p;
    const rel = win.relative(roots[i], p);
    return rel ? `${names[i]}\\${rel}` : names[i];
  };

  async function poll(check) {
    for (let t = 0; ; t += pollMs) {
      if (await check()) return true;
      if (t >= waitMs) return false;
      await sleep(pollMs);
    }
  }

  async function appEntry(name) {
    const r = resolveApp(name, await getAllowlist());
    if (!r) throw new Error(`"${name}" is not an app I can open. I only open apps from your Start menu or the apps list in settings`);
    if (r.ambiguous) { const n = r.ambiguous.map(e => e.name); throw new Error(`Which one: ${n.length < 3 ? n.join(' or ') : `${n.slice(0, -1).join(', ')} or ${n.at(-1)}`}?`); }
    return r.entry;
  }

  // windows that belong to the app the user named
  // matched by process only (its exe, or the app name): words in other windows' titles never count,
  // so "close code" cannot catch a Chrome tab called "Code review"
  async function windowsFor(name) {
    let label = null, exe = null;
    try {
      const r = resolveApp(name, await getAllowlist());
      if (r?.entry) { label = r.entry.name; const m = /([^\\/]+)\.exe$/i.exec(r.entry.target); if (m) exe = norm(m[1]); }
    } catch { /* allowlist unavailable */ }
    const ws = (await host.windows()).filter(w => (exe && norm(w.app) === exe) || matchText(name, w.app) >= 0.6 || (label && matchText(label, w.app) >= 0.6));
    const apps = [...new Set(ws.map(w => w.app))];
    return { label: label || apps[0] || name, ws, apps };
  }

  const openApp = {
    name: 'open_app', risk: 'safe',
    description: 'Open an installed app by name, e.g. "Spotify" or "Visual Studio Code". Only Start menu apps and apps listed in settings.',
    params: obj({ name: { type: 'string' } }, ['name']),
    async run({ name } = {}) {
      const e = await appEntry(String(name || ''));
      const before = new Set((await host.windows()).map(w => w.hwnd));
      await host.launch(e.target);
      const seen = await poll(async () => (await host.windows()).some(w => !before.has(w.hwnd) || matchText(e.name, w.title) >= 0.5 || matchText(e.name, w.app) >= 0.6));
      if (!seen) throw new Error(`I started ${e.name} but cannot see it running`);
      return `Opened ${e.name}.`;
    },
  };

  const closeApp = {
    name: 'close_app', risk: 'confirm',
    description: 'Close an app by name. Asks the user first; a force close needs a second yes.',
    params: obj({ name: { type: 'string' } }, ['name']),
    async run({ name } = {}) {
      name = String(name || '').trim();
      if (!name) throw new Error('Which app should I close?');
      if (PROTECTED.has(norm(name))) throw new Error(`I won't close ${name}; Windows or JARVIS needs it`);
      const { label, ws, apps } = await windowsFor(name);
      if (ws.some(w => PROTECTED.has(norm(w.app)))) throw new Error(`I won't close ${name}; Windows or JARVIS needs it`);
      if (!ws.length) throw new Error(`${label} is not open`);
      const pids = [...new Set(ws.map(w => w.pid))];
      return confirm.propose({
        tool: 'close_app', summary: `Close ${label}${apps.length > 1 ? ` (${apps.join(', ')})` : ''}`, args: { name, pids },
        run: async () => {
          for (const pid of pids) await host.closeMain(pid);
          if (await poll(async () => (await host.alive(pids)).length === 0)) return `Closed ${label}.`;
          const left = await host.alive(pids);
          return confirm.propose({
            tool: 'close_app', summary: `${label} is still open, maybe asking to save. Force close it? Unsaved work will be lost`, args: { name, pids: left, force: true },
            run: async () => {
              for (const pid of left) await host.kill(pid);
              if (await poll(async () => (await host.alive(left)).length === 0)) return `Force closed ${label}.`;
              throw new Error(`${label} is still running after a force close`);
            },
          });
        },
      });
    },
  };

  const focusWindow = {
    name: 'focus_window', risk: 'safe',
    description: 'Bring an open window to the front, by app name or by words in its title.',
    params: obj({ title: { type: 'string' }, app: { type: 'string' } }),
    async run({ title, app } = {}) {
      const q = String(title || app || '').trim();
      if (!q) throw new Error('Say which window: an app name or words from its title');
      const best = (await host.windows()).map(w => ({ w, s: Math.max(matchText(q, w.app), matchText(q, w.title)) })).filter(x => x.s >= 0.5).sort((a, b) => b.s - a.s)[0];
      if (!best) throw new Error(`No open window matches "${q}"`);
      if (!(await host.focus(best.w.hwnd))) throw new Error(`Windows did not let me bring ${best.w.title} to the front`);
      return `Switched to ${best.w.title}.`;
    },
  };

  const listWindows = {
    name: 'list_windows', risk: 'safe',
    description: 'List the open windows: app and title.',
    params: obj({}),
    async run() {
      const ws = await host.windows();
      if (!ws.length) return 'No windows are open.';
      return `Open windows: ${ws.slice(0, 15).map(w => `${w.app}: ${w.title}`).join('; ')}.`;
    },
  };

  const findFiles = {
    name: 'find_files', risk: 'safe',
    description: `Find files by name words or a pattern like "*.pdf" in ${where}. folder narrows it. Read-only, at most 10 results.`,
    params: obj({ query: { type: 'string' }, folder: { type: 'string' } }, ['query']),
    async run({ query, folder } = {}) {
      const q = String(query || '').trim();
      if (!q) throw new Error('What should I look for?');
      const match = /[*?]/.test(q) ? (re => n => re.test(n))(globRe(q)) : (words => n => words.every(w => n.toLowerCase().includes(w)))(q.toLowerCase().split(/\s+/));
      const start = folder ? [safe(folder)] : roots;
      const found = [];
      const queue = start.map(d => [d, 0]);
      let visited = 0;
      while (queue.length && found.length < MAX_FOUND && visited < 20000) {
        const [dir, depth] = queue.shift();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          visited++;
          if (e.isSymbolicLink()) continue;   // junctions and links can lead out of the roots
          const p = win.join(dir, e.name);
          if (e.isDirectory()) { if (depth < 6 && !SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) queue.push([p, depth + 1]); }
          else if (e.isFile() && match(e.name)) { found.push(p); if (found.length >= MAX_FOUND) break; }
        }
      }
      if (!found.length) return `No files match "${q}" in ${folder ? disp(start[0]) : where}.`;
      return `${found.length >= MAX_FOUND ? 'Found 10 or more' : `Found ${found.length}`}: ${found.join('; ')}`;
    },
  };

  const openPath = {
    name: 'open_path', risk: 'safe',
    description: `Open a file or folder in ${where} with its usual app. Programs are not opened this way.`,
    params: obj({ path: { type: 'string' } }, ['path']),
    async run({ path: raw } = {}) {
      const p = safe(raw);
      let st;
      try { st = fs.statSync(p); } catch { throw new Error(`Not found: ${raw}`); }
      if (st.isFile() && PROGRAM_EXT.has(win.extname(p).toLowerCase())) throw new Error(`I won't open program files (${win.extname(p)}) from a path. Use open_app for installed apps`);
      await host.launch(p);
      return `Asked Windows to open ${win.basename(p)}.`;
    },
  };

  // sources: paths, or one "folder\*.pdf" pattern per item
  function sources(from) {
    const out = [];
    for (const item of [].concat(from || [])) {
      const s = String(item || '').trim();
      if (!s) continue;
      const parts = s.split(/[\\/]+/);
      const last = parts.at(-1);
      if (/[*?]/.test(last)) {
        const dir = safe(parts.slice(0, -1).join('\\'));
        const re = globRe(last);
        let names = [];
        try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.isSymbolicLink() && re.test(e.name)).map(e => e.name).sort(); } catch { /* none */ }
        out.push(...names.map(n => win.join(dir, n)));
      } else {
        const p = safe(s);
        if (isRoot(p)) throw new Error(`I won't move the whole ${win.basename(p)} folder`);
        if (!exists(p)) throw new Error(`Not found: ${s}`);
        out.push(p);
      }
    }
    return [...new Set(out)];
  }

  // a name in dir that is free: "a.pdf" → "a (2).pdf"
  function freeName(dir, base) {
    const ext = win.extname(base), stem = base.slice(0, base.length - ext.length);
    let p = win.join(dir, base);
    for (let i = 2; exists(p); i++) p = win.join(dir, `${stem} (${i})${ext}`);
    return p;
  }

  const moveFiles = {
    name: 'move_files', risk: 'confirm',
    description: `Move files within ${where}. from: paths or a pattern like "Downloads/*.pdf"; to: a folder. Asks the user first.`,
    params: obj({ from: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, to: { type: 'string' } }, ['from', 'to']),
    async run({ from, to } = {}) {
      const dest = safe(to);
      if (exists(dest) && !fs.statSync(dest).isDirectory()) throw new Error(`${disp(dest)} is a file, not a folder`);
      const src = sources(from);
      if (!src.length) throw new Error(`No files match ${[].concat(from).join(', ')}`);
      if (src.length > MAX_MOVE) throw new Error(`That is ${src.length} files; I move at most ${MAX_MOVE} at once`);
      if (src.some(p => inside(dest, p))) throw new Error('A folder cannot be moved into itself');
      const dirs = [...new Set(src.map(p => win.dirname(p)))];
      const what = src.length <= 3 ? listWords(src.map(p => win.basename(p))) : plural(src.length, 'file');
      return confirm.propose({
        tool: 'move_files', summary: `Move ${what} from ${dirs.length === 1 ? disp(dirs[0]) : 'several folders'} to ${disp(dest)}`, args: { from: src, to: dest },
        run: async () => {
          const d = safe(dest);
          fs.mkdirSync(d, { recursive: true });
          const moved = [], failed = [];
          for (const s of src) {
            try {
              safe(s);
              if (!exists(s)) { failed.push(`${win.basename(s)} is gone`); continue; }
              const target = freeName(d, win.basename(s));
              fs.renameSync(s, target);
              if (exists(target) && !exists(s)) moved.push({ from: s, to: target });
              else failed.push(`${win.basename(s)} did not arrive`);
            } catch (err) { failed.push(`${win.basename(s)}: ${err.code === 'EXDEV' ? 'it is on another drive' : err.message}`); }
          }
          if (!moved.length) throw new Error(`Nothing was moved. ${failed.join('; ')}`);
          return { text: `Moved ${plural(moved.length, 'file')} to ${disp(d)}.${failed.length ? ` Not moved: ${failed.join('; ')}.` : ''}`, undo: moved };
        },
      });
    },
  };

  const recycle = {
    name: 'delete_to_recycle_bin', risk: 'confirm',
    description: `Send files or folders in ${where} to the Recycle Bin (they can be restored). Asks the user first.`,
    params: obj({ paths: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } }, ['paths']),
    async run({ paths } = {}) {
      const list = [...new Set([].concat(paths || []).map(p => {
        const r = safe(p);
        if (isRoot(r)) throw new Error(`I won't remove the whole ${win.basename(r)} folder`);
        if (!exists(r)) throw new Error(`Not found: ${p}`);
        return r;
      }))];
      if (!list.length) throw new Error('Which files?');
      if (list.length > MAX_MOVE) throw new Error(`That is ${list.length} items; at most ${MAX_MOVE} at once`);
      const what = list.length <= 3 ? listWords(list.map(p => win.basename(p))) : plural(list.length, 'item');
      return confirm.propose({
        tool: 'delete_to_recycle_bin', summary: `Move ${what} to the Recycle Bin`, args: { paths: list },
        run: async () => {
          let k = 0;
          const failed = [], erased = [];
          for (const p of list) {
            try {
              safe(p);
              const r = await host.recycle(p);
              if (exists(p)) failed.push(win.basename(p));
              else if (r.inBin) k++;
              else erased.push(win.basename(p));   // gone but not in the bin: Windows erased it (after asking in its own dialog)
            } catch (err) { failed.push(`${win.basename(p)}: ${err.message}`); }
          }
          if (erased.length) throw new Error(`${listWords(erased)} did not go to the Recycle Bin; Windows deleted it permanently${k ? `. ${plural(k, 'other item')} went to the Recycle Bin` : ''}`);
          if (!k) throw new Error(`Nothing went to the Recycle Bin. ${failed.join('; ')}`);
          return `Moved ${plural(k, 'item')} to the Recycle Bin.${failed.length ? ` Not moved: ${failed.join('; ')}.` : ''}`;
        },
      });
    },
  };

  const undoLast = {
    name: 'undo_last', risk: 'confirm',
    description: 'Undo the last move_files: move those files back. Asks the user first.',
    params: obj({}),
    async run() {
      const e = actionLog.lastUndoable();
      if (!e) throw new Error('There is no move to undo');
      const items = e.undo;
      return confirm.propose({
        tool: 'undo_last', summary: `Move ${plural(items.length, 'file')} back to ${disp(win.dirname(items[0].from))}`, args: { undo: e.id }, undid: e.id,
        run: async () => {
          let k = 0;
          const failed = [];
          for (const u of [...items].reverse()) {
            try {
              safe(u.from); safe(u.to);
              if (!exists(u.to)) { failed.push(`${win.basename(u.to)} is gone`); continue; }
              if (exists(u.from)) { failed.push(`${win.basename(u.from)} exists again`); continue; }
              fs.mkdirSync(win.dirname(u.from), { recursive: true });
              fs.renameSync(u.to, u.from);
              if (exists(u.from) && !exists(u.to)) k++; else failed.push(win.basename(u.from));
            } catch (err) { failed.push(`${win.basename(u.from)}: ${err.message}`); }
          }
          if (!k) throw new Error(`Nothing was moved back. ${failed.join('; ')}`);
          return `Moved ${plural(k, 'file')} back.${failed.length ? ` Not moved: ${failed.join('; ')}.` : ''}`;
        },
      });
    },
  };

  const setVolume = {
    name: 'set_system_volume', risk: 'safe',
    description: 'Set the Windows system volume to a percent, 0 to 100.',
    params: obj({ percent: { type: 'number' } }, ['percent']),
    async run({ percent } = {}) {
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('Volume is 0 to 100 percent');
      if (!media) throw new Error('Volume control is not available right now');
      const r = await media.act({ action: 'volume', set: percent / 100 });
      if (!r?.ok) throw new Error(r?.message || 'Windows did not change the volume');
      const v = (await media.state())?.system?.volume;
      if (!Number.isFinite(v) || Math.abs(v * 100 - percent) > 2) throw new Error(`I set the volume but it reads ${Number.isFinite(v) ? Math.round(v * 100) + '%' : 'nothing'}`);
      return `System volume is ${Math.round(v * 100)}%.`;
    },
  };

  const lockScreen = {
    name: 'lock_screen', risk: 'safe',
    description: 'Lock the PC (the Windows lock screen).',
    params: obj({}),
    async run() {
      if (!(await host.lock())) throw new Error('Windows did not lock the PC');
      return 'Locked the PC.';
    },
  };

  const power = {
    name: 'power', risk: 'confirm',
    description: 'Shut down, restart or sleep the PC. Asks the user first.',
    params: obj({ mode: { type: 'string', enum: ['shutdown', 'restart', 'sleep'] } }, ['mode']),
    async run({ mode } = {}) {
      if (!POWER_ASK[mode]) throw new Error('Say shutdown, restart or sleep');
      return confirm.propose({
        tool: 'power', summary: POWER_ASK[mode], args: { mode },
        run: async () => {
          if (!(await host.power(mode))) throw new Error('Windows did not accept it');
          return POWER_DONE[mode];
        },
      });
    },
  };

  return [openApp, closeApp, focusWindow, listWindows, findFiles, openPath, moveFiles, recycle, undoLast, setVolume, lockScreen, power];
}

module.exports = { createPcTools, PROGRAM_EXT };
