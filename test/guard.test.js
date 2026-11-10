const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { guardWebContents } = require('../src/main/guard');

test('guard: navigation away and new windows are blocked', () => {
  const wc = new EventEmitter();
  let openHandler = null;
  wc.setWindowOpenHandler = fn => { openHandler = fn; };
  guardWebContents(wc);
  let prevented = 0;
  wc.emit('will-navigate', { preventDefault: () => { prevented++; } }, 'file:///C:/Users/x/dropped.html');
  wc.emit('will-redirect', { preventDefault: () => { prevented++; } }, 'https://example.com');
  assert.equal(prevented, 2);
  assert.deepEqual(openHandler({ url: 'https://example.com' }), { action: 'deny' });
});
