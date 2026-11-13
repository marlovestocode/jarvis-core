// Fast-path skill for talking about the running task: "task status", "pause the task", "what happened".
// Every phrase needs the word "task" (bare resume/pause/cancel belong to media and live-state follow-ups),
// except "what happened", which only matches right after a task finished or failed.
const RECENT_MS = 10 * 60 * 1000;

const STATUS = /^(?:(?:the )?task status|(?:what|how)(?:'s| is) the task(?: (?:going|doing))?|how(?:'s| is) (?:my|the) task (?:going|doing))$/;
const CONTROL = /^(pause|resume|continue|cancel|stop) (?:the |my )?task$/;
const HAPPENED = /^what happened(?: with (?:the|that) task)?$/;
const ACTION = { pause: 'pause', resume: 'resume', continue: 'resume', cancel: 'cancel', stop: 'cancel' };

function createTasksSkill({ runner }) {
  async function handle(text, { source } = {}) {
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
      id = runner.active()?.id;   // the unfinished task the user means
      if (!id) return { reply: 'There is no unfinished task.', record: 'There is no unfinished task.', tool: 'task_control', ok: false };
      res = action === 'resume' ? await runner.resume(id, { turn }) : await runner[action](id);
    }
    return { reply: res.text, record: res.text, tool: 'task_control', ok: !!res.ok };
  }
  return { handle };
}

module.exports = { createTasksSkill };
