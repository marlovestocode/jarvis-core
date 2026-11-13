// Fast-path skill for talking about the running task: "task status", "pause the task", "what happened".
// Every phrase needs the word "task" (bare resume/pause/cancel belong to media and live-state follow-ups),
// except "what happened", which only matches right after a task finished or failed.
const { NEEDS_OK } = require('../brain/guard');

const RECENT_MS = 10 * 60 * 1000;

const STATUS = /^(?:(?:the )?task status|(?:what|how)(?:'s| is) the task(?: (?:going|doing))?|how(?:'s| is) (?:my|the) task (?:going|doing))$/;
const CONTROL = /^(pause|resume|continue|cancel|stop) (?:the |my )?task$/;
const HAPPENED = /^what happened(?: with (?:the|that) task)?$/;
const ACTION = { pause: 'pause', resume: 'resume', continue: 'resume', cancel: 'cancel', stop: 'cancel' };

function createTasksSkill({ runner }) {
  async function handle(text, { source, signal } = {}) {
    const t = String(text || '').toLowerCase().replace(/[.!?,]+/g, ' ').replace(/^(?:please|hey jarvis|jarvis)\s+/, '').replace(/\s+/g, ' ').trim();
    let action = null, id;
    if (HAPPENED.test(t)) {
      const last = runner.lastFinished(RECENT_MS);
      if (!last) return null;
      action = 'status'; id = last.id;
    } else if (STATUS.test(t)) action = 'status';
    else { const m = CONTROL.exec(t); if (m) action = ACTION[m[1]]; }
    if (!action) return null;
    if (!id && !runner.status().ok) return null;   // no task exists: leave the phrase to the model
    const turn = { source, tainted: false };
    let res;
    if (action === 'status') res = await runner.status(id);
    else {
      id = runner.current()?.id;   // the newest open task, a failed one included; the runner words any refusal
      if (!id) return null;
      res = action === 'resume' ? await runner.resume(id, { turn, signal }) : await runner[action](id);
    }
    // A fast-path reply is spoken as is: a question keeps its words but not the internal NEEDS_OK marker.
    const out = String(res.text ?? '');
    const reply = out.startsWith(NEEDS_OK) ? out.slice(NEEDS_OK.length) : out;
    return { reply, record: reply, tool: 'task_control', ok: !!res.ok };
  }
  return { handle };
}

module.exports = { createTasksSkill };
