const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSpeaker } = require('../src/core/voice/speaker/speaker');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jspv-')), 'voiceprint.json');
const secs = n => new Int16Array(Math.round(16000 * n)).map((_, i) => (i % 40) * 300 - 6000);
const axis = i => { const v = new Array(256).fill(0); v[i] = 1; return v; };
// unit vector with cosine c against axis(0): uses axis 0 and axis 1
const cosVec = c => { const v = new Array(256).fill(0); v[0] = c; v[1] = Math.sqrt(1 - c * c); return v; };

// fake onnxruntime: the "embedding" is `voice.vec`, or the next one from `voice.queue`
function fakeOrt(voice) {
  class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
  return { Tensor, InferenceSession: { create: async () => ({ run: async () => {
    if (voice.fail) throw new Error('boom');
    return { embs: { data: Float32Array.from(voice.queue && voice.queue.length ? voice.queue.shift() : voice.vec) } };
  } }) } };
}
function writeProfile(file, prints, learned) {
  const j = { prints, at: 'x' };
  if (learned) j.learned = learned;
  fs.writeFileSync(file, JSON.stringify(j));
}
function make(prints, learned, cfg = {}) {
  const file = tmpFile(), voice = { vec: axis(0) };
  if (prints) writeProfile(file, prints, learned);
  const sp = createSpeaker({ ort: fakeOrt(voice), modelPath: 'm', profileFile: file, exists: () => true, getConfig: () => cfg });
  return { sp, voice, file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
const A = () => [axis(0), axis(0), axis(0)];

test('verdict: top-3 mean beats the centroid on a two-cluster profile', async () => {
  const prints = [axis(0), axis(0), ...Array.from({ length: 10 }, () => axis(10))];   // centroid cos with axis 0 is only ~0.2
  const { sp, voice } = make(prints);
  voice.vec = axis(0);
  const r = await sp.verify(secs(2), 16000);
  assert.equal(r.score, 0.667);
  assert.equal(r.verdict, 'owner');
  assert.equal(r.ok, true);
});

test('verdict: fewer than three prints average over all of them', async () => {
  const { sp, voice } = make([axis(0), axis(5)]);
  voice.vec = axis(0);
  assert.equal((await sp.verify(secs(2), 16000)).score, 0.5);
});

test('verdict: boundaries at exactly 0.45 and 0.30', async () => {
  const { sp, voice } = make(A());
  const at = async c => { voice.vec = cosVec(c); return sp.verify(secs(2), 16000, { learn: false }); };
  let r = await at(0.45); assert.deepEqual([r.verdict, r.ok], ['owner', true]);
  r = await at(0.449); assert.deepEqual([r.verdict, r.ok], ['unsure', false]);
  r = await at(0.30); assert.deepEqual([r.verdict, r.ok], ['unsure', false]);
  r = await at(0.299); assert.deepEqual([r.verdict, r.ok], ['guest', false]);
});

test('verdict: config moves the bars', async () => {
  const { sp, voice } = make(A(), null, { speakerThreshold: 0.6, speakerGuestBelow: 0.5 });
  const at = async c => { voice.vec = cosVec(c); return sp.verify(secs(2), 16000, { learn: false }); };
  assert.equal((await at(0.6)).verdict, 'owner');
  assert.equal((await at(0.55)).verdict, 'unsure');
  assert.equal((await at(0.49)).verdict, 'guest');
});

test('verdict: lenient lowers both bars by 0.1 and a lenient owner is unsure', async () => {
  const { sp, voice } = make(A());
  const at = async c => { voice.vec = cosVec(c); return sp.verify(secs(2), 16000, { lenient: true }); };
  let r = await at(0.35); assert.deepEqual([r.verdict, r.ok], ['unsure', true]);
  r = await at(0.349); assert.deepEqual([r.verdict, r.ok], ['unsure', false]);
  r = await at(0.20); assert.equal(r.verdict, 'unsure');
  r = await at(0.199); assert.deepEqual([r.verdict, r.ok], ['guest', false]);
});

test('verdict: strict passes only a non-lenient owner', async () => {
  const { sp, voice } = make(A());
  const at = async (c, o) => { voice.vec = cosVec(c); return sp.verify(secs(2), 16000, { strict: true, learn: false, ...o }); };
  assert.equal((await at(0.9)).ok, true);
  assert.equal((await at(0.9, { lenient: true })).ok, false);
  assert.equal((await at(0.4)).ok, false);
  assert.equal((await at(0.1)).ok, false);
  voice.fail = true;
  assert.equal((await sp.verify(secs(2), 16000, { strict: true })).ok, false);
  assert.equal((await sp.verify(new Int16Array(2000), 16000, { strict: true })).ok, false);
});

test('verdict: fails open with no profile, model error; short audio gives a null verdict', async () => {
  const none = make(null);
  let r = await none.sp.verify(secs(2), 16000);
  assert.deepEqual([r.ok, r.verdict], [true, 'owner']);
  const { sp, voice } = make(A());
  r = await sp.verify(new Int16Array(2000), 16000);
  assert.deepEqual([r.ok, r.verdict], [true, null]);
  voice.fail = true;
  r = await sp.verify(secs(2), 16000);
  assert.deepEqual([r.ok, r.verdict], [true, 'owner']);
  assert.match(r.reason, /boom/);
});

test('learning: a score of 0.60 or more adds a learned print and saves it', async () => {
  const { sp, voice, read } = make(A());
  voice.vec = cosVec(0.65);
  const r = await sp.verify(secs(2), 16000);
  assert.equal(r.verdict, 'owner');
  assert.deepEqual(sp.counts(), { enrolled: 3, learned: 1 });
  assert.equal(sp.count(), 4);
  const f = read();
  assert.deepEqual(f.learned, [false, false, false, true]);
  assert.ok(Math.abs(f.prints[3][0] - 0.65) < 1e-3);
});

test('learning: not at 0.59, lenient, learn off, short audio, learn:false, or unsure/guest', async () => {
  const cases = [
    ['0.59', 0.59, {}, secs(2), {}],
    ['lenient', 0.8, { lenient: true }, secs(2), {}],
    ['config off', 0.8, {}, secs(2), { speakerLearn: false }],
    ['under 1.5 s', 0.8, {}, secs(1), {}],
    ['option off', 0.8, { learn: false }, secs(2), {}],
    ['unsure bar raised', 0.65, {}, secs(2), { speakerThreshold: 0.7, speakerGuestBelow: 0.3 }],
    ['guest', 0.2, {}, secs(2), {}],
  ];
  for (const [name, c, opts, pcm, cfg] of cases) {
    const { sp, voice } = make(A(), null, cfg);
    voice.vec = cosVec(c);
    await sp.verify(pcm, 16000, opts);
    assert.deepEqual(sp.counts(), { enrolled: 3, learned: 0 }, name);
  }
});

test('learning: custom speakerLearnAbove is honoured', async () => {
  const { sp, voice } = make(A(), null, { speakerLearnAbove: 0.9 });
  voice.vec = cosVec(0.8); await sp.verify(secs(2), 16000);
  assert.equal(sp.counts().learned, 0);
  voice.vec = cosVec(0.95); await sp.verify(secs(2), 16000);
  assert.equal(sp.counts().learned, 1);
});

test('learning at the cap replaces the closest learned print, never an enrolled one', async () => {
  const prints = [...Array.from({ length: 10 }, () => axis(0)), ...Array.from({ length: 20 }, (_, i) => axis(100 + i))];
  prints[10 + 7] = axis(1);   // the learned print closest to the new utterance
  const learned = prints.map((_, i) => i >= 10);
  const { sp, voice, read } = make(prints, learned);
  voice.vec = cosVec(0.65);
  await sp.verify(secs(2), 16000);
  assert.deepEqual(sp.counts(), { enrolled: 10, learned: 20 });
  const f = read();
  assert.equal(f.prints.length, 30);
  assert.ok(f.prints.slice(0, 10).every(p => p[0] === 1), 'enrolled untouched');
  assert.ok(Math.abs(f.prints[17][0] - 0.65) < 1e-3, 'closest learned replaced');
  assert.equal(f.prints[18][108], 1, 'other learned untouched');
});

test('learning: twenty learned with room in total still replaces rather than adds', async () => {
  const prints = [...Array.from({ length: 5 }, () => axis(0)), ...Array.from({ length: 20 }, (_, i) => axis(100 + i))];
  const { sp, voice } = make(prints, prints.map((_, i) => i >= 5));
  voice.vec = cosVec(0.65);
  await sp.verify(secs(2), 16000);
  assert.deepEqual(sp.counts(), { enrolled: 5, learned: 20 });
});

test('learning: a full profile of enrolled prints learns nothing', async () => {
  const { sp, voice, read } = make(Array.from({ length: 30 }, () => axis(0)));
  voice.vec = cosVec(0.65);
  const before = JSON.stringify(read().prints);
  await sp.verify(secs(2), 16000);
  assert.deepEqual(sp.counts(), { enrolled: 30, learned: 0 });
  assert.equal(JSON.stringify(read().prints), before);
});

test('enroll: append keeps old prints and adds new ones; default replaces', async () => {
  const { sp, voice } = make([axis(0), axis(0)]);
  voice.queue = [axis(3), axis(3)];
  const clips = [{ pcm: secs(2), rate: 16000 }, { pcm: secs(2), rate: 16000 }];
  assert.deepEqual(await sp.enroll(clips, { append: true }), { ok: true, count: 4 });
  assert.deepEqual(sp.counts(), { enrolled: 4, learned: 0 });
  voice.queue = [axis(4), axis(4)];
  assert.deepEqual(await sp.enroll(clips), { ok: true, count: 2 });
  assert.deepEqual(sp.counts(), { enrolled: 2, learned: 0 });
});

test('enroll: append over the cap drops oldest learned first, then oldest enrolled', async () => {
  const prints = [...Array.from({ length: 20 }, (_, i) => axis(i)), ...Array.from({ length: 10 }, (_, i) => axis(100 + i))];
  const a = make(prints, prints.map((_, i) => i >= 20));
  const clips = [{ pcm: secs(2), rate: 16000 }, { pcm: secs(2), rate: 16000 }, { pcm: secs(2), rate: 16000 }];
  a.voice.queue = [axis(50), axis(50), axis(50)];
  await a.sp.enroll(clips, { append: true });
  assert.deepEqual(a.sp.counts(), { enrolled: 23, learned: 7 });
  assert.equal(a.read().prints[20][103], 1, 'oldest learned (axes 100-102) went first');

  const p2 = [...Array.from({ length: 29 }, (_, i) => axis(i)), axis(100)];
  const b = make(p2, p2.map((_, i) => i === 29));
  b.voice.queue = [axis(50), axis(50), axis(50)];
  await b.sp.enroll(clips, { append: true });
  assert.deepEqual(b.sp.counts(), { enrolled: 30, learned: 0 });
  const f = b.read();
  assert.equal(f.prints[0][2], 1, 'oldest enrolled (axes 0,1) dropped');
  assert.equal(f.prints[0][0], 0);
});

test('file: a legacy file without learned loads as all enrolled; a corrupt file is not enrolled', async () => {
  const legacy = make([axis(0), axis(0), axis(0), axis(0)]);
  assert.equal(legacy.sp.enrolled(), true);
  assert.deepEqual(legacy.sp.counts(), { enrolled: 4, learned: 0 });
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  const sp = createSpeaker({ ort: fakeOrt({ vec: axis(0) }), modelPath: 'm', profileFile: file, exists: () => true });
  assert.equal(sp.enrolled(), false);
  assert.deepEqual(sp.counts(), { enrolled: 0, learned: 0 });
  assert.equal((await sp.verify(secs(2), 16000)).verdict, 'owner');
});

test('recent: keeps the last 20 scores only', async () => {
  const { sp, voice } = make(A());
  voice.vec = cosVec(0.5);
  for (let i = 0; i < 25; i++) await sp.verify(secs(2), 16000, { learn: false });
  const r = sp.recent();
  assert.equal(r.length, 20);
  assert.deepEqual(Object.keys(r[0]).sort(), ['score', 't', 'verdict']);
  assert.equal(r[0].verdict, 'owner');
});
