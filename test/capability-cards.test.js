const test = require('node:test');
const assert = require('node:assert/strict');
const { toolDeps } = require('./helpers/tool-deps');
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { validateCard, CARD_FIELDS, SIDE_EFFECTS, validateToolMeta } = require('../src/core/skills/capability');
const { READ_ONLY } = require('../src/core/tasks/effects');

const catalog = buildCatalog(loadGroups(toolDeps()));
let cards;
test.before(async () => { cards = await catalog.cardsNow(); });

test('cards: one complete card per group, in catalog order', () => {
  assert.equal(cards.length, 19);
  assert.deepEqual(cards.map(c => c.id), catalog.ids);
  for (const c of cards) {
    assert.deepEqual(validateCard(c), [], `${c.id}: ${validateCard(c)}`);
    assert.ok(c.summary.length >= 15 && c.summary.length <= 200, `${c.id}: summary length`);
    assert.ok(c.examples.length >= 1, `${c.id}: needs examples`);
  }
});

test('cards: no invented fields', () => {
  for (const c of cards) assert.deepEqual(Object.keys(c).sort(), [...CARD_FIELDS].sort());
  assert.ok(validateCard({ ...cards[0], extra: 1 }).some(e => /extra/.test(e)));
  assert.ok(validateCard({ ...cards[0], sideEffects: 'nuke' }).length);
});

test('cards: sideEffects derived from risk and READ_ONLY, not a second list', () => {
  const by = Object.fromEntries(cards.map(c => [c.id, c.sideEffects]));
  assert.equal(by.math, 'read');
  assert.equal(by.pc, 'write');          // has confirm tools
  assert.equal(by.files, 'write');
  assert.equal(by.web, 'external');
  for (const g of catalog.groups) {
    if (g.tools.some(t => t.risk === 'confirm')) assert.notEqual(by[g.id], 'read', g.id);
    if (g.tools.every(t => READ_ONLY.has(t.name)) && !['web'].includes(g.id)) assert.ok(['none', 'read'].includes(by[g.id]), g.id);
  }
});

test('cards: unavailable group is marked with a reason, available one is not', async () => {
  const cat = buildCatalog(loadGroups({ ...toolDeps(), browserLink: { connected: false }, getConfig: () => ({ browser: { enabled: true } }) }));
  const now = await cat.cardsNow();
  const b = now.find(c => c.id === 'browser');
  assert.ok(b, 'browser group must exist when a browserLink is given');
  assert.equal(b.available, false);
  assert.match(b.missingReason, /not connected/);
  const core = now.find(c => c.id === 'core');
  assert.equal(core.available, true);
  assert.equal(core.missingReason, null);
});

test('cards: async status resolves through cardsNow; the sync cards getter is gone', async () => {
  const cat = buildCatalog([{ id: 'x', label: 'Test group label', triggers: [], tools: [{ name: 'a_b', risk: 'safe' }], status: async () => ({ ok: false, detail: 'nope' }) }]);
  assert.equal('cards' in cat, false);
  const now = await cat.cardsNow();
  assert.equal(now[0].available, false);
  assert.equal(now[0].missingReason, 'nope');
});

test('cards: throwing or rejecting status never throws or leaks an unhandled rejection; card is unknown', async () => {
  const unhandled = [];
  const on = e => unhandled.push(e);
  process.on('unhandledRejection', on);
  try {
    const mk = (id, status) => ({ id, label: 'Test group label', triggers: [], tools: [{ name: 'a_b' }], status });
    const cat = buildCatalog([mk('t', () => { throw new Error('boom'); }), mk('r', () => Promise.reject(new Error('bad')))]);
    const now = await cat.cardsNow();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(now.map(c => [c.available, c.missingReason]), [[null, null], [null, null]]);
    assert.deepEqual(now.map(c => validateCard(c)), [[], []]);
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', on); }
});

test('tool metadata validator accepts good and rejects bad values', () => {
  assert.deepEqual(validateToolMeta({ category: 'x', sideEffects: 'read', requires: ['browser'] }), []);
  assert.ok(validateToolMeta({ sideEffects: 'bad' }).length);
  assert.ok(validateToolMeta({ requires: 'browser' }).length);
  assert.deepEqual(SIDE_EFFECTS, ['none', 'read', 'write', 'external']);
});

test('cards: every tool that sets capability metadata sets valid metadata', () => {
  for (const t of catalog.tools) assert.deepEqual(validateToolMeta(t), [], t.name);
});
