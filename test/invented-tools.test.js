const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveInvented, closest, distance } = require('../src/core/tools/invented');
const { createToolRunner } = require('../src/core/tools/registry');
const { buildCatalog, capsLine } = require('../src/core/skills');

const tool = (name, run = async a => `${name} ran with ${JSON.stringify(a)}`) => ({ name, description: name, params: { type: 'object', properties: {} }, run });
const groups = () => [
  { id: 'core', label: 'Core', triggers: [], tools: [tool('get_time')] },
  { id: 'media', label: 'Media controls', triggers: [], tools: [{ ...tool('media_control'), mistakes: [{ match: /^ytm_(pause|stop)$/, args: m => ({ action: m[1] }) }] }, tool('media_status')] },
  { id: 'ytmusic', label: 'YouTube Music library and stats', triggers: [], tools: [tool('ytm_library'), tool('ytm_play_library'), tool('music_stats')] },
  { id: 'memory', label: 'Long-term memory', triggers: [], tools: [tool('remember'), tool('recall_chats')] },
];

test('invented: names the model has made up map to the real tool with the right arguments (each tool lists its own)', () => {
  const real = require('./helpers/tool-deps').realTools(['media_control', 'music_stats', 'ytm_library']);
  assert.deepEqual(resolveInvented('ytm_pause', real), { tool: 'media_control', args: { action: 'pause' } });
  assert.deepEqual(resolveInvented('ytm_stop', real), { tool: 'media_control', args: { action: 'stop' } });
  assert.deepEqual(resolveInvented('YTMusic_Resume', real), { tool: 'media_control', args: { action: 'play' } });
  assert.deepEqual(resolveInvented('media_skip', real), { tool: 'media_control', args: { action: 'next' } });
  assert.deepEqual(resolveInvented('ytmusic_stats', real), { tool: 'music_stats', args: {} });
  assert.equal(resolveInvented('ytm_pause', real.filter(t => t.name === 'ytm_library')), null, 'only when the real tool is in this runner');
  assert.equal(resolveInvented('maximize_window', real), null);
  assert.equal(resolveInvented('', real), null);
  // a tool of any kind can list its own wrong names
  const mine = [{ name: 'set_thing', mistakes: [{ match: /^make_thing_(\d+)$/, args: m => ({ n: Number(m[1]) }) }] }];
  assert.deepEqual(resolveInvented('make_thing_3', mine), { tool: 'set_thing', args: { n: 3 } });
});

test('invented: a skill group called as a tool is recognised by id or label', () => {
  const gs = [{ id: 'ytmusic', label: 'YouTube Music library and stats' }, { id: 'memory', label: 'Long-term memory' }];
  assert.deepEqual(resolveInvented('ytmusic', [], gs), { group: 'ytmusic' });
  assert.deepEqual(resolveInvented('Memory', [], gs), { group: 'memory' });
  assert.deepEqual(resolveInvented('memory_skills', [], gs), { group: 'memory' });
  assert.deepEqual(resolveInvented('long-term memory', [], gs), { group: 'memory' });
  assert.equal(resolveInvented('weather', [], gs), null);
});

test('invented: closest suggests real tools by spelling or a shared word, and nothing for nonsense', () => {
  const names = ['media_control', 'media_status', 'ytm_library', 'get_weather', 'set_timer'];
  assert.ok(closest('media_controls', names).includes('media_control'));
  assert.ok(closest('weather', names).includes('get_weather'));
  assert.ok(closest('timer_set', names).includes('set_timer'));
  assert.deepEqual(closest('zzzzqqqq', names), []);
  assert.ok(closest('media', names).length <= 3);
  assert.equal(distance('kitten', 'sitting'), 3);
});

test('runner: an invented media name runs the real tool and says what it is called', async () => {
  const catalog = buildCatalog(groups());
  const runner = createToolRunner(catalog.tools, { groups: catalog.groups });
  const scope = runner.turn(['core', 'media']);
  const r = await scope.run('ytm_pause', {}, { turn: { tainted: false } });
  assert.equal(r.ok, true);
  assert.match(r.text, /media_control ran with \{"action":"pause"\}/);
  assert.match(r.text, /The tool is called media_control, not ytm_pause/);
  // the real tool is in an unloaded group: it still gets there (the normal auto-load), and a failed real call is not dressed up
  const other = runner.turn(['core']);
  assert.equal((await other.run('ytm_stop', {}, { turn: { tainted: false } })).ok, true);
  assert.deepEqual(other.loaded().sort(), ['core', 'media']);
  // without groups too
  const flat = createToolRunner(catalog.tools);
  assert.match((await flat.run('ytm_stop', {}, {})).text, /"action":"stop"/);
});

test('runner: a group name called as a tool loads the group and lists its tools instead of failing', async () => {
  const catalog = buildCatalog(groups());
  const scope = createToolRunner(catalog.tools, { groups: catalog.groups }).turn(['core']);
  const r = await scope.run('ytmusic', {}, { turn: { tainted: false } });
  assert.equal(r.ok, true);
  assert.match(r.text, /ytmusic is a skill group, not a tool/);
  assert.match(r.text, /ytm_library, ytm_play_library, music_stats/);
  assert.ok(scope.loaded().includes('ytmusic'));
  assert.ok(scope.specs().some(s => s.name === 'ytm_library'), 'its tools are now offered');
  // the same cap as more_skills: a third group is refused with the usual message
  await scope.run('memory', {}, { turn: { tainted: false } });
  assert.match((await scope.run('media', {}, { turn: { tainted: false } })).text, /Cannot load more skills/);
  // a runner that has no groups cannot know what a group is, so it is an ordinary unknown name
  assert.equal((await createToolRunner(catalog.tools).run('memory', {}, {})).ok, false);
});

test('runner: a truly unknown name gets a suggestion and the list, and never runs anything', async () => {
  const catalog = buildCatalog(groups());
  const scope = createToolRunner(catalog.tools, { groups: catalog.groups }).turn(['core', 'media']);
  const r = await scope.run('media_controler', {}, { turn: { tainted: false } });
  assert.equal(r.ok, false);
  assert.match(r.text, /unknown tool media_controler\. Did you mean media_control/);
  const n = await scope.run('maximize_window', {}, { turn: { tainted: false } });
  assert.equal(n.ok, false);
  assert.doesNotMatch(n.text, /Did you mean/);
  assert.match(n.text, /Tools that exist: .*get_time/);
});

test('runner: a rerouted call still respects risk (a confirm tool never starts from text the model read)', async () => {
  const risky = { ...tool('media_control'), risk: 'confirm', mistakes: [{ match: /^ytm_(pause|stop)$/, args: m => ({ action: m[1] }) }] };
  const catalog = buildCatalog([{ id: 'core', label: 'Core', triggers: [], tools: [tool('get_time')] }, { id: 'media', label: 'Media', triggers: [], tools: [risky] }]);
  const scope = createToolRunner(catalog.tools, { groups: catalog.groups }).turn(['core', 'media']);
  const r = await scope.run('ytm_pause', {}, { turn: { tainted: true } });
  assert.equal(r.ok, false);
  assert.match(r.text, /won't start that from text I read/);
});

test('capsLine: the areas are not presented as tools', () => {
  const line = capsLine(buildCatalog(groups()));
  assert.match(line, /NOT tools: never call these names/);
  assert.match(line, /more_skills/);
  assert.match(line, /ytmusic = YouTube Music/);
});
