const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { grade, liveSnapshot } = require('../eval/run');

const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, '../eval/questions.json'), 'utf8'));
const LIVE_KEYS = new Set(['voice', 'tools', 'models', 'confirm', 'groups', 't']);

test('eval live fixture: grade() leaves the existing kinds alone', () => {
  assert.equal(grade({ pick: 'set_timer' }, '', { tools: ['set_timer'] }), true);
  assert.equal(grade({ pick: 'set_timer' }, '', { tools: [] }), false);
  assert.equal(grade({ tool: 'get_weather' }, '', { toolResults: [{ name: 'get_weather', ok: true }] }), true);
  assert.equal(grade({ text: 'blue' }, 'It is Blue.', {}), true);
  assert.equal(grade({ num: 2, tol: 0.001 }, 'It is 2', {}), true);
});

test('eval live fixture: route-note expectations (reason, noReason, not) are checked on top of the pick', () => {
  const q = { pick: 'set_timer', reason: 'voice: fast' };
  assert.equal(grade(q, '', { tools: ['set_timer'], reason: 'technical; voice: fast' }), true);
  assert.equal(grade(q, '', { tools: ['set_timer'], reason: 'technical' }), false);
  assert.equal(grade({ pick: 'set_timer', noReason: 'voice: fast' }, '', { tools: ['set_timer'], reason: 'technical' }), true);
  assert.equal(grade({ pick: 'set_timer', noReason: 'voice: fast' }, '', { tools: ['set_timer'], reason: 'voice: fast' }), false);
  assert.equal(grade({ not: 'web_search' }, '', { tools: ['read_page'] }), true);
  assert.equal(grade({ not: 'web_search' }, '', { tools: ['web_search'] }), false);
  assert.equal(grade({ noReason: 'follow-up' }, 'ok', { tools: [], reason: 'chat' }), true);
});

test('eval live fixture: liveSnapshot() rebases the relative times onto now', () => {
  const s = liveSnapshot({ voice: 'listening', tools: [{ name: 'a', ok: false, t: 1000 }], models: [{ name: 'm', t: 2000 }], groups: { list: ['timers'], at: 500 } }, 100000);
  assert.equal(s.t, 100000);
  assert.deepEqual(s.tools, [{ name: 'a', ok: false, t: 99000 }]);
  assert.deepEqual(s.models, [{ name: 'm', t: 98000 }]);
  assert.deepEqual(s.groups, { list: ['timers'], at: 99500 });
  assert.equal(s.voice, 'listening');
});

test('eval live fixture: questions with live carry an object of known snapshot keys; ids unique', () => {
  const ids = QUESTIONS.map(q => q.id);
  assert.equal(new Set(ids).size, ids.length);
  const withLive = QUESTIONS.filter(q => 'live' in q);
  assert.ok(withLive.length >= 5, 'live cases exist');
  for (const q of withLive) {
    assert.ok(q.live && typeof q.live === 'object' && !Array.isArray(q.live), `${q.id}: live is an object`);
    for (const k of Object.keys(q.live)) assert.ok(LIVE_KEYS.has(k), `${q.id}: unknown live key ${k}`);
    for (const k of ['tools', 'models']) if (k in q.live) assert.ok(Array.isArray(q.live[k]), `${q.id}: ${k} is an array`);
    if ('source' in q) assert.ok(['text', 'voice'].includes(q.source), `${q.id}: source`);
  }
  // each live case has a no-live twin that must route as today
  assert.ok(QUESTIONS.filter(q => q.group === 'adaptive' && !q.live).length >= 4, 'negatives without live');
});
