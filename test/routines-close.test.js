'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPcTools } = require('../src/core/tools/pc');
const { createConfirm } = require('../src/core/pc/confirm');
const { createActionLog } = require('../src/core/pc/actions-log');
const { buildAllowlist } = require('../src/core/pc/apps');
const { createFakePcHost } = require('./helpers/fake-pc-host');
const { createRoutineClose, createTokens } = require('../src/core/routines/close-tool');

const START = [{ name: 'Spotify', appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' }, { name: 'Notepad', appId: '{1AC14E77}\notepad.exe' }];

function setup({ windows, stubborn = [] } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jrc-'));
  const roots = ['Desktop', 'Documents', 'Downloads', 'Projects'].map(d => path.join(base, d));
  roots.forEach(r => fs.mkdirSync(r));
  const host = createFakePcHost({ windows, stubborn });
  const actionLog = createActionLog({ file: path.join(base, 'actions.log') });
  const confirm = createConfirm({ actionLog });
  const pcTools = createPcTools({ host, getAllowlist: async () => buildAllowlist(START, {}), roots, confirm, actionLog, waitMs: 50, pollMs: 5 });
  let t = 0;
  const tokens = createTokens({ now: () => t });
  const tool = createRoutineClose({ ...pcTools.helpers, host, tokens });
  return { host, tool, tokens, advance: ms => { t += ms; } };
}
const W = [{ hwnd: 1, pid: 10, app: 'Spotify', title: 'Song' }, { hwnd: 2, pid: 11, app: 'explorer', title: 'Files' }, { hwnd: 3, pid: 12, app: 'Notepad', title: 'x' }];

test('routine_close: is a safe, token-gated tool', () => {
  const { tool } = setup({ windows: W });
  assert.equal(tool.name, 'routine_close');
  assert.equal(tool.risk, 'safe');
});

test('routine_close: a bad token throws and closes nothing', async () => {
  const { tool, host } = setup({ windows: W });
  await assert.rejects(() => tool.run({ name: 'Spotify', token: 'nope' }), /not allowed/i);
  assert.ok(!host.calls.some(c => c[0] === 'closeMain'));
});

test('routine_close: a good token closes politely, never with kill', async () => {
  const { tool, host, tokens } = setup({ windows: W });
  const token = tokens.issue();
  assert.match(await tool.run({ name: 'Spotify', token }), /Closed Spotify/);
  assert.ok(host.calls.some(c => c[0] === 'closeMain' && c[1] === 10));
  assert.ok(!host.calls.some(c => c[0] === 'kill'));
});

test('routine_close: protected apps are refused even with a token', async () => {
  const { tool, host, tokens } = setup({ windows: W });
  await assert.rejects(() => tool.run({ name: 'explorer', token: tokens.issue() }), /won't close/i);
  assert.ok(!host.calls.some(c => c[0] === 'closeMain'));
});

test('routine_close: an app that is not open is a success', async () => {
  const { tool, tokens } = setup({ windows: [W[1]] });
  assert.match(await tool.run({ name: 'Spotify', token: tokens.issue() }), /was not open/);
});

test('routine_close: an app that stays open is left alone and reported, without stopping the routine', async () => {
  const { tool, host, tokens } = setup({ windows: W, stubborn: [10] });
  assert.match(await tool.run({ name: 'Spotify', token: tokens.issue() }), /still open.*I left it/i);
  assert.ok(!host.calls.some(c => c[0] === 'kill'));
});

test('tokens: revoked and expired tokens are refused', async () => {
  const { tool, tokens, advance } = setup({ windows: W });
  const a = tokens.issue();
  tokens.revoke(a);
  await assert.rejects(() => tool.run({ name: 'Spotify', token: a }), /not allowed/i);
  const b = tokens.issue();
  advance(31 * 60 * 1000);
  assert.equal(tokens.valid(b), false);
});
