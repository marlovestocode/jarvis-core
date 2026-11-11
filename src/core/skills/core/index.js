const { timeTool } = require('../../tools/time');
const { createStatusTool } = require('../../tools/skills');
const { own } = require('../util');

function createGroup({ getStatus } = {}) {
  const tools = [own(timeTool, ['time'])];
  if (getStatus) tools.push(own(createStatusTool({ getStatus })));
  return { id: 'core', label: 'Time and JARVIS status', triggers: [], tools };
}

module.exports = { createGroup };
