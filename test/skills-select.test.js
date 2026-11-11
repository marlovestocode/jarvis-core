const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { selectGroups } = require('../src/core/skills/select');
const { toolDeps } = require('./helpers/tool-deps');
const golden = require('./fixtures/route-golden.json');

const catalog = buildCatalog(loadGroups(toolDeps()));
const sel = (text, o = {}) => selectGroups(text, { lastGroups: [], source: 'text', ...o }, catalog);

test('select: golden table', () => {
  const bad = [];
  for (const row of golden) {
    const got = sel(row.text, { lastGroups: row.lastGroups || [] });
    if (JSON.stringify(got) !== JSON.stringify(row.expect)) bad.push(`"${row.text}" ${JSON.stringify(row.lastGroups || [])}: wanted ${row.expect}, got ${got}`);
  }
  assert.deepEqual(bad, []);
});

test('select: follow-up bonus', () => {
  assert.deepEqual(sel('now close it', { lastGroups: ['pc'] }), ['core', 'pc']);
  assert.deepEqual(sel('now close it'), ['core', 'knowledge']);
});

test('select: bonus alone never loads', () => {
  assert.deepEqual(sel('and the next one', { lastGroups: ['media', 'pc'] }), ['core', 'knowledge']);
});

function fake(order) {
  const groups = [{ id: 'core', tools: [], triggers: [] }, ...order.map(id => ({ id, tools: [], triggers: [{ words: ['zap'], w: 3 }] })), { id: 'knowledge', tools: [], triggers: [] }];
  return { groups, ids: groups.map(g => g.id) };
}

test('select: tie is deterministic (catalog order)', () => {
  assert.deepEqual(selectGroups('zap', {}, fake(['a', 'b'])), ['core', 'a', 'b']);
  assert.deepEqual(selectGroups('zap', {}, fake(['b', 'a'])), ['core', 'b', 'a']);
});

test('select: caps at two groups', () => {
  assert.deepEqual(selectGroups('zap', {}, fake(['a', 'b', 'c'])), ['core', 'a', 'b']);
  assert.equal(sel('play my gym playlist and set a timer and what is the weather and open chrome').length, 3);
});

test('select: higher score wins over catalog order', () => {
  const c = fake(['a', 'b']);
  c.groups[2].triggers.push({ re: /zap/i, w: 2 });
  assert.deepEqual(selectGroups('zap', {}, c), ['core', 'b', 'a']);
});

test('select: no match → core + knowledge', () => {
  assert.deepEqual(sel('blorp zazzle'), ['core', 'knowledge']);
  assert.deepEqual(sel(''), ['core', 'knowledge']);
});

test('select: matching is whole-word and case-insensitive', () => {
  assert.deepEqual(sel('PAUSE'), ['core', 'media']);
  assert.deepEqual(sel('pauses'), ['core', 'knowledge']);
});
