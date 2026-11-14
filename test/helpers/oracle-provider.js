'use strict';
// A scripted stand-in for the model's tool CHOICES, so the loop (discovery, recovery, duplicates, partial failure, refusals)
// can be measured in CI. It follows a policy built from the fixture row; it measures the pipeline, never LLM quality.
// Policy per chat(): call the next wanted tool that is offered; else find_tools once (query = the request); else more_skills
// for the tool's group (what a model does with today's loop); else say so. Seeded noise adds a wrong tool name, junk
// arguments or a repeated call.
const { oracleAnswer } = require('../../scripts/intelligence-eval-model');

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const names = e => (typeof e === 'string' ? [e] : e.oneOf);
const FAILED = /^Error|not allowed|only do that|cannot|can't|refus/i;
const GAVE_UP = /not connected|unavailable|not allowed|only do that|not running|already failed/i;
const sleep = ms => (ms ? new Promise(r => setTimeout(r, ms)) : null);

// groupOf(toolName) -> group id, for the more_skills step; delayMs: the fake model latency of every call
// a value that fits the property's schema: the model reads the request, the oracle only has to satisfy validation
function fill(p, text) {
  if (p?.enum?.length) return p.enum[0];
  if (p?.type === 'number' || p?.type === 'integer') return 1;
  if (p?.type === 'boolean') return true;
  if (p?.type === 'array') return [String(text).slice(0, 40)];
  return String(text).slice(0, 40);
}

function createOracleProvider({ noise = 0, seed = 1, delayMs = 0, groupOf = () => null, ids = [] } = {}) {
  const r = rng(seed);
  const calls = [], constrained = [];
  const st = { row: null, intended: null, noiseHits: 0 };

  // what this turn's tool messages say: the session replays earlier turns too, so only the part after the last user message counts
  function turnResults(messages) {
    // the loop adds its own status notes as user messages, so the turn starts at the user's request text, not at the last user message
    let i = messages.length - 1;
    while (i >= 0 && !(messages[i].role === 'user' && String(messages[i].content).startsWith(st.row.text))) i--;
    if (i < 0) i = messages.length - 1;
    const out = new Map(), tries = new Map();
    for (const m of messages.slice(i + 1)) {
      if (m.role !== 'tool' || !m.name) continue;
      tries.set(m.name, (tries.get(m.name) || 0) + 1);
      out.set(m.name, { ok: !FAILED.test(String(m.content)) || /^Already done/i.test(String(m.content)), text: String(m.content), final: GAVE_UP.test(String(m.content)) });
    }
    return { out, tries };
  }

  function argsFor(spec, row, first) {
    // a model puts the request into the first free-text argument too, so two different requests never share a call signature
    const props = spec?.params?.properties || {};
    const free = Object.keys(props).find(k => props[k].type === 'string' && !props[k].enum);
    const req = [...new Set([...(spec?.params?.required || []), ...(free ? [free] : [])])];
    const faulty = (row.faults?.[spec?.name] || []).includes('badargs') && first;
    const a = {};
    if (!faulty) for (const k of req) a[k] = fill(spec.params.properties?.[k], row.text);
    return a;
  }

  function decide(messages, tools) {
    const row = st.row, w = row.want || {};
    const { out, tries } = turnResults(messages);
    const offered = new Map((tools || []).map(t => [t.name, t]));
    const wanted = (w.tools || []).map(e => names(e).find(n => offered.has(n)) || names(e)[0]);
    const done = n => out.get(n)?.ok;
    const over = n => out.get(n) && (out.get(n).final || (!out.get(n).ok && tries.get(n) >= 2));
    const calls_ = [];
    const call = n => calls_.push({ name: n, args: argsFor(offered.get(n), row, !tries.get(n)) });
    // a model that first reaches for a plausible but wrong tool (the row says which one)
    const wrong = Object.keys(row.faults || {}).find(n => row.faults[n].includes('wrongpick') && offered.has(n) && !tries.get(n));
    if (wrong) { call(wrong); return { calls: calls_ }; }
    const pending = wanted.filter(n => !done(n) && !over(n));
    // a failed (not final) tool is retried by the model once; the same call may be refused by the loop, which is the point
    let ready = pending.filter(n => offered.has(n));
    if (w.order === 'seq') ready = pending.length && offered.has(pending[0]) ? [pending[0]] : [];
    else if (!w.parallel) ready = ready.slice(0, 1);
    if (ready.length) { for (const n of ready) call(n); return { calls: calls_ }; }
    if (pending.length) {
      const q = String(row.text);
      if (offered.has('find_tools') && !tries.get('find_tools')) return { calls: [{ name: 'find_tools', args: { query: q } }] };
      const g = groupOf(pending[0]);
      if (g && offered.has('more_skills') && !tries.get('more_skills')) return { calls: [{ name: 'more_skills', args: { group: g } }] };
    }
    // a duplicate: the model sends a write it already made once more
    const dup = Object.keys(row.faults || {}).find(n => row.faults[n].includes('repeat') && done(n) && tries.get(n) === 1);
    if (dup && offered.has(dup)) { call(dup); return { calls: calls_ }; }
    const ok = wanted.filter(done), bad = wanted.filter(n => !done(n));
    if (!wanted.length) return { text: /^(?:decline)$/.test(w.outcome) ? 'I cannot do that.' : 'Done.' };
    if (bad.length) return { text: `${ok.length ? `Done: ${ok.join(', ')}. ` : ''}I could not do ${bad.join(', ')} (${(out.get(bad[0])?.text || 'not available').slice(0, 60)}).` };
    return { text: 'Done.' };
  }

  function noisy(d, tools) {
    if (!d.calls?.length || r() >= noise) return d;
    st.noiseHits++;
    const kind = ['wrongname', 'junk', 'repeat'][Math.floor(r() * 3)];
    const c = d.calls[0];
    if (kind === 'wrongname') return { calls: [{ name: `${c.name}_now`, args: c.args }, ...d.calls.slice(1)] };
    if (kind === 'junk') return { calls: [{ name: c.name, args: { ...c.args, bogus: 1 } }, ...d.calls.slice(1)] };
    return { calls: [...d.calls, { ...c }] };
  }

  return {
    id: 'oracle', label: 'Oracle', capabilities: { tools: true, logprobs: false, reasoning: false },
    calls, constrained, state: st,
    async status() { return { ready: true, detail: 'oracle' }; },
    async *chat({ messages, tools, signal, hints }) {
      calls.push({ messages: messages.map(m => ({ ...m })), tools, hints });
      await sleep(delayMs);
      if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const d = noisy(decide(messages, tools), tools);
      st.intended = (st.row.want?.tools || []).flatMap(names);
      if (d.calls) {
        for (const [i, c] of d.calls.entries()) {
          yield { type: 'tool_call', id: `o${calls.length}_${i}`, name: c.name, args: c.args };
        }
      } else yield { type: 'token', text: d.text };
      yield { type: 'done' };
    },
    // the group-intent question, the tool repair question and the argument repair question, answered the way a reader of the row would
    async constrain(req) {
      constrained.push(req);
      await sleep(delayMs);
      const props = req.schema?.properties || {};
      const row = st.row;
      if (props.groups) {
        const want = (row.want?.tools || []).flatMap(names);
        const act = [...new Set(want.map(groupOf).filter(Boolean))];
        const out = row.want?.outcome === 'decline' ? 'decline' : { act };
        return oracleAnswer({ ...row, expect: out, lastGroups: [] }, ids);
      }
      if (props.tool) {
        const pick = st.intended.find(n => props.tool.enum.includes(n));
        return { tool: pick || 'none' };
      }
      const a = {};
      for (const k of req.schema?.required || []) a[k] = fill(props[k], row.text);
      return a;
    },
  };
}

module.exports = { createOracleProvider };
