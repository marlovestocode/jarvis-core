const test = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('../src/core/brain/plan');

const NOW = 1_700_000_000_000;
const deep = (extra = {}) => ({ tier: 'deep', tools: true, think: false, depth: 1, steps: 1, reason: 'r', ...extra });
const chat = () => ({ tier: 'quick', tools: false, think: false, reason: 'chat' });
const LIVE = { tools: [] };
const catalog = { ids: ['core', 'knowledge', 'files', 'web'] };

// builds injected fakes that record their calls
function fakes(hints, picked) {
  const calls = { route: [], sel: [] };
  return {
    calls,
    route: (t, o) => { calls.route.push([t, o]); return hints; },
    selectGroups: (t, o) => { calls.sel.push([t, o]); return picked; },
  };
}
const run = (text, snap, hints, picked, extra = {}) => {
  const f = fakes(hints, picked);
  const out = plan(text, snap, { source: 'text', lastGroups: ['last'], catalog, now: NOW, route: f.route, selectGroups: f.selectGroups, ...extra });
  return { out, f };
};

test('plan: snap absent returns the direct results', () => {
  for (const snap of [undefined, null, {}, 5, 'x']) {
    const hints = deep();
    const picked = ['core', 'files'];
    picked.confidence = 0.9;
    const { out, f } = run('hi', snap, hints, picked, { fu: { kind: 'continue', groups: ['web'] } });
    assert.equal(out.hints, hints);
    assert.equal(out.picked, picked);
    assert.deepEqual([...out.avoid.tools], []);
    assert.deepEqual([...out.avoid.models], []);
    assert.deepEqual(out.notes, []);
    assert.deepEqual(f.calls.sel[0][1].lastGroups, ['last']);
  }
});

test('plan: no selectGroups gives picked null, no route gives undefined hints', () => {
  const out = plan('hi', {}, { source: 'text', catalog, now: NOW });
  assert.equal(out.picked, null);
  assert.equal(out.hints, undefined);
});

test('plan: continue seeds selectGroups with fu.groups', () => {
  const { f } = run('again', { tools: [] }, deep(), ['core', 'web'], { fu: { kind: 'continue', groups: ['files'] } });
  assert.deepEqual(f.calls.sel[0][1].lastGroups, ['files']);
});

test('plan: continue uses fu.groups when only core is picked', () => {
  const { out } = run('again', LIVE, deep(), ['core'], { fu: { kind: 'continue', groups: ['files'] } });
  assert.deepEqual(out.picked, ['files']);
  const keep = ['core', 'web'];
  assert.equal(run('again', LIVE, deep(), keep, { fu: { kind: 'continue', groups: ['files'] } }).out.picked, keep);
});

test('plan: continue turns a chat route into a follow-up tools turn, leaves others', () => {
  const orig = chat();
  const { out } = run('again', LIVE, orig, ['core'], { fu: { kind: 'continue', groups: ['files'] } });
  assert.deepEqual(out.hints, { ...orig, tier: 'deep', tools: true, think: false, reason: 'follow-up' });
  assert.equal(orig.tools, false);
  const d = deep();
  assert.equal(run('again', LIVE, d, ['core'], { fu: { kind: 'continue', groups: ['files'] } }).out.hints, d);
});

test('plan: media follow-up changes nothing', () => {
  const c = chat();
  const picked = ['core'];
  const { out, f } = run('x', LIVE, c, picked, { fu: { kind: 'media' } });
  assert.equal(out.hints, c);
  assert.equal(out.picked, picked);
  assert.deepEqual(f.calls.sel[0][1].lastGroups, ['last']);
});

test('plan: pending confirm rewrites a chat route and adds a known group', () => {
  const snap = { confirm: { summary: 'delete', group: 'files' } };
  const { out } = run('thanks', snap, chat(), ['core'], { fu: null });
  assert.equal(out.hints.tools, true);
  assert.equal(out.hints.tier, 'deep');
  assert.equal(out.hints.think, false);
  assert.equal(out.hints.reason, 'confirm pending');
  assert.deepEqual(out.picked, ['core', 'files']);
  assert.ok(out.notes.includes('confirm pending'));
});

test('plan: confirm group unknown to the catalog is not added; a missing group is fine', () => {
  const a = run('x', { confirm: { summary: 's', group: 'nope' } }, chat(), ['core']).out;
  assert.deepEqual(a.picked, ['core']);
  const b = run('x', { confirm: { summary: 's' } }, chat(), ['core']).out;
  assert.equal(b.hints.reason, 'confirm pending');
});

test('plan: confirm does not fire for yes/no, no confirm, or an old confirm', () => {
  const c = chat();
  const yes = run('yes', { confirm: { summary: 's', group: 'files' } }, c, ['core'], { fu: { kind: 'confirm' } }).out;
  assert.equal(yes.hints, c);
  assert.deepEqual(yes.picked, ['core']);
  assert.deepEqual(yes.notes, []);
  assert.equal(run('x', LIVE, c, ['core']).out.hints, c);
  const old = run('x', { confirm: { summary: 's', ageMs: 6 * 60000 } }, c, ['core']).out;
  assert.equal(old.hints, c);
  const young = run('x', { confirm: { summary: 's', ageMs: 1000 } }, c, ['core']).out;
  assert.equal(young.hints.reason, 'confirm pending');
});

test('plan: confirm leaves a tools route alone', () => {
  const d = deep();
  const { out } = run('x', { confirm: { summary: 's' } }, d, ['core']);
  assert.equal(out.hints, d);
  assert.ok(out.notes.includes('confirm pending'));
});

const voice = (hints, picked, snap = LIVE, fu = null) => run('x', snap, hints, picked, { source: 'voice', fu }).out;

test('plan: voice prefers fast when every condition holds', () => {
  const d = deep();
  const out = voice(d, ['core', 'files']);
  assert.equal(out.hints.prefer, 'fast');
  assert.equal(d.prefer, undefined);
  assert.ok(out.notes.includes('voice: fast'));
  assert.equal(voice(deep(), ['core']).hints.prefer, 'fast');
  assert.equal(voice(deep(), null).hints.prefer, 'fast');
});

test('plan: voice never prefers fast otherwise', () => {
  assert.equal(run('x', LIVE, deep(), ['core'], { source: 'text' }).out.hints.prefer, undefined);
  assert.equal(voice(deep({ depth: 2 }), ['core']).hints.prefer, undefined);
  assert.equal(voice(deep({ think: true }), ['core']).hints.prefer, undefined);
  assert.equal(voice(deep({ steps: 2 }), ['core']).hints.prefer, undefined);
  assert.equal(voice(deep(), ['core', 'files', 'web']).hints.prefer, undefined);
  assert.equal(voice(deep(), ['core', 'files'], { confirm: { summary: 's' } }).hints.prefer, undefined);
  assert.equal(voice({ tier: 'quick', tools: true, think: false, depth: 1, steps: 1 }, ['core']).hints.prefer, undefined);
});

test('plan: cooldown reports cooling tools and models', () => {
  const snap = {
    tools: [
      { name: 'web_search', ok: false, t: NOW - 1000 },
      { name: 'web_search', ok: false, t: NOW - 2000 },
      { name: 'fine', ok: true, t: NOW - 1000 },
    ],
    models: [{ name: 'm-old', t: NOW - 9000 }, { name: 'm-new', t: NOW - 1000 }, { name: 'm-old', t: NOW - 8000 }, { name: 'm-new', t: NOW - 500 }, { name: 'one', t: NOW }],
  };
  const d = deep();
  const { out } = run('x', snap, d, ['core']);
  assert.deepEqual([...out.avoid.tools], ['web_search']);
  assert.deepEqual([...out.avoid.models].sort(), ['m-new', 'm-old']);
  assert.equal(out.hints.avoid, 'm-new');
  assert.equal(d.avoid, undefined);
  assert.ok(out.notes.includes('cooldown: web_search'));
});

test('plan: nothing cooling gives empty sets and no hints.avoid', () => {
  const d = deep();
  const { out } = run('x', { tools: [{ name: 't', ok: false, t: NOW }] }, d, ['core']);
  assert.equal(out.hints, d);
  assert.equal(out.avoid.tools.size, 0);
  assert.equal(out.avoid.models.size, 0);
  assert.equal('avoid' in out.hints, false);
});

test('plan: does not mutate snap or route output, fresh sets each call', () => {
  const snap = { confirm: { summary: 's', group: 'files' }, tools: [{ name: 't', ok: false, t: NOW }, { name: 't', ok: false, t: NOW }], models: [{ name: 'm', t: NOW }, { name: 'm', t: NOW }] };
  const copy = JSON.parse(JSON.stringify(snap));
  const c = chat();
  const cc = { ...c };
  const a = run('x', snap, c, ['core'], { source: 'voice' }).out;
  const b = run('x', snap, c, ['core'], { source: 'voice' }).out;
  assert.deepEqual(snap, copy);
  assert.deepEqual(c, cc);
  assert.notEqual(a.avoid.tools, b.avoid.tools);
  assert.notEqual(a.avoid.models, b.avoid.models);
});

test('plan: throwing route or selectGroups propagates; malformed cooldown input is empty', () => {
  const ok = { selectGroups: () => ['core'], catalog, now: NOW, source: 'text' };
  assert.throws(() => plan('x', LIVE, { ...ok, route: () => { throw new Error('boom'); } }), /boom/);
  assert.throws(() => plan('x', LIVE, { ...ok, route: () => deep(), selectGroups: () => { throw new Error('bang'); } }), /bang/);
  const out = plan('x', { tools: 'bad', models: [null, 5, {}] }, { ...ok, route: () => deep() });
  assert.equal(out.avoid.tools.size, 0);
  assert.equal(out.avoid.models.size, 0);
});
