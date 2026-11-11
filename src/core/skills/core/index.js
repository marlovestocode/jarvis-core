const { timeTool } = require('../../tools/time');
const { createStatusTool } = require('../../tools/skills');
const { own } = require('../util');

// Loads another skill group for the rest of the turn. ctx.skills is set by the per-turn runner (tools/registry.js).
const moreSkills = {
  name: 'more_skills',
  description: 'Load another skill group when your tools do not cover the request. Groups are listed under Capabilities.',
  params: { type: 'object', properties: { group: { type: 'string', description: 'group id, e.g. pc, media, math' } }, required: ['group'], additionalProperties: false },
  risk: 'safe',
  async run({ group } = {}, ctx = {}) {
    if (!ctx.skills) return 'All skills are already available.';
    const r = ctx.skills.load(group);
    if (!r.ok) throw new Error(r.text);
    return r.text;
  },
};

function createGroup({ getStatus } = {}) {
  const tools = [own(timeTool, ['time'])];
  if (getStatus) tools.push(own(createStatusTool({ getStatus })));
  tools.push(own(moreSkills));
  return { id: 'core', label: 'Time and JARVIS status', triggers: [], tools };
}

module.exports = { createGroup };
