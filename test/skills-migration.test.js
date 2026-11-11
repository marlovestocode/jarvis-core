const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultTools } = require('../src/core/brain');
const { createToolRunner } = require('../src/core/tools/registry');
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { toolDeps } = require('./helpers/tool-deps');
const manifest = require('./fixtures/tool-manifest.json');

const project = tools => tools.map(t => ({ name: t.name, description: t.description, params: t.params, risk: t.risk ?? null, timeoutMs: t.timeoutMs ?? null })).sort((a, b) => (a.name < b.name ? -1 : 1));

// the global alias table as it was before tool-owned aliases
const OLD_ALIASES = {
  ytm_music: 'youtube_music',
  youtube: 'youtube_music',
  play_music: 'youtube_music',
  get_volume: 'media_status',
  set_volume: 'media_control',
  media: 'media_control',
  weather: 'get_weather',
  get_news: 'news_headlines',
  wikipedia: 'lookup_knowledge',
  search: 'lookup_knowledge',
  web_search: 'lookup_knowledge',
  time: 'get_time',
  system_stats: 'get_system_stats',
  timer: 'set_timer',
  start_timer: 'set_timer',
  create_timer: 'set_timer',
  alarm: 'set_alarm',
  create_alarm: 'set_alarm',
  remind_me: 'set_reminder',
  reminder: 'set_reminder',
  create_reminder: 'set_reminder',
  get_timers: 'list_timers',
  delete_timer: 'cancel_timer',
  stop_timer: 'cancel_timer',
  cancel_alarm: 'cancel_timer',
  cancel_reminder: 'cancel_timer',
  launch_app: 'open_app',
  start_app: 'open_app',
  open_application: 'open_app',
  open_program: 'open_app',
  close_application: 'close_app',
  quit_app: 'close_app',
  kill_app: 'close_app',
  switch_to: 'focus_window',
  switch_window: 'focus_window',
  search_files: 'find_files',
  find_file: 'find_files',
  open_file: 'open_path',
  open_folder: 'open_path',
  move_file: 'move_files',
  delete_file: 'delete_to_recycle_bin',
  delete_files: 'delete_to_recycle_bin',
  remove_file: 'delete_to_recycle_bin',
  trash: 'delete_to_recycle_bin',
  undo: 'undo_last',
  volume: 'set_system_volume',
  lock: 'lock_screen',
  shutdown: 'power',
  restart: 'power',
  sleep: 'power',
};

test('migration: every tool keeps name, description, params, risk and timeout', () => {
  assert.deepEqual(project(defaultTools(toolDeps())), manifest);
});

test('migration: every old alias still resolves to the same tool', async () => {
  assert.equal(Object.keys(OLD_ALIASES).length, 50);
  const runner = createToolRunner(defaultTools(toolDeps()));
  const catalog = buildCatalog(loadGroups(toolDeps()));
  for (const [alias, name] of Object.entries(OLD_ALIASES)) {
    const r = await runner.run(alias, {}, { turn: { tainted: false } });
    assert.doesNotMatch(r.text, /unknown tool/, alias);
    assert.equal(catalog.byName.get(alias)?.tool.name, name, alias);
  }
});

test('catalog: each tool belongs to exactly one group', () => {
  const groups = loadGroups(toolDeps());
  const seen = new Map();
  for (const g of groups) for (const t of g.tools) { assert.ok(!seen.has(t.name), `${t.name} in two groups`); seen.set(t.name, g.id); }
  assert.equal(seen.size, manifest.length);
  const catalog = buildCatalog(groups);
  for (const [n, id] of seen) assert.equal(catalog.groupOf(n), id);
  assert.equal(catalog.groupOf('nope'), null);
});

test('catalog: group ids', () => {
  assert.deepEqual(loadGroups(toolDeps()).map(g => g.id), ['core', 'media', 'ytmusic', 'timers', 'knowledge', 'system', 'pc', 'math', 'memory']);
  assert.deepEqual(buildCatalog(loadGroups(toolDeps())).ids, ['core', 'media', 'ytmusic', 'timers', 'knowledge', 'system', 'pc', 'math', 'memory']);
});

test('catalog: a group with no tools is dropped', () => {
  assert.ok(!loadGroups({}).some(g => g.id === 'ytmusic'));
});

test('runner: untrusted flag', async () => {
  const runner = createToolRunner(defaultTools(toolDeps()));
  const ctx = { turn: { tainted: false } };
  for (const n of ['find_files', 'list_windows', 'lookup_knowledge', 'read_article', 'news_headlines', 'get_weather', 'weather_alerts', 'sports_scores']) {
    assert.equal((await runner.run(n, {}, ctx)).untrusted, true, n);
  }
  assert.notEqual((await runner.run('get_time', {}, ctx)).untrusted, true);
});
