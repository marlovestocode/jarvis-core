const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssembler } = require('../src/core/context/assemble');

const NOW = 1_000_000_000;
const item = (o = {}) => ({ id: 'i' + Math.random().toString(36).slice(2), text: 'hello', source: 's', kind: 'memory', observedAt: NOW, confidence: 0.9, trust: 'owner', sensitivity: 'personal', ...o });
const prov = (items, name = 'p') => ({ name, fetch: () => items });
const mk = (items, o = {}) => createAssembler({ providers: [prov(items)], now: () => NOW, ...o });
const req = (o = {}) => ({ text: 'q', speaker: 'owner', ...o });
const texts = (r) => r.items.map((i) => i.text);

test('digit runs of 7+ become [number], 6 digits untouched', async () => {
  const r = await mk([
    item({ id: 'a', text: 'acct 1234567 ok' }),
    item({ id: 'b', text: 'code 123456 ok' }),
    item({ id: 'c', text: 'card 4111 1111 1111 1111 end' }),
    item({ id: 'd', text: 'phone 555-123-4567 end' }),
  ]).assemble(req());
  const t = Object.fromEntries(r.items.map((i) => [i.id, i.text]));
  assert.equal(t.a, 'acct [number] ok');
  assert.equal(t.b, 'code 123456 ok');
  assert.equal(t.c, 'card [number] end');
  assert.equal(t.d, 'phone [number] end');
  assert.ok(!r.text.includes('1234567'));
});

test('emails become [email]', async () => {
  const r = await mk([item({ text: 'mail bob.smith+x@example.co.uk now' })]).assemble(req());
  assert.equal(texts(r)[0], 'mail [email] now');
  assert.ok(!r.text.includes('@'));
});

test('private dropped by default, kept with allowPrivate for owner, never for guest', async () => {
  const items = [item({ id: 'p', sensitivity: 'private', text: 'secret' }), item({ id: 'q', text: 'plain' })];
  let r = await mk(items).assemble(req());
  assert.deepEqual(r.items.map((i) => i.id), ['q']);
  assert.deepEqual(r.dropped.filter((d) => d.reason === 'access'), [{ id: 'p', reason: 'access' }]);
  assert.ok(!r.text.includes('secret') && !r.hint.includes('secret'));
  r = await mk(items).assemble(req({ allowPrivate: true }));
  assert.deepEqual(r.items.map((i) => i.id).sort(), ['p', 'q']);
  assert.ok(!r.hint.includes('secret'));
  r = await mk(items).assemble(req({ allowPrivate: true, speaker: 'guest' }));
  assert.equal(r.text, '');
  assert.deepEqual(r.items, []);
  r = await mk(items).assemble(req({ allowPrivate: 'yes' }));
  assert.deepEqual(r.items.map((i) => i.id), ['q']);
});

test('provider objects are not mutated by redaction', async () => {
  const a = item({ text: 'n 12345678 e a@b.com' });
  const copy = JSON.stringify(a);
  await mk([a]).assemble(req());
  assert.equal(JSON.stringify(a), copy);
});

test('redaction happens before dedupe', async () => {
  const r = await mk([item({ id: 'a', text: 'call 1234567 now' }), item({ id: 'b', text: 'call 7654321 now' })]).assemble(req());
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.dropped, [{ id: 'b', reason: 'duplicate' }]);
});

test('untrusted never supersedes an owner item (either order, even if newer)', async () => {
  for (const flip of [false, true]) {
    const o = item({ id: 'own', topic: 'k', text: 'port 80', observedAt: NOW - 1000 });
    const u = item({ id: 'unt', topic: 'k', text: 'port 90', trust: 'untrusted', observedAt: NOW - 10 });
    const r = await mk(flip ? [u, o] : [o, u]).assemble(req());
    assert.deepEqual(r.items.map((i) => i.id), ['own']);
    assert.deepEqual(r.dropped, [{ id: 'unt', reason: 'superseded' }]);
  }
});

test('untrusted never out-dedupes an owner item', async () => {
  const u = item({ id: 'unt', text: 'same', trust: 'untrusted', observedAt: NOW });
  const o = item({ id: 'own', text: 'same', observedAt: NOW - 1000 });
  const r = await mk([u, o]).assemble(req());
  assert.deepEqual(r.items.map((i) => i.id), ['own']);
  assert.deepEqual(r.dropped, [{ id: 'unt', reason: 'duplicate' }]);
});

test('validation requires source, trust and sensitivity values', async () => {
  const bad = [
    item({ id: 'a', source: '' }), item({ id: 'b', source: 5 }), item({ id: 'c', trust: 'x' }),
    item({ id: 'd', trust: undefined }), item({ id: 'e', sensitivity: 'secret' }), item({ id: 'f', sensitivity: undefined }),
    item({ id: 'g', text: 'ok' }),
  ];
  const r = await mk(bad).assemble(req());
  assert.deepEqual(r.items.map((i) => i.id), ['g']);
  assert.deepEqual(r.dropped.map((d) => d.id).sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.ok(r.dropped.every((d) => d.reason === 'invalid'));
});

test('hint collapses whitespace', async () => {
  const r = await mk([item({ kind: 'state', text: 'a   b\n\nc' })]).assemble(req());
  assert.equal(r.hint, 'a b c');
});
