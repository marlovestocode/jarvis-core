const { timeTool } = require('../../tools/time');
const { createStatusTool } = require('../../tools/skills');
const { own } = require('../util');

// Loads another skill group for the rest of the turn. ctx.skills is set by the per-turn runner (tools/registry.js).
const moreSkills = {
  name: 'more_skills',
  hint: 'more_skills: load another skill group when your tools do not cover the request; groups are listed under Capabilities.',
  description: 'Load another skill group when your tools do not cover the request. Groups are listed under Capabilities.',
  params: { type: 'object', properties: { group: { type: 'string', description: 'group id, e.g. pc, media, math' } }, required: ['group'], additionalProperties: false },
  risk: 'safe',
  async run({ group } = {}, ctx = {}) {
    if (!ctx.skills?.load) return 'All skills are already available.';
    const r = ctx.skills.load(group);
    if (!r.ok) throw new Error(r.text);
    return r.text;
  },
};

// Finds the tools that fit a request across every group, loads what they need and offers them for the rest of the turn.
// It only offers: running a tool is still checked by the runner (risk, taint, guest allowlist). Costs one more_skills unit.
const findTools = {
  name: 'find_tools',
  hint: 'find_tools: when none of your tools fits, describe what you need in a few words; it offers the tools that can do it.',
  description: 'Find the tools that can do something when none of your tools fits. Describe the need in a few words.',
  params: { type: 'object', properties: { query: { type: 'string', description: 'what you need to do, e.g. rename a file' } }, required: ['query'], additionalProperties: false },
  risk: 'safe',
  effect: 'read',
  idempotent: true,
  async run({ query } = {}, ctx = {}) {
    if (!ctx.skills?.find) return 'All tools are already available.';
    return ctx.skills.find(query, ctx);
  },
};

// tasks: the task_run and task_control tools (tools/tasks.js), when the app keeps a task runner
function createGroup({ getStatus, tasks } = {}) {
  const tools = [own(timeTool, ['time'])];
  if (getStatus) tools.push(own(createStatusTool({ getStatus })));
  if (Array.isArray(tasks)) for (const t of tasks) tools.push(own(t));
  tools.push(own(moreSkills));
  tools.push(own(findTools));
  return { id: 'core', label: 'Time and JARVIS status', triggers: [], tools };
}

module.exports = { createGroup };
