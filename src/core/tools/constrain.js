// Constrained tool calls: validate what the model asked for, and when it is wrong, repair it with a decode the model cannot get wrong.
// A small model writes a tool call freely: it can name a tool that does not exist, or leave out or misspell an argument. Telling it
// afterwards in an error message does not reliably fix it. So when a call fails these checks, one short follow-up is decoded under
// a JSON schema (Ollama structured output, a grammar the sampler must follow):
//   1. the name:      {"tool": <one of the tools in scope, or "none">}      only when the name is not a tool, alias or group
//   2. the arguments: the tool's own parameter schema                        only when the arguments do not fit it
// Nothing changes for a call that is already valid: no extra model call, no extra latency. A tool that exists is never swapped for
// another one; only an unknown name is replaced, and "none" leaves it alone (the runner then says so, as before).

const typeOk = (t, v) => {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    default: return true;
  }
};

// The parts of JSON schema the tools use: type, enum, required, properties (one level of items). Extra properties are dropped
// (a made-up argument is noise, not a reason to fail). → { ok, args, problems }
function validateArgs(schema, args) {
  const problems = [];
  const given = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (args !== undefined && args !== null && given !== args) problems.push('arguments must be an object');
  const props = schema?.properties || {};
  const clean = {};
  for (const [k, v] of Object.entries(given)) {
    const p = props[k];
    if (!p) { if (Object.keys(props).length === 0) clean[k] = v; continue; }   // a tool that declares properties drops the ones it does not know
    const types = [].concat(p.type || []);
    if (types.length && !types.some(t => typeOk(t, v))) problems.push(`${k} should be ${types.join(' or ')}`);
    else if (p.enum && !p.enum.includes(v)) problems.push(`${k} must be one of ${p.enum.join(', ')}`);
    else if (p.type === 'array' && p.items?.type && Array.isArray(v) && !v.every(x => typeOk(p.items.type, x))) problems.push(`${k} has items of the wrong type`);
    clean[k] = v;
  }
  for (const r of schema?.required || []) if (!(r in given) || given[r] === undefined || given[r] === null || given[r] === '') problems.push(`${r} is required`);
  return { ok: problems.length === 0, args: clean, problems };
}

const firstSentence = (s, n = 110) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); const i = t.search(/[.!?](\s|$)/); const cut = i > 0 && i < n ? t.slice(0, i) : t.slice(0, n); return cut; };

// call: { name, args }; specs: the tools in scope ({ name, description, params }); resolves(name): true when the runner can act on
// the name anyway (an alias, a known mistake, a skill group). provider.constrain({ messages, schema, signal, hints }) → object | null.
// → { name, args, how: ['name'?, 'args'?] } when it changed something, else null. Never throws.
async function repairCall({ provider, window, call, specs, resolves = () => false, signal, hints, log = () => {} }) {
  try {
    if (!provider?.constrain || !specs?.length) return null;
    const byName = new Map(specs.map(s => [s.name, s]));
    let name = call.name, how = [];

    if (!byName.has(name) && !resolves(name)) {
      const list = specs.map(s => `- ${s.name}: ${firstSentence(s.description)}`).join('\n');
      const out = await provider.constrain({
        messages: [...window, { role: 'user', content: `You tried to call "${name}", which is not a tool. Choose the tool you meant from this list for the user's request, or "none" if none of them fits.\n${list}` }],
        schema: { type: 'object', properties: { tool: { type: 'string', enum: [...specs.map(s => s.name), 'none'] } }, required: ['tool'], additionalProperties: false },
        signal, hints,
      });
      const pick = out && typeof out.tool === 'string' ? out.tool : 'none';
      if (!byName.has(pick)) return null;
      name = pick; how.push('name');
    }

    const spec = byName.get(name);
    let args = call.args;
    if (spec) {
      const v = validateArgs(spec.params, args);
      if (!v.ok) {
        const out = await provider.constrain({
          messages: [...window, { role: 'user', content: `Call ${name} for the user's request. Give only its arguments, as JSON. (${v.problems.join('; ')}.)` }],
          schema: spec.params, signal, hints,
        });
        const fixed = out && typeof out === 'object' ? validateArgs(spec.params, out) : null;
        if (fixed?.ok) { args = fixed.args; how.push('args'); }
      } else if (JSON.stringify(v.args) !== JSON.stringify(args ?? {})) {
        args = v.args;   // only made-up extra arguments were dropped: no model call needed
      }
    }
    if (!how.length) return args === call.args ? null : { name, args, how: ['tidy'] };
    log(`Repaired tool call ${call.name} → ${name} (${how.join(' + ')})`);
    return { name, args: args ?? {}, how };
  } catch (err) {
    log(`Tool repair failed, leaving the call as it was: ${err?.message || err}`);
    return null;
  }
}

module.exports = { validateArgs, repairCall, firstSentence };
