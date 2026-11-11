const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { toolDeps } = require('./helpers/tool-deps');
const { grade } = require('../eval/run');

const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, '../eval/questions.json'), 'utf8'));

test('eval: questions.json parses, ids are unique, and every expected tool exists in the catalog', () => {
  assert.ok(Array.isArray(QUESTIONS) && QUESTIONS.length >= 50);
  const ids = QUESTIONS.map(q => q.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate question ids');
  const catalog = buildCatalog(loadGroups(toolDeps()));
  const names = new Set(catalog.tools.map(t => t.name));
  for (const q of QUESTIONS) {
    assert.equal(typeof q.q, 'string', q.id);
    for (const key of ['tool', 'pick']) if (q[key]) assert.ok(names.has(q[key]), `${q.id}: ${q[key]} is not a tool`);
  }
});

test('eval: the tool-choice questions cover every skill group', () => {
  const catalog = buildCatalog(loadGroups(toolDeps()));
  const picks = QUESTIONS.filter(q => q.group === 'tools');
  assert.ok(picks.length >= 25, `${picks.length} tool-choice questions`);
  const covered = new Set(picks.map(q => catalog.groupOf(q.pick)));
  const missing = catalog.ids.filter(id => id !== 'core' && id !== 'ytmusic' ? !covered.has(id) : false);
  assert.deepEqual(missing, [], 'groups without a tool-choice question');
  assert.ok(covered.has('ytmusic'), 'ytmusic is covered');
});

test('eval: grade() for a tool-choice question passes when the model picked the tool, whatever the tool answered', () => {
  const q = { id: 'x', pick: 'window_arrange' };
  assert.equal(grade(q, '', { tools: ['window_arrange'] }), true);
  assert.equal(grade(q, '', { tools: ['list_windows'] }), false);
  assert.equal(grade(q, '', { tools: [] }), false);
  assert.equal(grade(q, '', { tools: ['window_arrange'], error: 'timed out' }), false);
  // the older kinds still work
  assert.equal(grade({ tool: 'get_weather' }, '', { toolResults: [{ name: 'get_weather', ok: true }] }), true);
  assert.equal(grade({ text: 'blue' }, 'It is Blue.', {}), true);
});
