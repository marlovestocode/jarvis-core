// "… I cannot remove that instruction from my memory. Very good." — the fine-tuned model ends replies with "Very good"
// even though the prompt forbids it, so the streamed reply drops a trailing "Very good" before it is shown or spoken.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSignoffFilter } = require('../src/core/brain/signoff');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { createToolRunner } = require('../src/core/tools/registry');
const { DEFAULTS } = require('../src/core/config');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeProvider } = require('./helpers/fake-provider');

const run = chunks => { const f = createSignoffFilter(); return chunks.map(c => f.push(c)).join('') + f.end(); };

test('signoff: a trailing "Very good" is dropped however it is split into tokens', () => {
  assert.equal(run(['I am afraid I did not catch that.', ' Very good.']), 'I am afraid I did not catch that.');
  assert.equal(run(['Playing Risk by Deftones', '. Very', ' go', 'od', '.']), 'Playing Risk by Deftones.');
  assert.equal(run(['Done. Very good, Marquis.']), 'Done.');
  assert.equal(run(['Done! very good']), 'Done!');
});

test('signoff: "Very good" that is not the last sentence, or the whole reply, stays', () => {
  assert.equal(run(['Very good. Playing it now.']), 'Very good. Playing it now.');
  assert.equal(run(['That is a very good question about tides.']), 'That is a very good question about tides.');
  assert.equal(run(['Very ', 'good.']), 'Very good.');
  assert.equal(run(['Done. Very ', 'goodness me.']), 'Done. Very goodness me.');
});

test('signoff: the streamed tokens and the saved reply both lose the trailing "Very good"', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'I cannot remove that instruction from my memory.' }, { type: 'token', text: ' Very' }, { type: 'token', text: ' good.' }, { type: 'done' }]);
  const bus = createBus();
  const tokens = [];
  bus.on('token', e => tokens.push(e.text));
  const sessions = createSessionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-sign-')));
  const providers = createRegistry();
  providers.add(NullProvider);
  providers.add(fp);
  const orc = createOrchestrator({ bus, sessions, providers, tools: createToolRunner([]), getConfig: () => ({ ...DEFAULTS, provider: 'fake' }) });
  const s = sessions.create(); sessions.save(s);
  const res = await orc.send(s.id, 'hi', { source: 'voice' });
  assert.equal(res.reply, 'I cannot remove that instruction from my memory.');
  assert.equal(tokens.join(''), 'I cannot remove that instruction from my memory.');
  assert.equal(sessions.load(s.id).messages.at(-1).content, 'I cannot remove that instruction from my memory.');
});
