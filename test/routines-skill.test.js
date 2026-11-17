'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NEEDS_OK } = require('../src/core/brain/guard');
const { createRoutineStore } = require('../src/core/routines/store');
const { createRoutinesSkill } = require('../src/core/routines/skill');

function setup() {
  const store = createRoutineStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-rs-')), 'r.json') });
  store.save({ name: 'Game Mode', steps: [{ tool: 'focus_assist', args: { on: true } }] });
  store.save({ name: 'Focus', steps: [{ tool: 'night_light', args: { on: true } }] });
  const calls = [];
  const routines = {
    async run(name, o) { calls.push(['run', name, o?.turn?.source]); return { ok: true, text: `${NEEDS_OK}Game Mode: focus assist on. Say yes to confirm.` }; },
    async undo(name) { calls.push(['undo', name]); return { ok: true, text: 'Restored volume to 20%.' }; },
  };
  return { skill: createRoutinesSkill({ store, routines }), calls };
}

test('routines skill: a routine name, with or without a run word, runs it', async () => {
  for (const p of ['game mode', 'Game mode!', 'run game mode', 'start game mode', 'Jarvis, activate game mode', 'please launch the game mode']) {
    const { skill, calls } = setup();
    const r = await skill.handle(p, { source: 'voice' });
    assert.ok(r, p);
    assert.deepEqual(calls[0], ['run', 'Game Mode', 'voice'], p);
  }
});

test('routines skill: a question in the result keeps its words but not the marker', async () => {
  const { skill } = setup();
  const r = await skill.handle('game mode', {});
  assert.equal(r.reply, 'Game Mode: focus assist on. Say yes to confirm.');
  assert.equal(r.tool, 'routine');
  assert.equal(r.ok, true);
});

test('routines skill: partial names and unrelated phrases are left alone', async () => {
  const { skill, calls } = setup();
  for (const p of ['game', 'mode', 'play music', 'what is game mode', 'focus on my work', 'run the game mode report']) assert.equal(await skill.handle(p, {}), null, p);
  assert.equal(calls.length, 0);
});

test('routines skill: undo by name or "that routine", but a bare "undo that" is left to others', async () => {
  const a = setup();
  assert.match((await a.skill.handle('undo game mode', {})).reply, /Restored volume/);
  assert.deepEqual(a.calls[0], ['undo', 'Game Mode']);
  const b = setup();
  await b.skill.handle('undo that routine', {});
  await b.skill.handle('undo the routine', {});
  assert.deepEqual(b.calls, [['undo', undefined], ['undo', undefined]]);
  const c = setup();
  assert.equal(await c.skill.handle('undo that', {}), null);
  assert.equal(await c.skill.handle('undo', {}), null);
});

test('routines skill: listing', async () => {
  const { skill } = setup();
  const r = await skill.handle('what routines do I have', {});
  assert.match(r.reply, /Game Mode/);
  assert.match(r.reply, /Focus/);
  const empty = createRoutinesSkill({ store: { list: () => [], get: () => null }, routines: {} });
  assert.match((await empty.handle('list my routines', {})).reply, /no routines/i);
});

test('routines skill: a throwing runner gives a short ok:false reply', async () => {
  const store = createRoutineStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-rs-')), 'r.json') });
  store.save({ name: 'Game Mode', steps: [{ tool: 'focus_assist', args: { on: true } }] });
  const s = createRoutinesSkill({ store, routines: { run: async () => { throw new Error('boom'); } } });
  const r = await s.handle('game mode', {});
  assert.equal(r.ok, false);
  assert.match(r.reply, /could not/i);
});
