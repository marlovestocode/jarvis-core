// task_run and task_control: the model plans a multi-step job as a stored task and steers it later.
// Both return the runner's text; a NEEDS_OK question passes through untouched so the orchestrator asks it.
const ACTIONS = ['status', 'pause', 'resume', 'cancel', 'replan'];

const STEPS = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      tool: { type: 'string' },
      args: { type: 'object' },
      expect: { type: 'object', description: 'optional check on the result: one of nonEmpty, contains, matches' },
    },
    required: ['tool'],
  },
};

function createTaskTools({ runner }) {
  const taskRun = {
    name: 'task_run',
    hint: 'task_run: a job of several dependent tool calls that must survive a restart; give title and steps. Step ids are s1, s2 in order. task_control: status, pause, resume, cancel or replan it.',
    description: 'Run a multi-step job as a saved task (max 12 steps). steps: [{tool,args,expect?}]; ids are s1, s2... in order. A later step may use an earlier result in args: {"$ref":"s1"} or {"$ref":"s1","pick":"a.b[0]"}. expect is optional: nonEmpty, contains or matches.',
    params: { type: 'object', properties: { title: { type: 'string' }, steps: STEPS }, required: ['title', 'steps'], additionalProperties: false },
    risk: 'safe',   // the steps themselves are checked by the tool runner
    timeoutMs: 600000,
    async run({ title, steps } = {}, ctx = {}) {
      const res = await runner.start({ title, steps, turn: ctx.turn, signal: ctx.signal, sessionId: ctx.sessionId });
      return res.text;
    },
  };

  const taskControl = {
    name: 'task_control',
    hint: 'task_control: status, pause, resume, cancel or replan a saved task; id is optional for status. After a failure, replan with new steps (ids s1, s2 in order, max 12) or cancel.',
    description: 'Control a saved task. action: status, pause, resume, cancel or replan. id is the task id (optional for status). replan needs steps [{tool,args,expect?}] to replace the failed step and the rest; refs look like {"$ref":"s1"}.',
    params: { type: 'object', properties: { id: { type: 'string' }, action: { type: 'string', enum: ACTIONS }, steps: STEPS }, required: ['action'], additionalProperties: false },
    risk: 'safe',
    timeoutMs: 600000,
    async run({ id, action, steps } = {}, ctx = {}) {
      const opts = { turn: ctx.turn, signal: ctx.signal, sessionId: ctx.sessionId };
      let res;
      switch (action) {
        case 'status': res = runner.status(id); break;
        case 'pause': res = runner.pause(id); break;
        case 'cancel': res = runner.cancel(id); break;
        case 'resume': res = await runner.resume(id, opts); break;
        case 'replan':
          if (!Array.isArray(steps) || !steps.length) return 'Replan needs steps: the new steps for the failed step and the rest.';
          res = await runner.replan(id, steps, opts);
          break;
        default: return `Unknown action "${action}". Use one of: ${ACTIONS.join(', ')}.`;
      }
      return res.text;
    },
  };

  return [taskRun, taskControl];
}

module.exports = { createTaskTools };
