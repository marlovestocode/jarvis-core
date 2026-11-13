const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PORTS } = require('../src/core/media/ytmusic-link');

const ext = f => fs.readFileSync(path.join(__dirname, '../extension', f), 'utf8');

test('extension and backend agree on the link ports', () => {
  const m = /const PORTS = \[([\d, ]+)\]/.exec(ext('background.js'));
  assert.ok(m, 'PORTS not found in background.js');
  assert.deepEqual(m[1].split(',').map(Number), PORTS);
});

test('extension: the keep-playing scripts are loaded in the music tab only, in order, and stay inside the page', () => {
  const m = JSON.parse(ext('manifest.json'));
  const cs = m.content_scripts.find(c => c.js.includes('keepalive.js'));
  assert.deepEqual(cs.js, ['prompts.js', 'keepalive.js']);
  assert.deepEqual(cs.matches, ['https://music.youtube.com/*']);
  assert.notEqual(cs.world, 'MAIN', 'runs in the isolated world');
  assert.ok(!m.permissions.includes('tabs'), 'tabs is optional');
  const k = ext('keepalive.js');
  assert.match(k, /new MutationObserver/);
  assert.match(k, /setInterval\(schedule, FALLBACK_MS\)/);
  assert.match(k, /autoConfirm/);
  assert.match(k, /pagehide/);
});

test('extension: the popup has the off switch and the activity list; the worker records every command', () => {
  assert.match(ext('popup.html'), /id="autoconfirm"/);
  assert.match(ext('popup.html'), /id="log"/);
  assert.match(ext('popup.js'), /autoConfirm/);
  const bg = ext('background.js');
  assert.match(bg, /record\('command'/);
  assert.match(bg, /record\('prompt'/);
});
