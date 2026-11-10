const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider, NULL_TEXT } = require('../src/core/providers/null-provider');
const { createFakeProvider } = require('./helpers/fake-provider');

async function collect(it) { const out = []; for await (const c of it) out.push(c); return out; }

test('registry add/get/list', () => {
  const r = createRegistry();
  r.add({ id: 'a', label: 'A', x: 1 });
  r.add({ id: 'b', label: 'B' });
  assert.equal(r.get('a').x, 1);
  assert.equal(r.get('zz'), undefined);
  assert.deepEqual(r.list(), [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]);
});

test('NullProvider streams expected text and done', async () => {
  assert.equal(NullProvider.id, 'null');
  assert.equal(NullProvider.label, 'No model');
  assert.deepEqual(NullProvider.capabilities, { tools: false, logprobs: false, reasoning: false });
  assert.deepEqual(await NullProvider.status(), { ready: false, detail: 'No model set' });
  const chunks = await collect(NullProvider.chat({ messages: [], signal: new AbortController().signal }));
  assert.equal(chunks.at(-1).type, 'done');
  const toks = chunks.slice(0, -1);
  assert.ok(toks.length > 1);
  assert.ok(toks.every(c => c.type === 'token'));
  assert.equal(toks.map(c => c.text).join(''), 'No model is set yet. Open settings to choose one.');
  assert.equal(NULL_TEXT, 'No model is set yet. Open settings to choose one.');
});

test('NullProvider stops early when signal aborted', async () => {
  const ac = new AbortController();
  const got = [];
  await assert.rejects(async () => {
    for await (const c of NullProvider.chat({ messages: [], signal: ac.signal })) {
      got.push(c);
      if (got.length === 2) ac.abort();
    }
  }, { name: 'AbortError' });
  assert.equal(got.length, 2);
});

test('fake provider replays script', async () => {
  const script = [{ type: 'token', text: 'a', prob: 0.4, alts: [{ text: 'b', prob: 0.3 }] }, { type: 'done' }];
  const fp = createFakeProvider(script);
  assert.deepEqual(await collect(fp.chat({ messages: [], signal: new AbortController().signal })), script);
  const ac = new AbortController();
  const hang = createFakeProvider([{ type: 'token', text: 'x' }, { type: 'hang' }]);
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(collect(hang.chat({ messages: [], signal: ac.signal })), { name: 'AbortError' });
});
