'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRoutineStore, normName, STEP_TOOLS } = require('../src/core/routines/store');

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-rt-')), 'routines.json');
const game = { name: 'Game Mode', steps: [{ tool: 'focus_assist', args: { on: true } }, { tool: 'set_system_volume', args: { percent: 40 } }] };

test('routines store: normName strips case, punctuation and a leading "the"', () => {
  assert.equal(normName('The  Game Mode!'), 'game mode');
});

test('routines store: save then get by any spelling of the name', () => {
  const s = createRoutineStore({ file: file() });
  assert.deepEqual(s.save(game), { ok: true });
  assert.equal(s.get('game mode!').name, 'Game Mode');
  assert.equal(s.list().length, 1);
  assert.equal(s.remove('GAME MODE'), true);
  assert.equal(s.get('game mode'), null);
});

test('routines store: forbidden tools, too many steps, empty or reserved names are refused', () => {
  const s = createRoutineStore({ file: file() });
  for (const tool of ['power', 'task_run', 'delete_to_recycle_bin', 'lock_screen', 'wifi_set', 'close_app']) {
    const r = s.save({ name: 'x', steps: [{ tool, args: {} }] });
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(tool));
  }
  assert.equal(s.save({ name: 'x', steps: Array.from({ length: 13 }, () => ({ tool: 'night_light', args: { on: true } })) }).ok, false);
  assert.equal(s.save({ name: '  ', steps: game.steps }).ok, false);
  assert.equal(s.save({ name: 'x', steps: [] }).ok, false);
  for (const n of ['undo', 'list', 'stop', 'play', 'pause', 'resume', 'yes', 'no']) assert.equal(s.save({ name: n, steps: game.steps }).ok, false, n);
});

test('routines store: STEP_TOOLS is the allowlist from the design', () => {
  assert.deepEqual([...STEP_TOOLS].sort(), ['audio_output_set', 'bluetooth_set', 'brightness_set', 'focus_assist', 'night_light', 'open_app', 'power_plan_set', 'routine_close', 'set_system_volume', 'youtube_music']);
});

test('routines store: a corrupt file is set aside and the store starts empty', () => {
  const f = file();
  fs.writeFileSync(f, '{nope');
  const s = createRoutineStore({ file: f });
  assert.deepEqual(s.list(), []);
  assert.ok(fs.existsSync(f + '.broken'));
});

test('routines store: lastRun survives a reload; saving the same name keeps it', () => {
  const f = file();
  const a = createRoutineStore({ file: f });
  a.save(game);
  a.setLastRun('game mode', { at: 5, snapshot: { volume: 20 } });
  assert.deepEqual(createRoutineStore({ file: f }).get('game mode').lastRun, { at: 5, snapshot: { volume: 20 } });
  a.save({ ...game, steps: [game.steps[0]] });
  assert.equal(a.get('game mode').lastRun.at, 5);
});
