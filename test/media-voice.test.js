const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaSkill } = require('../src/core/media/skill');

const SCRIM = [['clairaudience', '2:37'], ['tale of the missing man', '2:58'], ['a nice place to visit', '2:22'], ['Jesus Wept', '2:01'],
  ['operation fishnet', '2:37'], ['a nightmare worth pursuing', '4:57'], ['1st things first', '2:28'], ['warped lives of blameless children', '2:47'],
  ['staring at the dust', '2:52'], ['heaven 4 a fiend', '2:26'], ['ex nihlio', '2:11'], ['Delusions of Grandeur', '2:50']]
  .map(([title, duration]) => ({ title, artist: 'Scrim', duration }));
const noService = { state: async () => ({ sessions: [], system: { volume: 0.5, muted: false }, apps: [] }), pickSession: () => ({ none: 'nothing is playing' }), act: async () => ({ ok: false, message: 'x' }) };
const fakeYtm = (queue = SCRIM) => ({
  connected: true,
  async upNext(count) { return { now: null, next: queue.slice(0, count), repeat: 'NONE' }; },
  async clear() { return { removed: queue.length }; },
});
const skill = (q) => createMediaSkill({ service: noService, ytm: fakeYtm(q) });

test('voice: a 12-song queue is read once, artist said once, rest counted, total rounded', async () => {
  const r = await skill().handle('what are the next 12 songs', { source: 'voice' });
  assert.match(r.reply, /^Twelve from Scrim: clairaudience, tale of the missing man, a nice place to visit, then Jesus Wept\./);
  assert.match(r.reply, /Eight more after that\./);
  assert.match(r.reply, /About thirty-five minutes in total\.$/);
  assert.doesNotMatch(r.reply, /\d\.|\(\d:\d\d\)|Total/);
});

test('text: the numbered list with lengths and exact total is unchanged', async () => {
  const r = await skill().handle('what are the next 12 songs', { source: 'text' });
  assert.match(r.reply, /^Next 12: 1\. “clairaudience” by Scrim \(2:37\); 2\. “tale of the missing man”/);
  assert.match(r.reply, /Total 33:06\.$/);
});

test('voice: missing lengths drop the total; a short queue says how many are queued', async () => {
  const r = await skill(SCRIM.slice(0, 2).map(x => ({ ...x, duration: '' }))).handle('what are the next 5 songs', { source: 'voice' });
  assert.doesNotMatch(r.reply, /in total|NaN/);
  assert.match(r.reply, /Only 2 are queued\./);
});

test('voice: confirmations vary and never repeat back to back; text stays literal', async () => {
  const s = skill();
  let last = null;
  for (let i = 0; i < 20; i++) {
    const r = await s.handle('clear the queue', { source: 'voice' });
    assert.ok(r.reply && r.reply !== last, `repeat: ${r.reply}`);
    assert.equal(r.record, 'Queue cleared.');
    last = r.reply;
  }
  assert.equal((await s.handle('clear the queue', { source: 'text' })).reply, 'Queue cleared.');
});
