// taskDone monitor: says once when a stored task (core/tasks) finishes or fails. listTasks() → [{ id, title, status }] (task store list).
// Tasks already finished when the monitor first looks are not announced. The text is the title (clipped) and the status, never step output.
const { clip } = require('./clip');

const WORDS = { done: 'is done', failed: 'failed' };

function createTaskDoneMonitor({ listTasks }) {
  return {
    id: 'taskDone',
    enabled: cfg => !!cfg?.taskDone?.enabled,
    async check(_snap, _cfg, state) {
      const tasks = (await listTasks()) || [];
      const seen = state.seen || (state.seen = new Map());   // task id → last status seen
      const first = !state.primed;
      state.primed = true;
      let out = null;
      for (const t of tasks) {
        if (out) break;   // one per check: the rest are still unseen and come on the next
        const prev = seen.get(t.id);
        seen.set(t.id, t.status);
        if (first || prev === t.status || !WORDS[t.status]) continue;
        out = { kind: 'info', key: `task:${clip(t.id)}:${t.status}`, text: `Your task ${clip(t.title) ? `"${clip(t.title)}" ` : ''}${WORDS[t.status]}.` };
      }
      return out;
    },
  };
}

module.exports = { createTaskDoneMonitor };
