const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createListStore } = require('../src/core/lists/store');
const { createGroup } = require('../src/core/skills/lists');
const { createToolRunner } = require('../src/core/tools/registry');
const { createConfirm } = require('../src/core/pc/confirm');
const { createActionLog } = require('../src/core/pc/actions-log');
const { selectGroups } = require('../src/core/skills/select');
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { toolDeps } = require('./helpers/tool-deps');
const { NEEDS_OK } = require('../src/core/brain/guard');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jl-'));
  const file = path.join(dir, 'lists.json');
  const lists = createListStore({ file });
  const confirm = createConfirm({ actionLog: createActionLog({ file: path.join(dir, 'a.log') }) });
  const group = createGroup({ lists, pc: { confirm } });
  const runner = createToolRunner(group.tools);
  return { file, lists, confirm, run: (n, a) => runner.run(n, a, { turn: { tainted: false } }) };
}

test('lists: add creates the list, dedupes, and persists to disk', async () => {
  const { run, file } = setup();
  const r = await run('list_add', { list: 'grocery', items: ['milk', 'eggs', 'Milk'] });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /Added "milk", "eggs" to your grocery list \(2 items now\)/);
  assert.match(r.text, /"Milk" was already on it/);
  assert.deepEqual(Object.values(JSON.parse(fs.readFileSync(file, 'utf8')))[0].items, ['milk', 'eggs']);
  assert.equal(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')).length, 0, 'no temp file left');
});

test('lists: show, "grocery list" and "grocery" are the same list, unknown list is an error', async () => {
  const { run } = setup();
  await run('list_add', { list: 'Grocery List', items: ['milk'] });
  assert.match((await run('list_show', { list: 'grocery' })).text, /grocery list \(1\): 1\. milk/i);
  assert.match((await run('list_show', {})).text, /Lists: grocery \(1\)/i);
  const none = await run('list_show', { list: 'garden' });
  assert.equal(none.ok, false);
  assert.match(none.text, /no list called "garden"/);
});

test('lists: remove by words, ambiguity asks, missing item is an error', async () => {
  const { run } = setup();
  await run('list_add', { list: 'todo', items: ['call mom', 'call dentist', 'buy stamps'] });
  assert.match((await run('list_remove', { list: 'todo', item: 'stamps' })).text, /Removed "buy stamps".*\(2 left\)/);
  const amb = await run('list_remove', { list: 'todo', item: 'call' });
  assert.equal(amb.ok, false);
  assert.match(amb.text, /Which one/);
  assert.equal((await run('list_remove', { list: 'todo', item: 'nothing' })).ok, false);
});

test('lists: clear asks first and only empties on yes', async () => {
  const { run, confirm, lists } = setup();
  await run('list_add', { list: 'todo', items: ['a', 'b'] });
  const r = await run('list_clear', { list: 'todo' });
  assert.ok(String(r.text).startsWith(NEEDS_OK), r.text);
  assert.equal(lists.get('todo').items.length, 2, 'nothing cleared before the yes');
  assert.ok(confirm.pending());
});

test('lists: the group is in the catalog and routes list requests, not "list my devices"', () => {
  const catalog = buildCatalog(loadGroups(toolDeps()));
  assert.ok(catalog.ids.includes('lists'));
  assert.ok(selectGroups('add milk to my grocery list', {}, catalog).includes('lists'));
  assert.ok(selectGroups("what's on my todo list", {}, catalog).includes('lists'));
  assert.ok(!selectGroups('list my output devices', {}, catalog).includes('lists'));
});
