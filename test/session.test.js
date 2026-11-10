const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionStore } = require('../src/core/session');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jc-ses-'));

test('session: create/save/load round-trip', () => {
  const st = createSessionStore(tmp());
  const s = st.create();
  assert.equal(s.title, 'New chat');
  assert.deepEqual(s.messages, []);
  s.messages.push({ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi', stopped: true });
  st.save(s);
  const back = st.load(s.id);
  assert.deepEqual(back.messages, s.messages);
  assert.equal(back.id, s.id);
  assert.equal(st.load('nope'), null);
});

test('session: list sorted by updated desc', async () => {
  const st = createSessionStore(tmp());
  const a = st.create(); st.save(a);
  await new Promise(r => setTimeout(r, 5));
  const b = st.create(); st.save(b);
  await new Promise(r => setTimeout(r, 5));
  a.messages.push({ role: 'user', content: 'again' }); st.save(a);
  assert.deepEqual(st.list().map(x => x.id), [a.id, b.id]);
  assert.deepEqual(Object.keys(st.list()[0]).sort(), ['id', 'title', 'updated']);
});

test('session: title from first user message, 48 char cut', () => {
  const st = createSessionStore(tmp());
  const s = st.create();
  s.messages.push({ role: 'user', content: '  what   is\nthe weather like in a very long sentence that keeps going on' });
  st.save(s);
  const t = st.load(s.id).title;
  assert.equal(t, 'what is the weather like in a very long sentence…');
  assert.equal(t.length, 49);
  const s2 = st.create();
  s2.messages.push({ role: 'user', content: 'short one' });
  st.save(s2);
  assert.equal(st.load(s2.id).title, 'short one');
});

test('session: corrupt file → load returns null, file moved to history/broken/, list skips it', () => {
  const d = tmp();
  const st = createSessionStore(d);
  const good = st.create(); st.save(good);
  const id = '11111111-2222-3333-4444-555555555555';
  fs.writeFileSync(path.join(d, 'history', id + '.json'), '{broken');
  assert.deepEqual(st.list().map(x => x.id), [good.id]);
  assert.equal(st.load(id), null);
  assert.equal(fs.existsSync(path.join(d, 'history', 'broken', id + '.json')), true);
  assert.equal(fs.existsSync(path.join(d, 'history', id + '.json')), false);
});

test('session: remove deletes file', () => {
  const d = tmp();
  const st = createSessionStore(d);
  const s = st.create(); st.save(s);
  st.remove(s.id);
  assert.equal(st.load(s.id), null);
  assert.equal(fs.existsSync(path.join(d, 'history', s.id + '.json')), false);
});

test('session: save writes atomically (tmp + rename)', (t) => {
  const d = tmp();
  const st = createSessionStore(d);
  const s = st.create();
  const calls = [];
  const realW = fs.writeFileSync, realR = fs.renameSync;
  t.mock.method(fs, 'writeFileSync', (f, ...a) => { calls.push(['write', path.basename(f)]); return realW(f, ...a); });
  t.mock.method(fs, 'renameSync', (a, b) => { calls.push(['rename', path.basename(a), path.basename(b)]); return realR(a, b); });
  st.save(s);
  assert.deepEqual(calls, [['write', s.id + '.json.tmp'], ['rename', s.id + '.json.tmp', s.id + '.json']]);
});

test('session: ids that are not uuids are refused (no path traversal)', () => {
  const st = createSessionStore(tmp());
  assert.equal(st.load('../config'), null);
  assert.doesNotThrow(() => st.remove('../../x'));
});
