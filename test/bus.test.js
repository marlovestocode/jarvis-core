const test = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');

test('bus: on(type) gets only that type; on(*) gets all; off() stops delivery; ev has t', () => {
  const bus = createBus();
  const a = [], all = [];
  const off = bus.on('token', ev => a.push(ev));
  bus.on('*', ev => all.push(ev));
  bus.emit('token', { text: 'hi' });
  bus.emit('state', { state: 'idle' });
  assert.equal(a.length, 1);
  assert.equal(a[0].type, 'token');
  assert.equal(a[0].text, 'hi');
  assert.equal(typeof a[0].t, 'number');
  assert.equal(all.length, 2);
  off();
  bus.emit('token', { text: 'x' });
  assert.equal(a.length, 1);
  assert.equal(all.length, 3);
});

test('bus: a throwing listener does not stop other listeners', () => {
  const bus = createBus();
  const got = [];
  bus.on('x', () => { throw new Error('boom'); });
  bus.on('x', ev => got.push(ev));
  bus.on('*', ev => got.push(ev));
  bus.emit('x');
  assert.equal(got.length, 2);
});
