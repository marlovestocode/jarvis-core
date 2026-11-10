const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// mic.js requires electron; stub it so the pure level math can be tested in node
const realLoad = Module._load;
Module._load = (req, ...a) => (req === 'electron' ? { BrowserWindow: class {}, ipcMain: { on() {} } } : realLoad(req, ...a));
const { levelAt } = require('../src/main/mic');
Module._load = realLoad;

test('levelAt: loud audio reads high, silence zero, past the end zero', () => {
  const pcm = new Int16Array(22050);
  for (let i = 0; i < 11025; i++) pcm[i] = Math.sin(i / 5) * 16000;
  assert.ok(levelAt(pcm, 22050, 0.1) > 0.8);
  assert.equal(levelAt(pcm, 22050, 0.8), 0);
  assert.equal(levelAt(pcm, 22050, 5), 0);
});
