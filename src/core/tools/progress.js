'use strict';
// Adaptive tool loop (Phase 2b): a heuristic look at what a round of tool calls achieved, a budget scaled to the request, and the
// test for a deliberate repeat. No model call anywhere here: the note it produces rides the orchestrator's single-shot nudge, so a
// round costs at most one short extra user message. It only advises; exec() stays the one authority on what runs.

const MAX_SAME_SIGNAL = 2;   // the same non-continue signal this many times in a turn: stop calling tools, answer
const NOTE_MAX = 160;
const META = new Set(['find_tools', 'more_skills']);   // how the model asks for tools: their answers say nothing about the task
// "No. 5", "0.5 miles" and "0:45 left" are answers, not "nothing"
const EMPTY = /^(?:(?:no|none|nothing)\b(?!\.? ?\d)|0\b(?![.:,]\d))/i;
const QUOTED = /["“]([^"”]{2,60})["”]/;
const FILE_LIKE = /\b[\w-]+\.\w{2,4}\b/g;
// the user asks for a repeat on purpose; the ledger would otherwise answer "Already done"
const REPEAT_WORDS = /\b(again|another|once more|one more|re-?send|re-?do|repeat)\b/i;

const cap = s => (s.length <= NOTE_MAX ? s : s.slice(0, NOTE_MAX - 1) + '…');
// Notes go to the model as a user message, so they carry NO tool-result text (it is untrusted data): only fixed wording, a tool
// name and the user's own quoted phrase, each flattened to one clean line.
const line = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
const nm = t => line(t, 40) || 'the tool';

// a quoted phrase, else a file-like name whose extension has a letter ("3.14" is a number, not a file)
function entityOf(request) {
  const q = QUOTED.exec(String(request || ''));
  if (q) return q[1].trim();
  return (String(request || '').match(FILE_LIKE) || []).find(t => /[a-z]/i.test(t.split('.').pop())) || null;
}

// history: [{ tool, badArgs } | { signal }] of earlier rounds in this turn
function assess({ request = '', calls = [], results = [], history = [], effectOf = () => 'read' } = {}) {
  const rows = results.map((res, i) => ({ res: res || {}, tool: res?.tool || calls[i]?.name || 'the tool' }));
  const out = (signal, note = null, extra = {}) => ({ signal, note: note === null ? null : cap(note), exclude: [], rediscover: false, ...extra });

  const bad = rows.find(r => r.res.verified === false || r.res.unknown);
  if (bad) return out('verify_failed', `${nm(bad.tool)} could not be confirmed. Say so plainly; do not claim it worked.`);

  const badCount = t => history.filter(h => h.tool === t && h.badArgs).length + rows.filter(r => r.tool === t && r.res.badArgs).length;
  const wrong = [...new Set(rows.filter(r => r.res.rediscover || (r.res.badArgs && badCount(r.tool) >= 2)).map(r => r.tool))];
  if (wrong.length) return out('wrong_tool', `${nm(wrong[0])} does not fit this request. Look for another tool (find_tools) or tell the user.`, { exclude: wrong, rediscover: true });

  const err = rows.find(r => r.res.ok === false && !r.res.badArgs);
  if (err) return out('error', `${nm(err.tool)} failed. Use another approach or tell the user; do not say it worked.`);

  if (rows.some(r => r.res.ledger)) return out('repeat', 'You already have that result; answer with it or do something different.');

  const real = rows.filter(r => !META.has(r.tool) && r.res.ok);
  // only a read can "find nothing": a write that answered with nothing simply did its job
  const empty = real.find(r => { const t = String(r.res.text ?? '').trim(); return effectOf(r.tool) === 'read' && (!t || EMPTY.test(t)); });
  if (empty) return out('empty', `${nm(empty.tool)} found nothing. Try other words or another tool (find_tools), or tell the user nothing was found.`, { rediscover: true });

  if (real.length && !history.some(h => h.signal === 'missing_entity')) {
    const x = entityOf(request);
    if (x && !real.some(r => String(r.res.text ?? '').toLowerCase().includes(x.toLowerCase()))) {
      return out('missing_entity', `The results do not mention "${line(x, 40)}". Check them, or search differently.`);
    }
  }
  return out('continue');
}

// rounds: a lookup or a simple command needs few; a request that asks for several things gets more room.
// tokenCap: stop adding rounds once the prompt plus the answers use this much of the context window.
function budgetFor({ steps = 1, simple = false, maxToolRounds = 5, contextMax = 0 } = {}) {
  const rounds = simple || steps <= 1 ? Math.min(3, maxToolRounds) : steps >= 3 ? maxToolRounds + 2 : maxToolRounds;
  return { rounds, tokenCap: contextMax ? Math.floor(contextMax * 0.8) : Infinity };
}

// "send it again" is a new action on purpose; a follow-up that merely mentions it, or a question about it, is not
function isDeliberateRepeat({ text, intent, fu } = {}) {
  if (!REPEAT_WORDS.test(String(text || ''))) return false;
  return !intent || intent.kind === 'modify' || intent.kind === 'new' || fu?.kind === 'continue';
}

// `intelligence: false` switches every piece off, which reproduces the loop as it was before Phase 2b (the eval baseline).
// Each piece can also be switched off alone: index, parallel, recover (retry/repair/verify), adaptive (round notes), needTool, budget, repeat, disambiguate.
const OFF = { index: false, parallel: false, recover: false, adaptive: false, needTool: false, budget: false, repeat: false, disambiguate: false };

// The two best tools score within 10% of each other and both act on the world: the only case worth one model question.
// found: [{ name, score }] best first. -> [name, name] | null
function closeRivals(found, effectOf) {
  const [a, b] = found || [];
  if (!a || !b || !(a.score > 0) || b.score < a.score * 0.9) return null;
  const acts = n => { const e = effectOf(n); return e === 'write' || e === 'external'; };
  return acts(a.name) && acts(b.name) ? [a.name, b.name] : null;
}

// One turn's loop state: remembers earlier rounds, the excluded tools, and how often each signal fired.
function createProgress({ request = '', effectOf } = {}) {
  const history = [], counts = new Map(), excluded = new Set();
  return {
    excluded,
    step({ calls = [], results = [] }) {
      const a = assess({ request, calls, results, history, ...(effectOf ? { effectOf } : {}) });
      results.forEach((r, i) => history.push({ tool: r?.tool || calls[i]?.name, badArgs: !!r?.badArgs }));
      history.push({ signal: a.signal });
      for (const t of a.exclude) excluded.add(t);
      let stop = false;
      if (a.signal !== 'continue' && a.signal !== 'error') {   // plain errors have their own per-tool limit (FAIL_LIMIT): a different action may still work
        const n = (counts.get(a.signal) || 0) + 1;
        counts.set(a.signal, n);
        stop = n >= MAX_SAME_SIGNAL;
      }
      return { ...a, stop };
    },
  };
}

module.exports = { assess, budgetFor, isDeliberateRepeat, createProgress, closeRivals, OFF, MAX_SAME_SIGNAL, REPEAT_WORDS };
