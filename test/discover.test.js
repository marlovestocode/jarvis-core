const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog, selectGroups } = require('../src/core/skills');
const { resolveSelection, gate, shortlist, SHORTLIST } = require('../src/core/skills/discover');
const { createFakeProvider } = require('./helpers/fake-provider');

// Small catalog: weak triggers give medium confidence, strong ones high. browser is down.
const w = (words, weight) => ({ words, w: weight });
const groups = [
  { id: 'core', label: 'Core', triggers: [], tools: [{ name: 'get_time' }] },
  { id: 'media', label: 'Media', sideEffects: 'write', triggers: [w(['music'], 3), w(['pause'], 2), w(['jazz'], 2)], tools: [{ name: 'media_pause' }] },
  { id: 'timers', label: 'Timers', sideEffects: 'write', triggers: [w(['timer'], 2)], tools: [{ name: 'timer_set' }] },
  { id: 'knowledge', label: 'Knowledge', sideEffects: 'read', triggers: [w(['weather'], 3)], tools: [{ name: 'weather' }] },
  { id: 'system', label: 'System', sideEffects: 'read', triggers: [w(['gpu'], 2), w(['temperature', 'temp'], 2)], tools: [{ name: 'gpu_temp' }] },
  { id: 'files', label: 'Files', sideEffects: 'write', triggers: [w(['files', 'delete'], 2), w(['old'], 1)], tools: [{ name: 'file_delete' }] },
  { id: 'browser', label: 'Browser', sideEffects: 'read', triggers: [w(['tabs'], 2)], tools: [{ name: 'tabs_list' }], status: () => ({ ok: false, detail: 'the Chrome extension is not connected' }) },
  { id: 'pc', label: 'PC', sideEffects: 'write', triggers: [], tools: [{ name: 'app_close' }], status: () => { throw new Error('status broke'); } },
];
const catalog = buildCatalog(groups);
const fakeP = fn => createFakeProvider([{ type: 'done' }], { constrain: fn });
const never = () => fakeP(async () => { throw new Error('model must not be called'); });
const run = (text, opts = {}) => resolveSelection({ text, catalog, owner: true, rule: selectGroups(text, { lastGroups: opts.lastGroups || [] }, catalog), ...opts });

test('simple high-confidence commands make zero provider calls', async () => {
  for (const text of ['what is the gpu temperature', 'what is my gpu temp?', 'pause the music']) {
    const p = never();
    const r = await run(text, { provider: p });
    assert.equal(selectGroups(text, {}, catalog).confidence, 'high', text);
    assert.equal(p.constrained.length, 0, text);
    assert.equal(r.source, 'rule');
    assert.equal(r.action, 'act');
    assert.equal(r.decision.gated, true);
    assert.equal(r.decision.status, 'skipped');
  }
});

test('multi-capability request: up to three groups from the interpretation', async () => {
  const p = fakeP(async () => ({ kind: 'new', groups: ['media', 'timers', 'system'], confidence: 0.9, reasoning: 'three parts' }));
  const r = await run('put on jazz, then a ten minute countdown, and how hot is the graphics card', { provider: p });
  assert.equal(p.constrained.length, 1);
  assert.deepEqual([...r.groups], ['core', 'media', 'timers', 'system']);
  assert.equal(r.action, 'act');
  assert.notEqual(r.source, 'rule');
  assert.equal(r.decision.gated, false);
  assert.equal(r.decision.status, 'ok');
  assert.equal(r.decision.kind, 'new');
  assert.deepEqual(r.decision.finalGroups, ['core', 'media', 'timers', 'system']);
});

test('ambiguous side-effect request asks with the model question; confident one acts', async () => {
  const text = 'should I delete the old files?';
  assert.equal(selectGroups(text, {}, catalog).confidence, 'high');
  const ask = 'Do you want me to delete the old files now?';
  const p = fakeP(async () => ({ kind: 'new', groups: ['files'], confidence: 0.4, ask }));
  const r = await run(text, { provider: p });
  assert.equal(p.constrained.length, 1, 'write group + question reaches the model');
  assert.equal(r.action, 'ask');
  assert.equal(r.ask, ask);
  const sure = await run(text, { provider: fakeP(async () => ({ kind: 'new', groups: ['files'], confidence: 0.9 })) });
  assert.equal(sure.action, 'act');
  assert.deepEqual([...sure.groups], ['core', 'files']);
  // no model question: a fixed one, never empty
  const bare = await run(text, { provider: fakeP(async () => ({ kind: 'new', groups: ['files'], confidence: 0.3 })) });
  assert.equal(bare.action, 'ask');
  assert.ok(bare.ask.length > 5);
});

test('timeout, malformed and throwing providers fall back to the rule result', async () => {
  const text = 'pause';   // medium: gate opens
  const rule = selectGroups(text, {}, catalog);
  const hang = fakeP(req => new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new Error('aborted')))));
  for (const [p, status] of [[hang, 'timeout'], [fakeP(async () => 'nope'), 'invalid'], [fakeP(async () => { throw new Error('x'); }), 'unavailable']]) {
    const r = await run(text, { provider: p, budgetMs: 40 });
    assert.equal(p.constrained.length, 1);
    assert.equal(r.source, 'rule');
    assert.equal(r.action, 'act');
    assert.deepEqual([...r.groups], [...rule]);
    assert.equal(r.decision.status, status);
  }
});

test('a request for an unavailable tool declines honestly', async () => {
  const p = fakeP(async () => ({ kind: 'new', groups: ['browser'], confidence: 0.9 }));
  const r = await run('which pages have I got up right now', { provider: p });
  assert.equal(r.action, 'decline');
  assert.match(r.decline, /Browser is unavailable \(the Chrome extension is not connected\)/);
});

test('followup / correction / modify with no groups reuses the last groups', async () => {
  for (const kind of ['followup', 'correction', 'modify']) {
    const p = fakeP(async () => ({ kind, groups: [], confidence: 0.8 }));
    const r = await run('do that again but louder', { provider: p, lastGroups: ['core', 'media'] });
    assert.deepEqual([...r.groups], ['core', 'media'], kind);
    assert.equal(r.action, 'act');
  }
});

test('followup reuse: slow group statuses stay inside the budget and fall back to the rule result', async () => {
  let n = 0;
  // the interpreter's own cardsNow is quick; the reuse check after it hangs
  const slow = { ...catalog, cardsNow: () => (n++ === 0 ? catalog.cardsNow() : new Promise(() => {})) };
  const p = fakeP(async () => ({ kind: 'followup', groups: [], confidence: 0.8 }));
  const t0 = Date.now();
  const r = await resolveSelection({ text: 'do that again but louder', catalog: slow, owner: true, provider: p, budgetMs: 80, lastGroups: ['core', 'media'], rule: selectGroups('do that again but louder', { lastGroups: ['core', 'media'] }, catalog) });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.source, 'rule');
  assert.equal(r.decision.status, 'timeout');
});

test('guest gets the fixed clarify answer on a low match, never the model', async () => {
  const p = never();
  const r = await resolveSelection({ text: 'turn it off', catalog, owner: false, provider: p, rule: selectGroups('turn it off', {}, catalog) });
  assert.equal(r.action, 'ask');
  assert.equal(r.decision.gated, true);
  assert.equal(p.constrained.length, 0);
});

test('guest / non-owner never reaches the model', async () => {
  for (const owner of [false, undefined]) {
    const p = never();
    const r = await resolveSelection({ text: 'blorp the frobnicator', catalog, provider: p, owner });
    assert.equal(p.constrained.length, 0);
    assert.equal(r.source, 'rule');
    assert.equal(r.decision.gated, true);
    assert.equal(r.decision.why, 'not owner');
  }
});

test('gate: low/medium open, high read-only closed, high write closed unless it reads as a question', () => {
  const p = fakeP(async () => null);
  const g = (text, opts = {}) => gate({ text, rule: selectGroups(text, {}, catalog), catalog, provider: p, owner: true, ...opts });
  assert.equal(g('blorp the frobnicator').call, true);
  assert.equal(g('pause').call, true);
  assert.equal(g('what is the gpu temperature?').call, false);
  assert.equal(g('pause the music').call, false);
  assert.equal(g('should I delete the old files?').call, true);
  assert.equal(g('he said "delete the old files"').call, true);
  assert.equal(g('pause', { provider: null }).call, false);
});

test('shortlist: narrows a large catalog lexically, and with an embed function semantically', async () => {
  const many = buildCatalog([groups[0], ...Array.from({ length: 14 }, (_, i) => ({ id: `g${i}`, label: `Group ${i}`, summary: `Handles widget number ${i} things`, examples: [`do widget ${i}`], triggers: [], tools: [{ name: `t${i}` }] })),
    { id: 'garden', label: 'Garden', summary: 'Waters the plants and checks soil moisture.', examples: ['water the tomatoes'], triggers: [], tools: [{ name: 'water' }] }]);
  const lex = await shortlist('please water my tomatoes', many, {});
  assert.ok(lex.length <= SHORTLIST);
  assert.equal(lex[0], 'garden');
  // embedding: a vector per text; the query is closest to g3
  const vec = t => (/widget number 3 |widget 3/.test(t) || /gizmo/.test(t) ? [1, 0] : [0, 1]);
  let calls = 0;
  const embed = async texts => { calls++; return texts.map(vec); };
  const sem = await shortlist('the gizmo thingy', many, { embed });
  assert.ok(calls >= 1);
  assert.equal(sem[0], 'g3');
  // keep: rule and last groups always stay in
  const kept = await shortlist('please water my tomatoes', many, { keep: ['g9'] });
  assert.ok(kept.includes('g9'));
  // the interpreter is only shown the shortlisted cards
  const p = fakeP(async () => ({ kind: 'new', groups: ['garden'], confidence: 0.9 }));
  const r = await resolveSelection({ text: 'please water my tomatoes', catalog: many, provider: p, owner: true });
  assert.deepEqual([...r.groups], ['core', 'garden']);
  const prompt = p.constrained[0].messages.map(m => m.content).join('\n');
  const listed = prompt.split('\n').filter(l => /^- g\d+ /.test(l)).length;
  assert.ok(listed < 14, `listed ${listed}`);
  // a failing embed falls back to lexical
  const bad = await shortlist('please water my tomatoes', many, { embed: async () => { throw new Error('down'); } });
  assert.equal(bad[0], 'garden');
});

test('latency guard: rule-only path adds <5ms avg over 200 calls with no provider touch', async () => {
  const p = never();
  const texts = ['pause the music', 'what is the gpu temperature', 'whats the weather'];
  const rules = texts.map(t => selectGroups(t, {}, catalog));
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) {
    const r = await resolveSelection({ text: texts[i % 3], rule: rules[i % 3], catalog, provider: p, owner: true });
    assert.equal(r.source, 'rule');
  }
  const avgMs = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
  assert.ok(avgMs < 5, `avg ${avgMs}ms`);
  assert.equal(p.constrained.length, 0);
});

test('fix: followup reuse skips down and unknown-risky groups, and never overrides a decline', async () => {
  const r = await run('do that again', { provider: fakeP(async () => ({ kind: 'followup', groups: [], confidence: 0.8 })), lastGroups: ['core', 'browser', 'pc', 'system'] });
  assert.deepEqual([...r.groups], ['core', 'system']);
  const d = await run('do that again', { provider: fakeP(async () => ({ kind: 'followup', groups: ['browser'], confidence: 0.9 })), lastGroups: ['core', 'media'] });
  assert.equal(d.action, 'decline');
  assert.match(d.decline, /Browser is unavailable/);
});

test('fix: unsure model with no groups on a risky rule pick asks, never acts', async () => {
  const r = await run('should I delete the old files?', { provider: fakeP(async () => ({ kind: 'chat', groups: [], confidence: 0.3 })) });
  assert.equal(r.action, 'ask');
  assert.ok(r.ask.length > 5);
});

test('fix: polite orders and a stray "read" make zero provider calls', async () => {
  for (const text of ['can you pause the music?', 'could you please pause the music?', 'please pause the music?', 'pause the music, then read the article']) {
    const p = never();
    const r = await run(text, { provider: p });
    assert.equal(p.constrained.length, 0, text);
    assert.equal(r.action, 'act');
  }
  // a real question still opens the gate
  const p = fakeP(async () => ({ kind: 'chat', groups: [], confidence: 0.9 }));
  await run('why did the music pause?', { provider: p });
  assert.equal(p.constrained.length, 1);
});

test('merge: unsure pick is added to the rule pick (merged), model pick first under the cap', async () => {
  const r = await run('gpu', { provider: fakeP(async () => ({ kind: 'new', groups: ['knowledge'], confidence: 0.4 })) });
  assert.equal(r.action, 'act');
  assert.deepEqual([...r.groups], ['core', 'knowledge', 'system']);
  assert.equal(r.source, 'merged');
  // rule already has two groups: the model's risky pick survives the cap and triggers the ask
  const two = await run('gpu weather', { provider: fakeP(async () => ({ kind: 'new', groups: ['files'], confidence: 0.4 })) });
  assert.deepEqual([...two.groups], ['core', 'files', 'knowledge']);
  assert.equal(two.action, 'ask');
});

test('merge: a low rule match is replaced by the model pick; chat goes to knowledge', async () => {
  const r = await run('blorp the frobnicator', { provider: fakeP(async () => ({ kind: 'new', groups: ['system'], confidence: 0.5 })) });
  assert.deepEqual([...r.groups], ['core', 'system']);
  assert.equal(r.source, 'model');
  assert.equal(r.action, 'act');
  const c = await run('blorp the frobnicator', { provider: fakeP(async () => ({ kind: 'chat', groups: [], confidence: 0.9 })) });
  assert.deepEqual([...c.groups], ['core', 'knowledge']);
});

test('resolveSelection: a large catalog is shortlisted with the embed function', async () => {
  const many = buildCatalog([groups[0], ...Array.from({ length: 14 }, (_, i) => ({ id: `g${i}`, label: `Group ${i}`, summary: `Handles widget number ${i} things`, examples: [`do widget ${i}`], triggers: [], tools: [{ name: `t${i}` }] }))]);
  let calls = 0;
  const embed = async texts => { calls++; return texts.map(t => (/widget number 3 |gizmo/.test(t) ? [1, 0] : [0, 1])); };
  const p = fakeP(async () => ({ kind: 'new', groups: ['g3'], confidence: 0.9 }));
  const r = await resolveSelection({ text: 'the gizmo thingy', catalog: many, provider: p, owner: true, embed });
  assert.ok(calls >= 1);
  assert.deepEqual([...r.groups], ['core', 'g3']);
  const prompt = p.constrained[0].messages.map(m => m.content).join('\n');
  assert.match(prompt, /- g3 /);
  assert.ok(prompt.split('\n').filter(l => /^- g\d+ /.test(l)).length <= SHORTLIST);
});

test('fix: a polite head does not hide a question after it', async () => {
  const p = fakeP(async () => ({ kind: 'chat', groups: [], confidence: 0.9 }));
  await run('can you explain how to delete old files?', { provider: p });
  assert.equal(p.constrained.length, 1);
  const q = never();
  await run('can you pause the music?', { provider: q });
  assert.equal(q.constrained.length, 0);
});

test('fix: a confident non-chat reading with no groups on a risky rule pick asks', async () => {
  const r = await run('should I delete the old files?', { provider: fakeP(async () => ({ kind: 'new', groups: [], confidence: 0.9 })) });
  assert.equal(r.action, 'ask');
  assert.ok(r.ask.length > 5);
});
