const test = require('node:test');
const assert = require('node:assert/strict');
const { windowsTts, FINISH_MAX_MS } = require('../src/core/voice/windows-speech');

// fake speech host: 'speak' resolves only after 'stop-speak'; words are fired by the test
function fakeHost() {
  const h = { reqs: [], handlers: {}, endSpeak: null };
  let id = 0;
  h.request = cmd => {
    h.reqs.push(cmd);
    let p;
    if (cmd === 'speak') p = new Promise(r => { h.endSpeak = r; });
    else { if (cmd === 'stop-speak') h.endSpeak?.(); p = Promise.resolve(); }
    p.id = ++id;
    return p;
  };
  h.on = (ev, fn) => { (h.handlers[ev] ||= new Set()).add(fn); return () => h.handlers[ev].delete(fn); };
  h.fire = (ev, msg) => { for (const fn of [...(h.handlers[ev] || [])]) fn({ ev, ...msg }); };
  return h;
}

test('windows tts: finishSentence stops at the next word boundary', async () => {
  const host = fakeHost();
  const h = windowsTts(host).speak('one two three four', {});
  const f = h.finishSentence();
  await new Promise(r => setTimeout(r, 10));
  assert.ok(!host.reqs.includes('stop-speak'), 'not cut mid-word');
  host.fire('word', { id: 1 });
  await f;
  assert.ok(host.reqs.includes('stop-speak'));
  await h.done;
});

test('windows tts: finishSentence stops within 1.5 s even with no word event', async () => {
  assert.equal(FINISH_MAX_MS, 1500);
  const host = fakeHost();
  const h = windowsTts(host, { finishMaxMs: 40 }).speak('a long word', {});
  const t0 = Date.now();
  await h.finishSentence();
  assert.ok(host.reqs.includes('stop-speak'));
  assert.ok(Date.now() - t0 >= 30);
  await h.done;
});
