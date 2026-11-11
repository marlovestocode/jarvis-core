const { skillTools } = require('../../tools/skills');
const { own } = require('../util');

function createGroup() {
  return { id: 'math', label: 'Math, units, dates, science constants', triggers: [], tools: skillTools().map(t => own(t)) };
}

module.exports = { createGroup };
