// Retrieval-quality behaviour of cortex recall (2026-11-12 pass): vector floor, typed/directed/confidence-aware spread,
// bounded activation, conflict and duplicate handling, freshness vs use, explainability.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/core/cortex/db');
const { createSources } = require('../src/core/cortex/sources');
const { createNodes } = require('../src/core/cortex/nodes');
const { createEdges, PROPAGATE, REVERSE } = require('../src/core/cortex/edges');
const { createVectors } = require('../src/core/cortex/vectors');
const { createFakeEmbedder, withQueryCache } = require('../src/core/cortex/embedder');
const { createRecall } = require('../src/core/cortex/recall');

const T0 = 1_700_000_000_000, DAY = 864e5;
function setup({ embedder = null, recallOpts = {} } = {}) {
  let clock = T0;
  const now = () => clock;
  const db = openDb({ file: ':memory:' });
  const sources = createSources(db, { now });
  const nodes = createNodes(db, { now, sources });
  const edges = createEdges(db, { now });
  const vectors = createVectors(db, { dim: 64, model: 'fake' });
  const queryVector = embedder ? withQueryCache(embedder).query : async () => null;
  const { recall } = createRecall({ db, edges, vectors, queryVector, now, ...recallOpts });
  const src = Object.fromEntries(['user', 'tool', 'model', 'web'].map(k => [k, sources.add({ kind: k, ref: 't-' + k })]));
  const add = (kind, text, extra = {}) => nodes.upsert({ kind, text, source: src[extra.src || 'user'], ...extra }).id;
  const embedAll = async ids => { for (const id of ids) vectors.put(id, (await embedder.embed([db.stmt('SELECT text FROM node WHERE id = ?').get(id).text]))[0]); };
  return { db, nodes, edges, vectors, recall, add, src, sources, embedAll, setNow: t => { clock = t; }, now };
}

test('retrieval: type tables cover every edge type; bookkeeping edges pass nothing', () => {
  const { TYPES } = require('../src/core/cortex/edges');
  for (const t of Object.keys(TYPES)) assert.equal(typeof PROPAGATE[t], 'number', t);
  for (const t of ['supersedes', 'contradicts', 'same_as']) assert.equal(PROPAGATE[t], 0);
  assert.ok(PROPAGATE.touched < PROPAGATE.part_of, 'a behavioural association passes less than structure');
  for (const t of Object.keys(REVERSE)) assert.ok(REVERSE[t] < 1);
});

test('retrieval: vector neighbours of an unrelated query are not seeds', async () => {
  const embedder = createFakeEmbedder({ dim: 64 });
  const { recall, add, embedAll } = setup({ embedder });
  await embedAll([add('fact', 'Maya lives in Portland and works as a nurse'), add('fact', 'dark roast coffee with no sugar')]);
  const r = await recall('quantum chromodynamics gluon confinement', { vecFloor: 0.3 });
  assert.equal(r.mode, 'empty');
  assert.equal(r.text, '');
});

test('retrieval: only vector hits close to the best one seed the spread', async () => {
  const embedder = createFakeEmbedder({ dim: 64, synonyms: { pooch: 'rex', checkup: 'appointment', schedule: 'today' } });
  const { recall, add, embedAll } = setup({ embedder, recallOpts: { vecFloor: 0.1, vecBand: 0.1 } });
  const near = add('fact', 'Rex appointment today');
  const far = add('fact', 'Rex bills garage door fence paint repair work');
  await embedAll([near, far]);
  const r = await recall('pooch checkup schedule', { debug: true });   // no word in common with either text: only vectors can find them
  assert.ok(r.items.some(i => i.id === near));
  assert.ok(!r.stages.seeds.some(s => s.id === far), 'the weak neighbour is outside the band');
});

test('retrieval: a weak lexical match on one generic word is not a seed beside a strong one', async () => {
  const { recall, add } = setup();
  const good = add('fact', 'The vet clinic phone number is on the fridge');
  add('fact', 'My phone is a Pixel with a cracked screen and a red case and a long cable and a stand');
  const r = await recall('vet clinic phone number', { debug: true });
  assert.deepEqual(r.stages.seeds.map(s => s.id), [good]);
});

test('retrieval: supersedes, contradicts and same_as never carry activation', async () => {
  const { recall, add, edges } = setup();
  const seed = add('fact', 'Rex has a vet visit in March');
  const old = add('fact', 'Rex had a vet visit in January', { status: 'active' });
  const rival = add('fact', 'Luna has her own appointment sometime');
  const twin = add('fact', 'Zebra crossing near the school');
  edges.link(seed, old, 'supersedes', { weight: 1 });
  edges.link(seed, rival, 'contradicts', { weight: 1 });
  edges.link(seed, twin, 'same_as', { weight: 1 });
  const r = await recall('vet visit March', { debug: true });
  for (const id of [rival, twin]) assert.ok(!r.stages.spread.some(x => x.id === id), 'no activation through bookkeeping edges');
});

test('retrieval: an association alone does not surface a model guess, a direct match does', async () => {
  const { recall, add, edges } = setup();
  const seed = add('fact', 'Rex has a vet visit in March');
  const guess = add('fact', 'Probably enjoys swimming at the lake', { src: 'model' });
  const stated = add('fact', 'Rex eats salmon kibble every day', { src: 'user' });
  edges.link(seed, guess, 'mentions', { weight: 0.9 });
  edges.link(seed, stated, 'mentions', { weight: 0.9 });
  const a = (await recall('vet visit March', { debug: true })).stages.spread;
  const act = id => a.find(x => x.id === id)?.a ?? 0;
  assert.ok(act(guess) > 0 && act(stated) > 0);
  assert.ok(act(guess) < act(stated) * 0.5, `guess ${act(guess)} vs stated ${act(stated)}`);
  const direct = await recall('swimming lake');
  assert.ok(direct.items.some(i => i.id === guess), 'asked for directly, it is still found');
});

test('retrieval: a hub reached from several seeds stays below a seed (activation is bounded)', async () => {
  const { recall, add, edges } = setup();
  const hub = add('entity', 'Rex', { key: 'entity:rex' });
  const ids = [];
  for (let i = 0; i < 6; i++) { const f = add('fact', `vet visit number ${i} was on a Tuesday`); edges.link(f, hub, 'mentions', { weight: 1 }); ids.push(f); }
  const out = await recall('vet visit Tuesday', { debug: true });
  const a = new Map(out.stages.spread.map(x => [x.id, x.a]));
  assert.ok(a.get(hub) < 1, 'the hub got ' + a.get(hub));
  for (const id of ids) assert.ok(a.get(id) <= 1 + 1e-9);
});

test('retrieval: activation does not echo back to where it came from', async () => {
  const { recall, add, edges } = setup();
  const seed = add('fact', 'Rex has a vet visit in March');
  const other = add('entity', 'Clinic', { key: 'entity:clinic' });
  edges.link(seed, other, 'part_of', { weight: 1 });
  edges.link(other, seed, 'part_of', { weight: 1 });
  const out = await recall('vet visit March', { debug: true });
  assert.equal(out.stages.spread.find(x => x.id === seed).a, 1, 'the seed keeps its own activation');
});

test('retrieval: walking a mentions edge backwards passes less than forwards', async () => {
  const { recall, add, edges } = setup();
  const a = add('fact', 'Rex has a vet visit in March');
  const ent = add('entity', 'Parkside', { key: 'entity:parkside' });
  const b = add('fact', 'Parkside has free parking');
  edges.link(a, ent, 'mentions', { weight: 0.8 });   // a → ent forward
  edges.link(b, ent, 'mentions', { weight: 0.8 });   // ent → b is the reverse of b's edge
  const sp = (await recall('vet visit March', { debug: true })).stages.spread;
  const act = id => sp.find(x => x.id === id)?.a ?? 0;
  assert.ok(act(ent) > 0 && act(b) > 0);
  const expectedB = act(ent) * 0.8 * PROPAGATE.mentions * REVERSE.mentions * 0.25;
  assert.ok(Math.abs(act(b) - expectedB) < 1e-6, `${act(b)} vs ${expectedB}`);
});

test('retrieval: the replaced value and the lower-trust rival do not appear beside the current one', async () => {
  const { recall, add, nodes, src } = setup();
  nodes.upsert({ kind: 'fact', key: 'pref:editor', text: 'My editor is vim', source: src.user });
  const cur = nodes.upsert({ kind: 'fact', key: 'pref:editor', text: 'My editor is VS Code', source: src.user }).id;
  const guess = nodes.upsert({ kind: 'fact', key: 'pref:editor', text: 'Probably prefers editor emacs', source: src.model });
  assert.equal(guess.conflict, 'contradicts');
  const r = await recall('which editor do I use', { debug: true });
  assert.deepEqual(r.items.map(i => i.id), [cur]);
  assert.deepEqual(r.explain.dropped.map(d => [d.id, d.reason, d.by]), [[guess.id, 'contradicted', cur]]);
  // the disputed claim is kept, not discarded: with no current value retrieved it is still available
  const alone = await recall('editor emacs', { kinds: ['fact'], exclude: [cur] });
  assert.ok(alone.items.some(i => i.id === guess.id));
});

test('retrieval: near-duplicates are packed once, distinct neighbours are kept', async () => {
  const { recall, add, edges } = setup();
  const a = add('fact', 'Standup meeting is every weekday at 9:30 am');
  const b = add('fact', 'The weekday standup meeting happens at 9:30 am', { src: 'tool' });
  const c = add('fact', 'Retro meeting is every second Friday at 3 pm');
  edges.link(a, b, 'similar', { weight: 0.93 });
  const r = await recall('standup meeting', { debug: true });
  assert.ok(r.items.some(i => i.id === a));
  assert.ok(!r.items.some(i => i.id === b));
  assert.deepEqual(r.explain.dropped.filter(d => d.id === b).map(d => d.reason), ['duplicate']);
  const both = await recall('meeting');
  assert.ok(both.items.some(i => i.id === c), 'a different meeting is not a duplicate');
});

test('retrieval: texts that repeat the same words are packed once even without any link', async () => {
  const { recall, add } = setup();
  const a = add('fact', 'Rex eats Orijen salmon kibble twice a day');
  const b = add('fact', 'Rex eats Orijen salmon kibble twice a day!!', { src: 'tool' });   // same words, different bytes
  const out = await recall('Rex salmon kibble');
  assert.equal(out.items.length, 1);
  assert.ok([a, b].includes(out.items[0].id));
});

test('retrieval: being recalled often does not keep a stale fact above a newer one', async () => {
  const { recall, add, nodes, setNow } = setup();
  setNow(T0 - 900 * DAY);
  const old = add('fact', 'I live in Austin near the river');
  setNow(T0 - 30 * DAY);
  const fresh = add('fact', 'I live in Denver near the park');
  setNow(T0);
  for (let i = 0; i < 40; i++) nodes.touch([old]);
  nodes.flushUses();
  const r = await recall('where do I live', { now: T0 });
  assert.equal(r.items[0].id, fresh);
});

test('retrieval: restating a fact refreshes it; an importer or a model repeating it does not', () => {
  const { db, nodes, setNow, src } = setup();
  setNow(T0 - 100 * DAY);
  const id = nodes.upsert({ kind: 'fact', key: 'k1', text: 'I live in Denver', source: src.user }).id;
  const upd = () => db.stmt('SELECT updated FROM node WHERE id = ?').get(id).updated;
  const prov = s => db.stmt('SELECT at FROM provenance WHERE node_id = ? AND source_id = ?').get(id, s)?.at;
  setNow(T0 - 50 * DAY);
  nodes.upsert({ kind: 'fact', key: 'k1', text: 'I live in Denver', source: src.model });
  assert.equal(upd(), T0 - 100 * DAY, 'a model repeating it is not a confirmation');
  assert.equal(prov(src.model), T0 - 50 * DAY);
  setNow(T0 - 10 * DAY);
  nodes.upsert({ kind: 'fact', key: 'k1', text: 'I live in Denver', source: src.user });
  assert.equal(upd(), T0 - 10 * DAY, 'the user saying it again refreshes it');
  assert.equal(prov(src.user), T0 - 10 * DAY, 'provenance records when it was last said');
});

test('retrieval: agreement among guesses never makes a node established', () => {
  const { nodes, sources } = setup();
  const agree = (kind, key, text, n) => {
    const id = nodes.upsert({ kind: 'fact', key, text, source: sources.add({ kind, ref: kind + '0' }) }).id;
    for (let i = 1; i < n; i++) nodes.upsert({ kind: 'fact', key, text, source: sources.add({ kind, ref: kind + i }) });
    return nodes.get(id).confidence;
  };
  assert.ok(agree('model', 'g1', 'Probably likes tea', 12) < 50);
  assert.equal(agree('web', 'g2', 'The shop opens at nine', 6), 49);
  assert.equal(agree('wiki', 'g3', 'Paris is in France', 2), 75, 'established sources still add up');
});

test('retrieval: far-tail candidates do not fill the budget', async () => {
  const { recall, add, edges } = setup();
  const seed = add('fact', 'Rex has a vet visit in March');
  const mid = add('entity', 'Parkside', { key: 'entity:parkside' });
  edges.link(seed, mid, 'part_of', { weight: 1 });
  const tail = add('fact', 'Parkside sells kibble');
  edges.link(mid, tail, 'part_of', { weight: 0.1 });
  const out = await recall('vet visit March', { debug: true });
  assert.ok(out.items.some(i => i.id === seed));
  assert.ok(!out.items.some(i => i.id === tail));
  assert.ok(out.explain.dropped.some(d => d.id === tail && d.reason === 'weak') || !out.stages.spread.some(x => x.id === tail));
});

test('retrieval: debug explains each item and the normal result carries no diagnostics', async () => {
  const embedder = createFakeEmbedder({ dim: 64 });
  const { recall, add, embedAll } = setup({ embedder, recallOpts: { vecFloor: 0.1 } });
  const seed = add('fact', 'Rex has a vet appointment in March');
  await embedAll([seed]);
  const plain = await recall('vet appointment for Rex March');
  assert.equal(plain.explain, undefined);
  assert.equal(plain.stages, undefined);
  const out = await recall('vet appointment for Rex March', { debug: true });
  const ex = out.explain.items.find(e => e.id === seed);
  assert.equal(ex.hops, 0);
  assert.ok(ex.fts.rank >= 1 && ex.vec.rank >= 1, 'found by both lexical and vector search');
  assert.deepEqual(Object.keys(ex.factors).sort(), ['activation', 'confidence', 'freshness', 'importance', 'relevance', 'use']);
});

test('retrieval: debug traces the edges a two-hop result came through', async () => {
  const { recall, add, edges } = setup();
  const seed = add('fact', 'Rex has a vet appointment in March');
  const ent = add('entity', 'Rex', { key: 'entity:rex' });
  const hop = add('fact', 'Rex loves a red rubber ball');
  edges.link(seed, ent, 'mentions', { weight: 0.9 });
  edges.link(hop, ent, 'mentions', { weight: 0.9 });
  const out = await recall('vet appointment March', { debug: true });
  const ex = out.explain.items.find(e => e.id === hop);
  assert.equal(ex.seed, null);
  assert.equal(ex.hops, 2);
  assert.ok(ex.via.some(v => v.from === ent && v.type === 'mentions' && v.dir === 'in' && v.hop === 2));
});

test('retrieval: recall stays safe when edges or rows disappear mid-way', async () => {
  const { recall, add, edges, db } = setup();
  const seed = add('fact', 'Rex has a vet visit in March');
  const other = add('fact', 'Rex has a groomer visit in April');
  edges.link(seed, other, 'part_of', { weight: 1 });
  const broken = { ...edges, around: () => { throw new Error('boom'); } };
  const { recall: r2 } = createRecall({ db, edges: broken, vectors: createVectors(db, { dim: 8 }), now: () => T0 });
  const out = await r2('vet visit March');
  assert.equal(out.mode, 'empty');   // recall never throws: a failure is an empty result
  assert.ok((await recall('vet visit March')).items.length >= 1);
});

test('retrieval: an old but important or profile-tier fact keeps its weight', async () => {
  const { recall, add, setNow } = setup();
  setNow(T0 - 1500 * DAY);
  const allergy = add('fact', 'I am allergic to penicillin so tell any doctor', { importance: 0.9 });
  const profile = add('fact', 'My doctor is Dr Alvarez and I keep it on file', { data: { tier: 'profile' } });
  setNow(T0 - 3 * DAY);
  const lunch = add('fact', 'Had lunch at a cafe near the doctor office', { importance: 0.2 });
  setNow(T0);
  const out = await recall('doctor', { debug: true });
  const f = id => out.explain.items.find(i => i.id === id).factors.freshness;
  assert.ok(f(allergy) >= 0.9 && f(profile) >= 0.9, `${f(allergy)} ${f(profile)}`);
  assert.ok(out.items.findIndex(i => i.id === allergy) < out.items.findIndex(i => i.id === lunch));
});

test('retrieval: a temporary note stops being recalled once data.expires passes', async () => {
  const { recall, add } = setup();
  const lapsed = add('fact', 'Parked the car on level 3 spot 14', { data: { expires: new Date(T0 - DAY).toISOString() } });
  const live = add('fact', 'Parked the bike at the north rack', { data: { expires: new Date(T0 + DAY).toISOString() } });
  const out = await recall('where did I park', { now: T0 });
  assert.ok(!out.items.some(i => i.id === lapsed));
  assert.ok(out.items.some(i => i.id === live));
  assert.equal((await recall('where did I park', { now: T0 + 2 * DAY })).items.length, 0);
});

test('retrieval: the context the user is in breaks a tie between equal answers, but never outvotes the question', async () => {
  const { recall, add } = setup();
  const vet = add('fact', 'Rex has an appointment on March 14');
  const dentist = add('fact', 'Dr Alvarez has an appointment every six months');
  const ctx = await recall('when is the next appointment', { context: 'Rex' });
  assert.equal(ctx.items[0].id, vet);
  const deictic = await recall('and the one after that', { context: 'Rex appointment' });   // nothing in the question to match
  assert.ok(deictic.items.some(i => i.id === vet));
  const dentistAsked = await recall('dentist appointment Alvarez', { context: 'Rex' });
  assert.equal(dentistAsked.items[0].id, dentist);
});

test('retrieval: the older of two similar facts yields, unless it is better established', async () => {
  const { recall, add, edges, setNow, db } = setup();
  setNow(T0 - 800 * DAY);
  const oldJob = add('fact', 'I work at Initech as an analyst');
  setNow(T0 - 40 * DAY);
  const newJob = add('fact', 'I work at Globex as a manager');
  setNow(T0);
  edges.link(oldJob, newJob, 'similar', { weight: 0.84 });
  let out = await recall('where do I work', { debug: true });
  assert.equal(out.items[0].id, newJob);
  assert.ok(!out.items.some(i => i.id === oldJob), 'the replaced version is not read out beside the new one');
  assert.ok(out.explain.dropped.some(d => d.id === oldJob && d.reason === 'weak'));
  db.stmt('UPDATE node SET confidence = 60 WHERE id = ?').run(newJob);   // the older one is the surer of the two now
  out = await recall('where do I work', { debug: true });
  assert.ok(out.items.some(i => i.id === oldJob), 'no penalty when the older one is better established');
});

test('retrieval: vectors.similarity returns the cosine for the nodes asked about', async () => {
  const embedder = createFakeEmbedder({ dim: 64 });
  const { vectors, add, embedAll } = setup({ embedder });
  const a = add('fact', 'Rex has a vet appointment'), b = add('fact', 'garage door fence paint'), c = add('fact', 'no vector for this one');
  await embedAll([a, b]);
  const [q] = await embedder.embed(['Rex vet appointment']);
  const s = vectors.similarity(q, [a, b, c]);
  assert.ok(s.get(a) > 0.7 && s.get(b) < 0.3 && !s.has(c));
});

test('retrieval: a neighbour unrelated to the question is left out, even when a strong edge leads to it', async () => {
  const embedder = createFakeEmbedder({ dim: 64 });
  const { recall, add, edges, embedAll } = setup({ embedder, recallOpts: { vecFloor: 0.3, vecBand: 0.5 } });
  const seed = add('fact', 'Rex has a vet appointment in March');
  const far = add('fact', 'garage door fence paint repair work');
  edges.link(seed, far, 'part_of', { weight: 1 });
  await embedAll([seed, far]);
  const out = await recall('vet appointment March Rex', { debug: true });
  assert.deepEqual(out.items.map(i => i.id), [seed]);
  assert.ok(out.explain.dropped.some(d => d.id === far && d.reason === 'weak'));
});
