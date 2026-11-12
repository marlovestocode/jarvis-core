'use strict';
// Persistent tasks, one JSON file per task: <dir>/<id>.json, atomic write (temp + rename).
// A corrupt or wrong-shape file is moved to <dir>/broken/<id>.json and treated as absent.
// Task: { id, v: 1, title, status, origin, created, updated, replans, steps }
const fs = require('node:fs');
const path = require('node:path');

const MAX_TASKS = 50;
const TTL_MS = 14 * 24 * 3600 * 1000;
const RESULT_CAP = 4096;
const ID_RE = /^[a-z0-9]{4,24}$/;
const FINISHED = ['done', 'cancelled', 'failed'];
const isFinished = t => FINISHED.includes(t.status);

function createTaskStore({ dir, now = Date.now, log = () => {} }) {
  let seq = 0;
  const fileOf = id => path.join(dir, id + '.json');

  function quarantine(id, why) {
    log(`task ${id} unreadable (${why}), moved to broken/`);
    try {
      const broken = path.join(dir, 'broken');
      fs.mkdirSync(broken, { recursive: true });
      fs.renameSync(fileOf(id), path.join(broken, id + '.json'));
    } catch { /* best effort */ }
  }

  function get(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    let text;
    try { text = fs.readFileSync(fileOf(id), 'utf8'); } catch { return null; }
    try {
      const t = JSON.parse(text);
      if (!t || t.id !== id || !Array.isArray(t.steps) || typeof t.status !== 'string') throw new Error('bad shape');
      return t;
    } catch (err) {
      quarantine(id, err.message);
      return null;
    }
  }

  function ids() {
    try {
      return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).filter(id => ID_RE.test(id));
    } catch { return []; }
  }

  const all = () => ids().map(get).filter(Boolean);

  function write(task) {
    fs.mkdirSync(dir, { recursive: true });
    const file = fileOf(task.id);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
    fs.renameSync(tmp, file);
  }

  function save(task) {
    for (const s of task.steps || []) {
      if (s && s.result && typeof s.result.text === 'string' && s.result.text.length > RESULT_CAP) s.result.text = s.result.text.slice(0, RESULT_CAP);
    }
    task.updated = now();
    write(task);
  }

  function remove(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return;
    try { fs.unlinkSync(fileOf(id)); } catch { /* already gone */ }
  }

  function list() {
    return all()
      .map(t => ({ id: t.id, title: t.title, status: t.status, updated: t.updated }))
      .sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }

  function prune() {
    const t0 = now();
    let tasks = all();
    for (const t of tasks) if (isFinished(t) && t0 - (t.updated || 0) > TTL_MS) remove(t.id);
    tasks = all();
    const finished = tasks.filter(isFinished).sort((a, b) => (a.updated || 0) - (b.updated || 0));
    let excess = tasks.length - (MAX_TASKS - 1);
    for (const t of finished) {
      if (excess <= 0) break;
      remove(t.id);
      excess--;
    }
    if (excess > 0) throw new Error(`Too many open tasks (${MAX_TASKS}). Finish or cancel one first.`);
  }

  function create({ title, steps, origin }) {
    prune();
    let id;
    do { id = 'k' + now().toString(36) + (seq++).toString(36); } while (fs.existsSync(fileOf(id)));
    const t0 = now();
    const task = { id, v: 1, title, status: 'planned', origin, created: t0, updated: t0, replans: 0, steps };
    save(task);
    return task;
  }

  function sweep() {
    let n = 0;
    for (const t of all()) {
      if (t.status !== 'running') continue;
      t.status = 'interrupted';
      try { save(t); n++; } catch (err) { log(`task ${t.id} sweep save failed: ${err.message}`); }
    }
    return n;
  }

  return { create, get, save, list, remove, sweep };
}

module.exports = { createTaskStore, MAX_TASKS, TTL_MS, RESULT_CAP };
