// Heuristic round assessment, scaled budgets, deliberate-repeat detection, constrained disambiguation, recovery regex edges.
const test = require('node:test');
const assert = require('node:assert/strict');
const { assess, budgetFor, isDeliberateRepeat, createProgress, MAX_SAME_SIGNAL } = require('../src/core/tools/progress');
const { createToolIndex } = require('../src/core/skills/toolindex');
const { classify } = require('../src/core/tools/recover');

const one = (res, name = 'search_files', extra = {}) => assess({ request: 'find my notes', calls: [{ name }], results: [res], history: [], ...extra });

test('empty result -> empty signal with rediscovery', () => {
  const a = one({ ok: true, text: '' });
  assert.equal(a.signal, 'empty');
  assert.equal(a.rediscover, true);
  assert.equal(a.note, 'search_files found nothing. Try other words or another tool (find_tools), or tell the user nothing was found.');
  assert.equal(one({ ok: true, text: 'No files match' }).signal, 'empty');
  assert.equal(one({ ok: true, text: 'Nothing today' }).signal, 'empty');
  assert.equal(one({ ok: true, text: 'Nobody home but notes' }).signal, 'continue');   // \b: "Nobody" is not "no"
});

test('error, repeat, verify_failed, wrong_tool carry the exact notes', () => {
  const e = one({ ok: false, text: 'Error: disk is full' });
  assert.equal(e.signal, 'error');
  assert.equal(e.note, 'search_files failed: Error: disk is full. Use another approach or tell the user; do not say it worked.');
  assert.equal(one({ ok: false, badArgs: true, text: 'Error: bad' }).signal, 'continue');
  const r = one({ ok: true, text: 'Already done (3s ago): sent', ledger: 'done', skipped: true });
  assert.equal(r.signal, 'repeat');
  assert.equal(r.note, 'You already have that result; answer with it or do something different.');
  assert.equal(one({ ok: true, text: 'sent (I could not confirm it)', verified: false }).signal, 'verify_failed');
  assert.equal(one({ ok: false, unknown: true, text: 'Error: timed out' }).signal, 'verify_failed');
  const w = one({ ok: false, text: 'Error: not connected', rediscover: true, tool: 'browser_open' });
  assert.equal(w.signal, 'wrong_tool');
  assert.deepEqual(w.exclude, ['browser_open']);
  assert.equal(w.rediscover, true);
});

test('badArgs twice for the same tool is wrong_tool', () => {
  const history = [{ tool: 'search_files', badArgs: true }];
  const a = one({ ok: false, badArgs: true, text: 'Error: bad' }, 'search_files', { history });
  assert.equal(a.signal, 'wrong_tool');
  assert.deepEqual(a.exclude, ['search_files']);
  assert.equal(a.rediscover, true);
});

test('priority: verify_failed beats error and empty', () => {
  const a = assess({ request: 'x', calls: [{ name: 'a' }, { name: 'b' }], results: [{ ok: true, text: '' }, { ok: true, verified: false, text: 'x' }], history: [] });
  assert.equal(a.signal, 'verify_failed');
});

test('missing_entity: a quoted phrase or file name no result mentions, once per turn', () => {
  const req = { request: 'open "budget.xlsx" please', calls: [{ name: 'list_files' }], results: [{ ok: true, text: 'report.pdf\nnotes.txt' }] };
  const a = assess({ ...req, history: [] });
  assert.equal(a.signal, 'missing_entity');
  assert.equal(a.note, 'The results do not mention "budget.xlsx". Check them, or search differently.');
  assert.equal(assess({ ...req, history: [{ signal: 'missing_entity' }] }).signal, 'continue');
  assert.equal(assess({ ...req, results: [{ ok: true, text: 'budget.xlsx 12KB' }], history: [] }).signal, 'continue');
  assert.equal(assess({ request: 'it is 3.14 or so', calls: [{ name: 't' }], results: [{ ok: true, text: 'abc' }], history: [] }).signal, 'continue');   // a number is not a file
});

test('plain success is continue with no note; notes stay short', () => {
  const a = one({ ok: true, text: 'found 3 notes' });
  assert.deepEqual([a.signal, a.note, a.rediscover], ['continue', null, false]);
  const long = 'x'.repeat(500);
  for (const res of [{ ok: false, text: long }, { ok: true, text: '' }, { ok: true, verified: false, text: 'a' }, { ok: false, rediscover: true, tool: 't'.repeat(200), text: 'e' }]) {
    const n = one(res, 'n'.repeat(100)).note;
    assert.ok(n.length <= 160, n.length);
  }
});

test('createProgress: the same non-continue signal twice stops the loop', () => {
  assert.equal(MAX_SAME_SIGNAL, 2);
  const p = createProgress({ request: 'find my notes' });
  const round = { calls: [{ name: 's' }], results: [{ ok: true, text: '' }] };
  assert.equal(p.step(round).stop, false);
  assert.equal(p.step({ calls: [{ name: 's' }], results: [{ ok: true, text: 'fine' }] }).stop, false);
  assert.equal(p.step(round).stop, true);
});

test('createProgress: a plain error twice does not stop (FAIL_LIMIT handles it per tool)', () => {
  const p = createProgress({ request: 'x' });
  const round = { calls: [{ name: 's' }], results: [{ ok: false, text: 'Error: nope' }] };
  assert.equal(p.step(round).stop, false);
  assert.equal(p.step(round).stop, false);
});

test('budgetFor', () => {
  assert.equal(budgetFor({ steps: 1 }).rounds, 3);
  assert.equal(budgetFor({ steps: 2 }).rounds, 5);
  assert.equal(budgetFor({ steps: 3 }).rounds, 7);
  assert.equal(budgetFor({ steps: 3, simple: true }).rounds, 3);
  assert.equal(budgetFor({ steps: 1, maxToolRounds: 2 }).rounds, 2);
  assert.equal(budgetFor({ steps: 1, contextMax: 8000 }).tokenCap, 6400);
  assert.equal(budgetFor({ steps: 1 }).tokenCap, Infinity);
});

test('isDeliberateRepeat', () => {
  assert.equal(isDeliberateRepeat({ text: 'send it again' }), true);
  assert.equal(isDeliberateRepeat({ text: 'send it again', intent: { kind: 'followup' } }), false);
  assert.equal(isDeliberateRepeat({ text: 'send it' }), false);
  assert.equal(isDeliberateRepeat({ text: 'add another', intent: { kind: 'new' } }), true);
  assert.equal(isDeliberateRepeat({ text: 'once more', intent: { kind: 'followup' }, fu: { kind: 'continue' } }), true);
  assert.equal(isDeliberateRepeat({ text: 'send it again', intent: { kind: 'modify' } }), true);
});

test('disambiguate: one constrained call, a candidate name or null', async () => {
  const idx = createToolIndex({ catalog: { toolCardsNow: async () => new Map(), byName: new Map() } });
  const reqs = [];
  const prov = out => ({ async constrain(req) { reqs.push(req); return out; } });
  const cands = [{ name: 'send_email', summary: 'Send an email' }, { name: 'send_sms', summary: 'Send a text' }];
  assert.equal(await idx.disambiguate({ provider: prov({ tool: 'send_sms' }), text: 'send it', candidates: cands }), 'send_sms');
  assert.deepEqual(reqs[0].schema.properties.tool.enum, ['send_email', 'send_sms', 'none']);
  assert.equal(await idx.disambiguate({ provider: prov({ tool: 'none' }), text: 'x', candidates: cands }), null);
  assert.equal(await idx.disambiguate({ provider: prov({ tool: 'invented' }), text: 'x', candidates: cands }), null);
  assert.equal(await idx.disambiguate({ provider: {}, text: 'x', candidates: cands }), null);
  assert.equal(reqs.length, 3);
});

test('recover: bare "extension" and "busy" are not failure classes', () => {
  assert.equal(classify({ ok: false, text: 'Error: unsupported file extension .xyz' }), 'fatal');
  assert.equal(classify({ ok: false, text: 'Error: the Chrome extension is not connected' }), 'unavailable');
  assert.equal(classify({ ok: false, text: 'Error: extension not connected' }), 'unavailable');
  assert.equal(classify({ ok: false, text: 'Error: the printer is busy printing' }), 'fatal');
  assert.equal(classify({ ok: false, text: 'Error: server busy' }), 'transient');
  assert.equal(classify({ ok: false, text: 'Error: busy, try again' }), 'transient');
});
