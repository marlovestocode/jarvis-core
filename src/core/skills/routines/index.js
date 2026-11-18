// Saved routines: only the polite close a running routine uses (routine_close, token-gated). No triggers: no turn
// loads it for the model, and the routines themselves run through the fast path (core/routines/skill.js).
const { createPcTools } = require('../../tools/pc');
const { createRoutineClose } = require('../../routines/close-tool');
const { own } = require('../util');

function createGroup({ pc, media, routines } = {}) {
  if (!pc || !routines?.tokens) return null;
  const helpers = createPcTools({ ...pc, media }).helpers;
  const close = createRoutineClose({ ...helpers, host: pc.host, tokens: routines.tokens });
  return { id: 'routines', label: 'saved routines', triggers: [], tools: [own(close, [], {})] };
}

module.exports = { createGroup };
