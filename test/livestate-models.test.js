const test = require('node:test');
const assert = require('node:assert');
const { createBus } = require('../src/core/bus');
const { createLiveState, TOOL_TTL_MS, MAX_MODELS } = require('../src/core/livestate');

function setup() {
  const bus = createBus();
  const clock = { t: 1000 };
  const ls = createLiveState({ bus, now: () => clock.t });
  return { bus, clock, ls };
}

test('modelfail events land in snapshot().models with name and time', () => {
  const { bus, clock, ls } = setup();
  bus.emit('modelfail', { model: 'qwen3:8b' });
  clock.t = 2000;
  bus.emit('modelfail', { model: 'llama3' });
  assert.deepStrictEqual(ls.snapshot().models, [
    { name: 'qwen3:8b', t: 1000 },
    { name: 'llama3', t: 2000 },
  ]);
});

test('ring keeps only the last MAX_MODELS entries', () => {
  const { bus, ls } = setup();
  assert.strictEqual(MAX_MODELS, 6);
  for (let i = 0; i < 9; i++) bus.emit('modelfail', { model: `m${i}` });
  const names = ls.snapshot().models.map((x) => x.name);
  assert.deepStrictEqual(names, ['m3', 'm4', 'm5', 'm6', 'm7', 'm8']);
});

test('entries older than TOOL_TTL_MS are pruned', () => {
  const { bus, clock, ls } = setup();
  bus.emit('modelfail', { model: 'old' });
  clock.t = 1000 + TOOL_TTL_MS + 1;
  assert.deepStrictEqual(ls.snapshot().models, []);
});

test('missing or non-string model adds nothing', () => {
  const { bus, ls } = setup();
  bus.emit('modelfail', {});
  bus.emit('modelfail', { model: 42 });
  bus.emit('modelfail', { model: null });
  assert.deepStrictEqual(ls.snapshot().models, []);
});

test('extra event fields are never stored', () => {
  const { bus, ls } = setup();
  bus.emit('modelfail', { model: 'x', text: 'secret', error: 'boom' });
  const [entry] = ls.snapshot().models;
  assert.deepStrictEqual(Object.keys(entry), ['name', 't']);
});

test('snapshot().models is a fresh copy', () => {
  const { bus, ls } = setup();
  bus.emit('modelfail', { model: 'x' });
  const a = ls.snapshot();
  a.models[0].name = 'hacked';
  a.models.push({ name: 'extra', t: 0 });
  assert.deepStrictEqual(ls.snapshot().models, [{ name: 'x', t: 1000 }]);
});

test('no modelfail events: models is [] and other fields unchanged', () => {
  const { ls } = setup();
  assert.deepStrictEqual(ls.snapshot(), {
    t: 1000,
    voice: null,
    tools: [],
    route: null,
    turn: null,
    models: [],
  });
});
