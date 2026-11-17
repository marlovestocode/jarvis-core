'use strict';
// Saved routines: <file> is one JSON array of { name, steps: [{ tool, args }], lastRun? }.
// lastRun = { at, snapshot } of the newest run, kept for undo. Atomic write; a corrupt file is moved to <file>.broken.
const fs = require('node:fs');
const path = require('node:path');

// the only tools a routine step may call; routine_close is the polite close that needs a run token (see close-tool.js)
const STEP_TOOLS = new Set(['routine_close', 'open_app', 'focus_assist', 'set_system_volume', 'audio_output_set', 'brightness_set', 'power_plan_set', 'night_light', 'bluetooth_set', 'youtube_music']);
const RESERVED = new Set(['undo', 'list', 'stop', 'play', 'pause', 'resume', 'yes', 'no']);
const MAX_STEPS = 12;
const MAX_ROUTINES = 50;

const normName = s => String(s ?? '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^the /, '');

function check(r) {
  if (!r || typeof r !== 'object') return 'A routine needs a name and steps.';
  const n = normName(r.name);
  if (!n || n.length > 40) return 'A routine needs a name of 1 to 40 characters.';
  if (RESERVED.has(n)) return `"${n}" is a word JARVIS already uses; pick another name.`;
  if (!Array.isArray(r.steps) || !r.steps.length) return 'A routine needs at least one step.';
  if (r.steps.length > MAX_STEPS) return `A routine can have at most ${MAX_STEPS} steps.`;
  for (const s of r.steps) {
    if (!s || typeof s.tool !== 'string' || !STEP_TOOLS.has(s.tool)) return `Step tool "${s?.tool}" is not allowed in a routine.`;
    if (s.args != null && (typeof s.args !== 'object' || Array.isArray(s.args))) return `Step ${s.tool} args must be an object.`;
  }
  return null;
}

function createRoutineStore({ file, log = () => {} }) {
  let cache = null;

  function load() {
    if (cache) return cache;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return (cache = []); }
    try {
      const list = JSON.parse(text);
      if (!Array.isArray(list)) throw new Error('not a list');
      return (cache = list.filter(r => r && !check(r)));
    } catch (err) {
      log(`routines file unreadable (${err.message}), moved to .broken`);
      try { fs.renameSync(file, file + '.broken'); } catch { /* best effort */ }
      return (cache = []);
    }
  }

  function write() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, file);
  }

  const index = name => load().findIndex(r => normName(r.name) === normName(name));
  const copy = r => (r ? JSON.parse(JSON.stringify(r)) : null);

  return {
    list: () => load().map(copy),
    get: name => copy(load()[index(name)]),
    save(routine) {
      const error = check(routine);
      if (error) return { ok: false, error };
      const list = load();
      const i = index(routine.name);
      if (i < 0 && list.length >= MAX_ROUTINES) return { ok: false, error: `At most ${MAX_ROUTINES} routines.` };
      const next = { name: String(routine.name).trim(), steps: routine.steps.map(s => ({ tool: s.tool, args: { ...(s.args || {}) } })) };
      if (i >= 0 && list[i].lastRun) next.lastRun = list[i].lastRun;
      if (i >= 0) list[i] = next; else list.push(next);
      write();
      return { ok: true };
    },
    remove(name) {
      const i = index(name);
      if (i < 0) return false;
      load().splice(i, 1);
      write();
      return true;
    },
    setLastRun(name, run) {
      const i = index(name);
      if (i < 0) return;
      if (run) load()[i].lastRun = run; else delete load()[i].lastRun;
      write();
    },
  };
}

module.exports = { createRoutineStore, normName, STEP_TOOLS, RESERVED };
