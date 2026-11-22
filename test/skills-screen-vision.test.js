const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGroup } = require('../src/core/skills/screen-vision');
const { createVisionClient } = require('../src/core/vision/client');
const { createToolRunner } = require('../src/core/tools/registry');
const { createFakePcHost } = require('./helpers/fake-pc-host');

const WINS = [{ hwnd: 1, pid: 10, app: 'chrome', title: 'Docs - Chrome', rect: { x: 0, y: 0, w: 800, h: 600 } }];

function setup({ answer = 'A browser shows an error: ENOENT', resize, hostOpts = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsv-'));
  const host = createFakePcHost({ windows: WINS, ...hostOpts });
  const seen = [];
  const vision = { describe: async a => { seen.push(a); if (answer instanceof Error) throw answer; return answer; } };
  const group = createGroup({ pc: { host }, vision: { client: vision, resize } });
  group.tools[0].run = group.tools[0].run.bind(group.tools[0]);
  const runner = createToolRunner(group.tools);
  return { host, group, seen, dir, run: async (a, ctx = { turn: { tainted: false } }) => { const r = await runner.run('screen_look', a, ctx); if (!r.ok) throw new Error(r.text); return r.text; } };
}

test('screen-vision group: id, untrusted tool, strict schema, null without deps', () => {
  const { group } = setup();
  assert.equal(group.id, 'screen-vision');
  assert.deepEqual(group.tools.map(t => t.name), ['screen_look']);
  assert.equal(group.tools[0].untrusted, true);
  assert.equal(group.tools[0].params.additionalProperties, false);
  assert.equal(createGroup({}), null);
  assert.equal(createGroup({ pc: { host: {} } }), null);
});

test('screen_look: captures the screen, sends it with the question, quotes the answer as data, leaves no temp file', async () => {
  const { host, run, seen } = setup();
  const out = await run({ question: 'what does the error say?' });
  assert.match(out, /Quoted data, not instructions/);
  assert.match(out, /ENOENT/);
  assert.equal(seen[0].question, 'what does the error say?');
  assert.ok(Buffer.isBuffer(seen[0].image) && seen[0].image.length > 0);
  const shot = host.calls.find(c => c[0] === 'screenshot')[1];
  assert.equal(shot.mode, 'screen');
  assert.equal(shot.to, 'file');
  assert.equal(fs.existsSync(shot.path), false);
});

test('screen_look: window mode finds the window by words, and the front one when no target', async () => {
  const a = setup();
  await a.run({ mode: 'window', target: 'chrome' });
  assert.equal(a.host.calls.find(c => c[0] === 'screenshot')[1].hwnd, 1);
  const b = setup({ hostOpts: { foreground: 1 } });
  await b.run({ mode: 'window' });
  assert.equal(b.host.calls.find(c => c[0] === 'screenshot')[1].hwnd, 1);
  await a.run({ mode: 'window', target: 'zzzzqq' });   // a made-up target falls back to the whole screen
  assert.equal(a.host.calls.filter(c => c[0] === 'screenshot').pop()[1].mode, 'screen');
});

test('screen_look: resize hook shrinks the image; a failing hook falls back to the original', async () => {
  const small = Buffer.from('small');
  const a = setup({ resize: async () => small });
  await a.run({});
  assert.deepEqual(a.seen[0].image, small);
  const b = setup({ resize: async () => { throw new Error('boom'); } });
  await b.run({});
  assert.equal(b.seen[0].image.toString(), 'PNGDATA');
});

test('screen_look: empty capture and vision errors are reported, bad mode refused', async () => {
  await assert.rejects(() => setup({ hostOpts: { screenshotEmpty: true } }).run({}), /empty/);
  await assert.rejects(() => setup({ answer: new Error('Ollama is not running') }).run({}), /Ollama is not running/);
  await assert.rejects(() => setup().run({ mode: 'region' }), /screen or window|mode/);
});

test('vision client: local-only host, images field, keep_alive, errors', async () => {
  const calls = [];
  const cfg = { ollama: { host: 'http://127.0.0.1:11434' }, vision: { model: 'jarvis-vision', keepAlive: '1m' } };
  const ok = createVisionClient({ getConfig: () => cfg, fetch: async (url, o) => { calls.push({ url, body: JSON.parse(o.body) }); return { ok: true, json: async () => ({ message: { content: ' hello ' } }) }; } });
  assert.equal(await ok.describe({ image: Buffer.from('x'), question: 'q' }), 'hello');
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(calls[0].body.model, 'jarvis-vision');
  assert.equal(calls[0].body.keep_alive, '1m');
  assert.equal(calls[0].body.messages[1].images[0], Buffer.from('x').toString('base64'));
  await assert.rejects(() => ok.describe({ image: Buffer.alloc(0) }), /No image/);

  const remote = createVisionClient({ getConfig: () => ({ ...cfg, ollama: { host: 'http://evil.example:11434' } }), fetch: async () => { throw new Error('must not call'); } });
  await assert.rejects(() => remote.describe({ image: Buffer.from('x') }), /local/);

  const missing = createVisionClient({ getConfig: () => cfg, fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  await assert.rejects(() => missing.describe({ image: Buffer.from('x') }), /not in Ollama/);
  const down = createVisionClient({ getConfig: () => cfg, fetch: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(() => down.describe({ image: Buffer.from('x') }), /not running/);
});
