'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NEEDS_OK } = require('../src/core/brain/guard');
const { createRoutineStore } = require('../src/core/routines/store');
const { createTokens } = require('../src/core/routines/close-tool');
const { createRoutineRunner } = require('../src/core/routines/run');

const GAME = { name: 'Game Mode', steps: [
  { tool: 'routine_close', args: { name: 'Discord' } }, { tool: 'routine_close', args: { name: 'Chrome' } },
  { tool: 'focus_assist', args: { on: true } }, { tool: 'set_system_volume', args: { percent: 40 } },
  { tool: 'audio_output_set', args: { name: 'headphones' } }, { tool: 'youtube_music', args: { action: 'play', query: 'Lo-fi' } },
] };
const QUIET = { name: 'Quiet', steps: [{ tool: 'focus_assist', args: { on: true } }] };

function setup() {
  const store = createRoutineStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-rr-')), 'r.json') });
  store.save(GAME); store.save(QUIET);
  const order = [];
  const tokens = createTokens();
  const started = [];
  const proposals = [];
  const runner = { async start(o) { order.push('start'); started.push({ ...o, tokenValid: o.steps.filter(s => s.tool === 'routine_close').map(s => tokens.valid(s.args.token)) }); return { ok: true, text: 'Done: 6/6 steps', task: { id: 't1' } }; } };
  const confirm = { propose(a) { proposals.push(a); return `${NEEDS_OK}${a.summary}. Say yes to confirm.`; } };
  const undone = [];
  const rr = createRoutineRunner({
    store, runner, confirm, tokens, now: () => 1000,
    snapshot: async ({ steps }) => { order.push('snapshot'); return { at: 1000, volume: 20, steps: steps.length }; },
    undo: async ({ snapshot }) => { undone.push(snapshot); return { ok: true, lines: ['Restored volume to 20%.'] }; },
  });
  return { store, rr, order, started, proposals, undone, tokens };
}

test('describe: one line from the steps', () => {
  const { rr, store } = setup();
  assert.equal(rr.describe(store.get('game mode')), 'Game Mode: close Discord and Chrome, focus assist on, volume 40, sound output headphones, play Lo-fi.');
});

test('run: a routine without a close step runs at once and never asks', async () => {
  const { rr, started, proposals } = setup();
  const r = await rr.run('quiet', { turn: { tainted: false } });
  assert.equal(r.ok, true);
  assert.equal(started.length, 1);
  assert.equal(proposals.length, 0);
});

test('run: a routine with a close step asks once and starts only after the yes', async () => {
  const { rr, started, proposals } = setup();
  const r = await rr.run('game mode', { turn: { tainted: false } });
  assert.ok(r.text.startsWith(NEEDS_OK));
  assert.match(r.text, /close Discord and Chrome/);
  assert.equal(started.length, 0);
  const out = await proposals[0].run();
  assert.match(String(out), /Done: 6\/6/);
  assert.equal(started.length, 1);
});

test('run: snapshot before the runner, token valid during the run and revoked after', async () => {
  const { rr, proposals, order, started, tokens } = setup();
  await rr.run('game mode', { turn: { tainted: false } });
  await proposals[0].run();
  assert.deepEqual(order, ['snapshot', 'start']);
  assert.deepEqual(started[0].tokenValid, [true, true]);
  const token = started[0].steps.find(s => s.tool === 'routine_close').args.token;
  assert.equal(tokens.valid(token), false);
});

test('run: a tainted turn cannot run a routine that closes apps, but a quiet one is fine', async () => {
  const { rr, proposals } = setup();
  const r = await rr.run('game mode', { turn: { tainted: true } });
  assert.equal(r.ok, false);
  assert.equal(proposals.length, 0);
  assert.equal((await rr.run('quiet', { turn: { tainted: true } })).ok, true);
});

test('run: unknown routine', async () => {
  const { rr } = setup();
  const r = await rr.run('nope', {});
  assert.equal(r.ok, false);
  assert.match(r.text, /no routine called "nope"/i);
});

test('undo: nothing to undo before any run', async () => {
  const { rr } = setup();
  const r = await rr.undo();
  assert.equal(r.ok, false);
  assert.match(r.text, /nothing to undo/i);
});

test('undo: restores the newest run once; a second undo says already undone', async () => {
  const { rr, undone } = setup();
  await rr.run('quiet', { turn: { tainted: false } });
  const a = await rr.undo();
  assert.equal(a.ok, true);
  assert.match(a.text, /Restored volume/);
  assert.equal(undone.length, 1);
  const b = await rr.undo('quiet');
  assert.equal(b.ok, false);
  assert.match(b.text, /already undone/i);
  assert.equal(undone.length, 1);
});

test('undo: by name picks that routine, run twice then undo uses the latest snapshot', async () => {
  const { rr, undone } = setup();
  await rr.run('quiet', { turn: { tainted: false } });
  await rr.run('quiet', { turn: { tainted: false } });
  await rr.undo('quiet');
  assert.equal(undone.length, 1);
});
