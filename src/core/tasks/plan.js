'use strict';
// Pure plan logic for the persistent task runner: validation, whole-value reference resolution, expect checks.
const { softFail } = require('../brain/guard');

const MAX_STEPS = 12;
const EXPECT_KEYS = ['nonEmpty', 'contains', 'matches'];
const TASK_TOOLS = new Set(['task_run', 'task_control']);   // a task cannot start or steer tasks

const isRef = v => v && typeof v === 'object' && !Array.isArray(v) && typeof v.$ref === 'string';

// Calls fn(ref) for every whole-value ref nested anywhere in args.
function eachRef(v, fn) {
  if (isRef(v)) fn(v);
  else if (Array.isArray(v)) v.forEach(x => eachRef(x, fn));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => eachRef(x, fn));
}

function parseRegex(src) {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(src);
  return m ? new RegExp(m[1], m[2]) : null;
}

function validatePlan(steps, { resolves, riskOf, tainted } = {}) {
  if (!Array.isArray(steps) || !steps.length) return { ok: false, text: 'Plan needs at least one step: [{ tool, args?, expect? }].' };
  if (steps.length > MAX_STEPS) return { ok: false, text: `Plan has ${steps.length} steps; the limit is ${MAX_STEPS}. Split it into smaller tasks.` };
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const id = `s${i + 1}`;
    const s = steps[i];
    if (!s || typeof s !== 'object' || typeof s.tool !== 'string' || !s.tool) return { ok: false, text: `Step ${id} needs a "tool" name.` };
    if (TASK_TOOLS.has(s.tool)) return { ok: false, text: `Step ${id} uses "${s.tool}": a task cannot start or control another task. Put the steps in this plan instead.` };
    if (!resolves(s.tool)) return { ok: false, text: `Step ${id} uses unknown tool "${s.tool}". Use only tools you have.` };
    if (tainted && riskOf(s.tool) === 'confirm') return { ok: false, text: `Step ${id} uses "${s.tool}", which needs the user's OK, and this plan was influenced by untrusted content. Do that action directly with the user instead.` };
    if (s.args != null && (typeof s.args !== 'object' || Array.isArray(s.args))) return { ok: false, text: `Step ${id} args must be an object.` };
    const args = s.args ?? {};
    let refErr = null;
    eachRef(args, r => {
      if (refErr) return;
      const n = /^s(\d+)$/.exec(r.$ref);
      if (!n || Number(n[1]) >= i + 1 || Number(n[1]) < 1) refErr = `Step ${id} refers to "${r.$ref}", which is not an earlier step. A ref must name a step before it (s1..s${i}).`;
      else if (r.pick != null && typeof r.pick !== 'string') refErr = `Step ${id} has a ref to ${r.$ref} whose "pick" is not a string.`;
      else if (typeof r.pick === 'string' && r.pick.startsWith('/')) {
        try { if (!parseRegex(r.pick)) throw new Error(); } catch { refErr = `Step ${id} has an invalid regex pick "${r.pick}" on ${r.$ref}. Use /pattern/flags.`; }
      }
    });
    if (refErr) return { ok: false, text: refErr };
    if (s.expect !== undefined) {
      const e = s.expect;
      if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, text: `Step ${id} expect must be an object with exactly one of ${EXPECT_KEYS.join(', ')}.` };
      const keys = Object.keys(e);
      const unknown = keys.find(k => !EXPECT_KEYS.includes(k));
      if (unknown) return { ok: false, text: `Step ${id} expect has unknown key "${unknown}". Use exactly one of ${EXPECT_KEYS.join(', ')}.` };
      if (keys.length !== 1) return { ok: false, text: `Step ${id} expect must have exactly one of ${EXPECT_KEYS.join(', ')}, got ${keys.length}.` };
      if (e.matches !== undefined) {
        try { new RegExp(e.matches); } catch { return { ok: false, text: `Step ${id} expect.matches is not a valid regex: ${e.matches}` }; }
      }
    }
    out.push({ id, tool: s.tool, args, expect: s.expect, status: 'pending', attempts: 0, result: null });
  }
  return { ok: true, steps: out };
}

function pickValue(id, text, pick) {
  if (pick.startsWith('/')) {
    const re = parseRegex(pick);
    const m = re && re.exec(text);
    if (!m) return { ok: false, text: `Step ${id}: pick ${pick} matched nothing in its result. Check the result format and adjust the pick.` };
    return { ok: true, value: m[1] !== undefined ? m[1] : m[0] };
  }
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, text: `Step ${id}: pick "${pick}" needs JSON, but its result is not JSON. Use a /regex/ pick or no pick.` }; }
  const parts = pick.match(/[^.[\]]+/g) || [];
  for (const p of parts) {
    if (data == null || typeof data !== 'object' || !(p in Object(data))) return { ok: false, text: `Step ${id}: pick "${pick}" found nothing at "${p}" in its JSON result.` };
    data = data[p];
  }
  if (data === undefined) return { ok: false, text: `Step ${id}: pick "${pick}" found nothing in its JSON result.` };
  return { ok: true, value: typeof data === 'string' ? data : JSON.stringify(data) };
}

function resolveRefs(args, results) {
  let err = null;
  const walk = v => {
    if (err) return v;
    if (isRef(v)) {
      if (!results.has(v.$ref)) { err = { ok: false, text: `Step ${v.$ref} has no result yet, so it cannot be referenced.` }; return v; }
      const text = String(results.get(v.$ref));
      if (v.pick == null) return text;
      const p = pickValue(v.$ref, text, String(v.pick));
      if (!p.ok) { err = p; return v; }
      return p.value;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const resolved = walk(args);
  return err || { ok: true, args: resolved };
}

function check(expect, result) {
  const text = String(result?.text ?? '');
  if (!expect) {
    if (!result?.ok) return { ok: false, why: `the tool reported an error: ${text.slice(0, 200)}` };
    if (softFail(text)) return { ok: false, why: `the tool said it did nothing: ${text.slice(0, 200)}` };
    return { ok: true };
  }
  if (expect.nonEmpty) return text.trim() ? { ok: true } : { ok: false, why: 'the result was empty' };
  if (expect.contains !== undefined) {
    return text.toLowerCase().includes(String(expect.contains).toLowerCase()) ? { ok: true } : { ok: false, why: `the result did not contain "${expect.contains}"` };
  }
  if (expect.matches !== undefined) {
    let re;
    try { re = new RegExp(expect.matches); } catch { return { ok: false, why: `expect.matches is not a valid regex: ${expect.matches}` }; }
    return re.test(text) ? { ok: true } : { ok: false, why: `the result did not match /${expect.matches}/` };
  }
  return { ok: false, why: 'expect has no nonEmpty, contains or matches' };
}

module.exports = { MAX_STEPS, validatePlan, resolveRefs, check };
