const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog } = require('../src/core/skills');
const { createToolIndex } = require('../src/core/skills/toolindex');
const { createGroup: createCore } = require('../src/core/skills/core');
const { createToolRunner, eligibility } = require('../src/core/tools/registry');
const { createFakeEmbedder } = require('../src/core/cortex/embedder');
const { makeSynthRegistry } = require('./helpers/synth-registry');

const P = { type: 'object', properties: {}, additionalProperties: false };
const T = (name, description, extra = {}) => ({ name, description, params: P, sideEffects: 'read', async run() { return `${name} ran`; }, ...extra });

function small() {
  const groups = [
    { id: 'core', label: 'Core', triggers: [], tools: [T('get_time', 'Tell the time.')] },
    { id: 'files', label: 'Files', triggers: [], tools: [T('delete_file', 'Delete a file from disk.', { risk: 'confirm' }), T('read_file', 'Read a file from disk.')] },
    { id: 'media', label: 'Media', triggers: [], tools: [T('media_control', 'Play, pause or skip the music.')] },
  ];
  return { groups, catalog: buildCatalog(groups) };
}

test('hybrid finds a tool whose words share nothing with the request', async () => {
  const { groups, tools, synonyms, paraphrase } = makeSynthRegistry({ n: 300, seed: 7 });
  const catalog = buildCatalog(groups);
  const idx = createToolIndex({ catalog, embed: createFakeEmbedder({ synonyms }).embed });
  const targets = tools.filter((_, i) => i % 15 === 0).slice(0, 20).map(t => t.name);
  assert.equal(targets.length, 20);
  let hits = 0;
  for (const name of targets) {
    const r = await idx.find(paraphrase(name), { groups: null });
    assert.equal(r.mode, 'hybrid');
    assert.ok(r.tools.length >= 4 && r.tools.length <= 8, `k ${r.tools.length}`);
    if (r.tools.some(t => t.name === name)) hits++;
  }
  assert.ok(hits >= 18, `found ${hits} of 20`);
});

test('embeddings slow or down fall back to lexical, never throw, stay under the cap', async () => {
  const { catalog } = small();
  for (const embed of [() => new Promise(r => setTimeout(r, 2000)), async () => { throw new Error('down'); }, () => { throw new Error('sync'); }]) {
    const idx = createToolIndex({ catalog, embed, embedMs: 50 });
    const t0 = Date.now();
    const r = await idx.find('please read the file', { groups: null });
    assert.ok(Date.now() - t0 < 400);
    assert.equal(r.mode, 'lexical');
    assert.ok(r.tools.length <= 8);
    assert.equal(r.outcome, 'tools');
    assert.ok(r.tools.some(t => t.name === 'read_file'));
  }
});

test('ineligible tools are hidden and the outcome says why', async () => {
  const { catalog } = small();
  const idx = createToolIndex({ catalog, eligible: eligibility });
  const g = await idx.find('delete the file report.txt', { speaker: 'guest' });
  assert.equal(g.outcome, 'not_permitted');
  assert.deepEqual(g.tools, []);
  assert.equal(g.ineligible[0].reason, 'guest');
  const t = await idx.find('delete the file report.txt', { tainted: true, groups: ['files'], exclude: new Set(['read_file']) });
  assert.equal(t.outcome, 'not_permitted');
  assert.equal(t.ineligible[0].reason, 'tainted');
  assert.equal((await idx.find('xyzzy plugh')).outcome, 'none');
});

test('excluded tools never come back', async () => {
  const { catalog } = small();
  const idx = createToolIndex({ catalog });
  const top = (await idx.find('read the file')).tools[0].name;
  const again = await idx.find('read the file', { exclude: new Set([top]) });
  assert.ok(!again.tools.some(t => t.name === top));
});

test('find_tools through the runner', async () => {
  const { groups, tools, synonyms, paraphrase } = makeSynthRegistry({ n: 120, seed: 3 });
  const all = [createCore({}), ...groups];
  const catalog = buildCatalog(all);
  const toolIndex = createToolIndex({ catalog, embed: createFakeEmbedder({ synonyms }).embed, eligible: eligibility });
  const runner = createToolRunner(all.flatMap(g => g.tools), { groups: all, toolIndex });
  const target = tools[5].name;
  const scope = runner.turn(['core']);
  const r = await scope.run('find_tools', { query: paraphrase(target) }, { turn: { tainted: false } });
  assert.ok(r.ok, r.text);
  assert.match(r.text, new RegExp(target));
  const names = scope.specs().map(s => s.name);
  assert.ok(names.includes(target) && names.includes('find_tools'));
  assert.ok((await scope.run('find_tools', { query: paraphrase(tools[9].name) }, { turn: { tainted: false } })).ok);
  const third = await scope.run('find_tools', { query: paraphrase(target) }, { turn: { tainted: false } });
  assert.equal(third.ok, false);
  assert.match(third.text, /Cannot load more skills/);
  const guest = await runner.turn(['core']).run('find_tools', { query: 'anything' }, { turn: { tainted: true, speaker: 'guest' } });
  assert.equal(guest.ok, false);
});

test('a tool outside the offered top-K still runs by name, and a confirm tool still needs a clean turn', async () => {
  const { groups, catalog } = small();
  const toolIndex = createToolIndex({ catalog });
  const runner = createToolRunner(groups.flatMap(g => g.tools), { groups, toolIndex });
  const scope = runner.turn(['files']);
  scope.offer(['read_file'], { turn: { tainted: false } });
  assert.deepEqual(scope.specs().map(s => s.name), ['read_file']);
  assert.equal((await scope.run('get_time', {}, { turn: { tainted: false } })).ok, true);
  assert.equal((await scope.run('delete_file', {}, { turn: { tainted: true } })).ok, false);
});

test('a slow status probe means no index this turn, within the cap', async () => {
  const { catalog } = small();
  const slow = { ...catalog, toolCardsNow: () => new Promise(r => setTimeout(r, 2000)) };
  const idx = createToolIndex({ catalog: slow, embedMs: 50 });
  const t0 = Date.now();
  const r = await idx.find('read the file', { lexicalOnly: true });
  assert.ok(Date.now() - t0 < 400);
  assert.equal(r.outcome, 'unavailable');
  assert.deepEqual(r.tools, []);
});

test('tool vectors are embedded once per catalog and a failed batch is retried', async () => {
  const { catalog } = small();
  const fake = createFakeEmbedder({});
  let docs = 0, fail = true;
  const embed = async (t, o) => { if (o.role === 'doc') { docs++; if (fail) throw new Error('down'); } return fake.embed(t, o); };
  const idx = createToolIndex({ catalog, embed });
  assert.equal((await idx.find('read the file')).mode, 'lexical');
  assert.equal(docs, 1);
  fail = false;
  await new Promise(r => setTimeout(r, 5));
  assert.equal((await idx.find('read the file')).mode, 'hybrid');
  assert.equal(docs, 2);
  await idx.find('play music'); await idx.find('delete the file');
  assert.equal(docs, 2, 'cached after the first good batch');
});

test('auto-offer keeps one extra load for the model', async () => {
  const { groups, catalog } = small();
  const all = [createCore({}), ...groups.filter(g => g.id !== 'core')];
  const runner = createToolRunner(all.flatMap(g => g.tools), { groups: all, toolIndex: createToolIndex({ catalog: buildCatalog(all) }) });
  const scope = runner.turn(['core']);
  const got = scope.offer(['read_file', 'media_control'], { turn: { tainted: false } });
  assert.deepEqual(got, ['read_file']);
  assert.equal((await scope.run('more_skills', { group: 'media' }, { turn: { tainted: false } })).ok, true);
});

test('more_skills on a narrowed loaded group shows it whole; find_tools skips what is offered', async () => {
  const { groups, catalog } = small();
  const all = [createCore({}), ...groups.filter(g => g.id !== 'core')];
  const runner = createToolRunner(all.flatMap(g => g.tools), { groups: all, toolIndex: createToolIndex({ catalog: buildCatalog(all) }) });
  const scope = runner.turn(['core', 'files']);
  scope.offer(['read_file'], { turn: { tainted: false } });
  assert.ok(!scope.specs().some(s => s.name === 'delete_file'));
  await scope.run('more_skills', { group: 'files' }, { turn: { tainted: false } });
  assert.ok(scope.specs().some(s => s.name === 'delete_file'));
  const r = await scope.run('find_tools', { query: 'read the file' }, { turn: { tainted: false } });
  assert.ok(!/read_file:/.test(r.text), r.text);
});

test('exec still refuses a tainted confirm tool and a guest on a non-allowlisted tool after discovery loaded their group', async () => {
  const { groups, catalog } = small();
  const all = [createCore({}), ...groups.filter(g => g.id !== 'core')];
  const runner = createToolRunner(all.flatMap(g => g.tools), { groups: all, toolIndex: createToolIndex({ catalog: buildCatalog(all), eligible: eligibility }) });
  const scope = runner.turn(['core']);
  assert.ok((await scope.run('find_tools', { query: 'read the file' }, { turn: { tainted: false } })).ok);
  assert.equal((await scope.run('delete_file', {}, { turn: { tainted: true } })).ok, false);
  assert.equal((await scope.run('read_file', {}, { turn: { tainted: true, speaker: 'guest' } })).ok, false);
});
