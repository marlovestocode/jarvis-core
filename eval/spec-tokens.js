// Tool-spec size per deep turn: flat list of today against the skill groups selected for the golden utterances.
//   node eval/spec-tokens.js
// (chars are JSON characters of { name, description, params }; roughly 3-4 chars per token)
const { measureSpecs } = require('../test/helpers/spec-size');

const m = measureSpecs();
console.log(`flat baseline:        ${m.baseline} chars, ${m.baselineTools} tools (pre-migration manifest)`);
console.log(`selected (mean):      ${Math.round(m.meanChars)} chars over ${m.turns} deep golden turns`);
console.log(`reduction:            ${(100 * m.reduction).toFixed(1)}%`);
console.log(`tools loaded (mean):  ${m.meanTools.toFixed(1)}`);
