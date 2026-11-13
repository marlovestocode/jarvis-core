// The gate every tool call passes before its code runs: the arguments must fit the tool's own parameter schema.
// A model sometimes sends "5" for a number, "true" for a boolean, an enum value that does not exist, or leaves out a required
// argument. Harmless mismatches are fixed here ("5" → 5); anything else is refused with a plain message the model can act on,
// and the tool does not run. Arguments the schema does not list are kept (some tools read optional extras).
// checkArgs(tool, args) → { ok: true, args } | { ok: false, text }
const { validateArgs } = require('./constrain');

function coerce(schema, args) {
  const props = schema?.properties || {};
  const out = { ...args };
  for (const [k, v] of Object.entries(out)) {
    const p = props[k];
    if (!p || typeof v !== 'string') continue;
    const types = [].concat(p.type || []);
    const t = v.trim();
    if ((types.includes('number') || types.includes('integer')) && !types.includes('string') && t !== '' && Number.isFinite(Number(t))) out[k] = Number(t);
    else if (types.includes('boolean') && !types.includes('string') && /^(?:true|false)$/i.test(t)) out[k] = t.toLowerCase() === 'true';
    else if (p.enum && !p.enum.includes(v) && p.enum.includes(t.toLowerCase())) out[k] = t.toLowerCase();   // "Pause" → "pause"
  }
  return out;
}

function describe(schema) {
  const props = schema?.properties || {};
  const req = new Set(schema?.required || []);
  return Object.entries(props).map(([k, p]) => `${k} (${[].concat(p.type || 'any').join('|')}${p.enum ? `: ${p.enum.join(', ')}` : ''}${req.has(k) ? ', required' : ''})`).join('; ');
}

function checkArgs(tool, args) {
  const schema = tool.params;
  if (!schema || typeof schema !== 'object') return { ok: true, args: args ?? {} };
  const given = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : (args == null ? {} : null);
  if (given === null) return { ok: false, text: `Error: ${tool.name} was not run: its arguments must be an object. It takes: ${describe(schema) || 'nothing'}. Call it again with arguments that fit, or ask the user what is missing.` };
  const fixed = coerce(schema, given);
  const v = validateArgs(schema, fixed);
  if (v.ok) return { ok: true, args: fixed };
  return { ok: false, text: `Error: ${tool.name} was not run: ${v.problems.join('; ')}. It takes: ${describe(schema) || 'nothing'}. Call it again with arguments that fit, or ask the user for what is missing; do not say it was done.` };
}

module.exports = { checkArgs, coerce };
