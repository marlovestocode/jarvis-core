const test = require('node:test');
const assert = require('node:assert');
const { createBus } = require('../src/core/bus');
const { createLiveState } = require('../src/core/livestate');

// Tool end events that say nothing about the tool's health (the model's own mistakes) are not stored.
function setup() {
  const bus = createBus();
  const ls = createLiveState({ bus, now: () => 1000 });
  return { bus, ls };
}

test('schema-rejected (badArgs) tool end events are not stored', () => {
  const { bus, ls } = setup();
  bus.emit('tool', { id: 'a', name: 'web_search', phase: 'end', ok: false, badArgs: true });
  assert.deepStrictEqual(ls.snapshot().tools, []);
});

test('skipped tool end events are not stored', () => {
  const { bus, ls } = setup();
  bus.emit('tool', { id: 'a', name: 'web_search', phase: 'end', ok: false, skipped: true });
  assert.deepStrictEqual(ls.snapshot().tools, []);
});

test('a normal failed tool end event is still stored, with the same entry shape', () => {
  const { bus, ls } = setup();
  bus.emit('tool', { id: 'a', name: 'web_search', phase: 'end', ok: false, badArgs: undefined, skipped: undefined });
  assert.deepStrictEqual(ls.snapshot().tools, [{ name: 'web_search', ok: false, soft: false, t: 1000 }]);
});
