const { skillTools } = require('../../tools/skills');
const { MATH, SCIENCE, UNITS, DATES } = require('../../brain/router');
const { own } = require('../util');

// the router's MATH matches "comput" as in "computer"; "restart the computer" is not a math request
const mathText = { test: t => MATH.test(String(t).replace(/\bcomputers?\b/gi, ' ')) };

function createGroup() {
  return { id: 'math', label: 'Math, units, dates, science constants', triggers: [
    { re: mathText, w: 3 }, { re: SCIENCE, w: 3 }, { re: UNITS, w: 3 }, { re: DATES, w: 3 },
  ], tools: skillTools().map(t => own(t)) };
}

module.exports = { createGroup };
