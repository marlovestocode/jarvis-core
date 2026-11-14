const test = require('node:test');
const assert = require('node:assert/strict');
const { toolDeps } = require('./helpers/tool-deps');
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { validateToolMeta } = require('../src/core/skills/capability');
const { toolContract, buildToolCard, cardText, validateToolCard, parallelSafe } = require('../src/core/skills/toolcards');
const { checkArgs } = require('../src/core/tools/args');

const catalog = buildCatalog(loadGroups(toolDeps()));
const tool = n => catalog.byName.get(n).tool;
let cards;
test.before(async () => { cards = await catalog.toolCardsNow(); });

test('cards: one valid card per tool', () => {
  assert.equal(cards.size, catalog.tools.length);
  for (const [n, c] of cards) assert.deepEqual(validateToolCard(c), [], `${n}: ${validateToolCard(c)}`);
});

test('contract: defaults come from risk and READ_ONLY, unknown fails closed', () => {
  const t = toolContract(tool('get_time'));
  assert.equal(t.effect, 'read'); assert.equal(t.idempotent, true); assert.equal(t.volatile, true);
  const d = toolContract(tool('delete_to_recycle_bin'));
  assert.equal(d.effect, 'write'); assert.equal(d.idempotent, false);
  assert.equal(toolContract({ name: 'x_y', run() {} }).effect, 'write');
  assert.equal(toolContract(tool('web_search')).effect, 'read');
});

test('contract: a confirm tool cannot declare effect read', () => {
  assert.ok(validateToolMeta({ name: 'x', risk: 'confirm', effect: 'read' }).includes('a confirm tool cannot be effect read'));
  assert.ok(validateToolMeta({ name: 'x', effect: 'nuke' }).length);
  assert.ok(validateToolMeta({ name: 'x', verify: { tool: 'a', expect: {} } }).length);
});

test('parallelSafe: read, not confirm, not needsClean', () => {
  assert.equal(parallelSafe(tool('list_timers')), true);
  assert.equal(parallelSafe(tool('close_app')), false);
  assert.equal(parallelSafe({ name: 'list_timers', effect: 'read', needsClean: true }), false);
});

test('cardText: carries the name words, summary and params', () => {
  const txt = cardText(cards.get('list_timers'), tool('list_timers'));
  assert.match(txt, /list/); assert.match(txt, /timers/); assert.ok(txt.includes(cards.get('list_timers').summary));
  assert.equal(cards.get('list_timers').verify, null);
});

test('card: params digest marks required', () => {
  assert.match(cards.get('set_alarm').params, /at:string\*/);
});

const SAMPLES = {
  set_timer: [[{ seconds: 60 }, 'Timer set.']],
  set_alarm: [[{ at: '7am' }, 'Alarm set.']],
  set_reminder: [[{ text: 'x', at: '5pm' }, 'ok']],
  media_control: [[{ action: 'pause' }, 'Paused.']],
  make_folder: [[{ path: 'C:/x' }, 'Created C:/x.']],
  copy_files: [[{ from: 'C:/a.txt', to: 'C:/x' }, 'Copied 1 file to C:/x.']],
};
test('verify: reads back through a read tool with valid args', () => {
  for (const [name, rows] of Object.entries(SAMPLES)) {
    const t = tool(name);
    assert.ok(t.verify, `${name} declares verify`);
    const vt = catalog.byName.get(t.verify.tool)?.tool;
    assert.ok(vt, `${name}: verify tool exists`);
    assert.equal(toolContract(vt).effect, 'read');
    for (const [args, result] of rows) assert.equal(checkArgs(vt, t.verify.args(args, result)).ok, true, `${name} verify args`);
    assert.equal(cards.get(name).verify.tool, t.verify.tool);
    assert.equal('args' in cards.get(name).verify, false);
  }
  assert.deepEqual(tool('make_folder').verify.args({ path: 'C:/x' }), { path: 'C:/x' });
});
