const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { createToolRunner } = require('../src/core/tools/registry');
const { DEFAULTS } = require('../src/core/config');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeProvider } = require('./helpers/fake-provider');

function setup(provider, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-orc-'));
  const bus = createBus();
  const events = [];
  bus.on('*', ev => events.push(ev));
  const sessions = createSessionStore(dir);
  const providers = createRegistry();
  providers.add(NullProvider);
  providers.add(provider);
  const ran = [];
  const tools = opts.tools || createToolRunner([{
    name: 'get_time', description: 't', params: {}, async run(a) { ran.push(a); return 'NOON'; },
  }]);
  const orc = createOrchestrator({
    bus, sessions, providers, tools,
    getConfig: () => ({ ...DEFAULTS, provider: provider.id }),
    ...opts.orc,
  });
  const s = sessions.create(); sessions.save(s);
  return { bus, events, sessions, orc, s, ran };
}
const of = (events, type) => events.filter(e => e.type === type);
const states = events => of(events, 'state').map(e => e.state);

test('text turn: user + assistant saved, tokens emitted in order, ends state idle', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'Hel' }, { type: 'token', text: 'lo' }, { type: 'done' }]);
  const { events, sessions, orc, s } = setup(fp);
  const res = await orc.send(s.id, 'hi', { source: 'text' });
  assert.equal(res.reply, 'Hello');
  assert.equal(res.stopped, false);
  assert.equal(res.error, undefined);
  assert.deepEqual(sessions.load(s.id).messages.map(m => [m.role, m.content]), [['user', 'hi'], ['assistant', 'Hello']]);
  assert.deepEqual(of(events, 'token').map(e => e.text), ['Hel', 'lo']);
  assert.deepEqual(states(events), ['thinking', 'idle']);
  assert.equal(of(events, 'provider')[0].id, 'fake');
  assert.equal(of(events, 'context').length, 1);
  assert.equal(orc.busy, false);
});

test('voice turn returns before speaking and leaves state to the caller', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'ok' }, { type: 'done' }]);
  const { events, orc, s } = setup(fp);
  await orc.send(s.id, 'hi', { source: 'voice' });
  assert.deepEqual(states(events), ['thinking']);
});

test('tool turn: tool_call → tool start/end events, tool message saved, provider called again, final reply', async () => {
  const fp = createFakeProvider([
    [{ type: 'tool_call', id: 'c1', name: 'get_time', args: { a: 1 } }, { type: 'done' }],
    [{ type: 'token', text: 'It is noon' }, { type: 'done' }],
  ]);
  const { events, sessions, orc, s, ran } = setup(fp);
  const res = await orc.send(s.id, 'time?', { source: 'text' });
  assert.equal(res.reply, 'It is noon');
  assert.deepEqual(ran, [{ a: 1 }]);
  assert.deepEqual(of(events, 'tool').map(e => [e.id, e.name, e.phase, e.ok]), [['c1', 'get_time', 'start', undefined], ['c1', 'get_time', 'end', true]]);
  assert.equal(fp.calls.length, 2);
  const msgs = sessions.load(s.id).messages;
  const tm = msgs.find(m => m.role === 'tool');
  assert.deepEqual([tm.content, tm.toolCallId, tm.name], ['NOON', 'c1', 'get_time']);
  assert.ok(fp.calls[1].messages.some(m => m.role === 'tool' && m.content === 'NOON'));
  assert.equal(msgs.at(-1).content, 'It is noon');
  assert.ok(Array.isArray(fp.calls[0].tools) && fp.calls[0].tools[0].name === 'get_time');
});

test('tool loop capped at 5 rounds → error Too many tool rounds', async () => {
  const fp = createFakeProvider([{ type: 'tool_call', id: 'c', name: 'get_time', args: {} }, { type: 'done' }]);
  const { events, orc, s, ran, sessions } = setup(fp);
  const res = await orc.send(s.id, 'loop', { source: 'text' });
  assert.equal(res.error, 'Too many tool rounds');
  assert.equal(ran.length, 5);
  assert.equal(fp.calls.length, 6);
  assert.deepEqual(states(events).slice(-2), ['error', 'idle']);
  assert.equal(sessions.load(s.id).messages.at(-1).error, 'Too many tool rounds');
});

test('stop() mid-stream: partial reply saved with stopped:true, result.stopped true', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'part' }, { type: 'hang' }]);
  const { events, sessions, orc, s } = setup(fp);
  const p = orc.send(s.id, 'go', { source: 'text' });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(orc.busy, true);
  orc.stop();
  const res = await p;
  assert.equal(res.stopped, true);
  assert.equal(res.reply, 'part');
  const last = sessions.load(s.id).messages.at(-1);
  assert.deepEqual([last.role, last.content, last.stopped], ['assistant', 'part', true]);
  assert.equal(states(events).at(-1), 'idle');
});

test('stop() is honored even when the provider ignores the signal', async () => {
  const deaf = { id: 'deaf', label: 'Deaf', capabilities: { tools: false }, async status() { return { ready: true, detail: '' }; },
    async *chat() { yield { type: 'token', text: 'x' }; await new Promise(() => {}); } };
  const { orc, s } = setup(deaf);
  const p = orc.send(s.id, 'go', { source: 'text' });
  await new Promise(r => setTimeout(r, 20));
  orc.stop();
  const res = await p;
  assert.equal(res.stopped, true);
});

test('silence timeout: partial kept, error Model timed out, state error then idle', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'half' }, { type: 'hang' }]);
  const { events, sessions, orc, s } = setup(fp, { orc: { timeoutMs: 50 } });
  const res = await orc.send(s.id, 'go', { source: 'text' });
  assert.equal(res.error, 'Model timed out');
  assert.equal(res.reply, 'half');
  const last = sessions.load(s.id).messages.at(-1);
  assert.deepEqual([last.content, last.error], ['half', 'Model timed out']);
  assert.deepEqual(states(events).slice(-2), ['error', 'idle']);
});

test('silence timer resets on every chunk', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'a' }, { type: 'token', text: 'b' }, { type: 'token', text: 'c' }, { type: 'done' }], { delayMs: 30 });
  const { orc, s } = setup(fp, { orc: { timeoutMs: 50 } });
  const res = await orc.send(s.id, 'go', { source: 'text' });
  assert.equal(res.error, undefined);
  assert.equal(res.reply, 'abc');
});

test('provider throws: error saved on message, state error', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'x' }, { type: 'throw', message: 'GPU on fire' }]);
  const { events, sessions, orc, s } = setup(fp);
  const res = await orc.send(s.id, 'go', { source: 'text' });
  assert.equal(res.error, 'GPU on fire');
  assert.equal(sessions.load(s.id).messages.at(-1).error, 'GPU on fire');
  assert.ok(states(events).includes('error'));
  assert.equal(of(events, 'state').find(e => e.state === 'error').detail, 'GPU on fire');
});

test('send while busy rejects with Error(BUSY)', async () => {
  const fp = createFakeProvider([{ type: 'hang' }]);
  const { sessions, orc, s } = setup(fp);
  const p = orc.send(s.id, 'one', { source: 'text' });
  await new Promise(r => setTimeout(r, 10));
  await assert.rejects(orc.send(s.id, 'two', { source: 'text' }), { message: 'BUSY' });
  orc.stop();
  await p;
  assert.deepEqual(sessions.load(s.id).messages.filter(m => m.role === 'user').map(m => m.content), ['one']);
});

test('contextMax 100: only newest messages fitting 400 chars are sent; session keeps all', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'k' }, { type: 'done' }], { contextMax: 100 });
  const { sessions, orc, s } = setup(fp);
  const full = sessions.load(s.id);
  for (let i = 0; i < 10; i++) full.messages.push({ role: i % 2 ? 'assistant' : 'user', content: String(i).repeat(100) });
  sessions.save(full);
  await orc.send(s.id, 'Q'.repeat(150), { source: 'text' });
  const sent = fp.calls[0].messages;
  const chars = sent.reduce((n, m) => n + m.content.length, 0);
  assert.ok(chars <= 400, 'sent ' + chars + ' chars');
  assert.equal(sent.at(-1).content, 'Q'.repeat(150));
  assert.deepEqual(sent.map(m => m.content[0]), ['8', '9', 'Q']);
  assert.equal(sessions.load(s.id).messages.length, 12);
});

test('huge message alone is still sent even if it exceeds contextMax', async () => {
  const fp = createFakeProvider([{ type: 'done' }], { contextMax: 10 });
  const { orc, s } = setup(fp);
  await orc.send(s.id, 'Z'.repeat(1000), { source: 'text' });
  assert.equal(fp.calls[0].messages.length, 1);
});

test('tools not passed to provider when capabilities.tools is false', async () => {
  const fp = createFakeProvider([{ type: 'done' }], { tools: false });
  const { orc, s } = setup(fp);
  await orc.send(s.id, 'x', { source: 'text' });
  assert.equal(fp.calls[0].tools, undefined);
});

test('alts/prob forwarded on token events', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'a', prob: 0.3, alts: [{ text: 'b', prob: 0.2 }] }, { type: 'reasoning', text: 'hmmm' }, { type: 'done' }]);
  const { events, orc, s } = setup(fp);
  await orc.send(s.id, 'x', { source: 'text' });
  const tok = of(events, 'token')[0];
  assert.equal(tok.prob, 0.3);
  assert.deepEqual(tok.alts, [{ text: 'b', prob: 0.2 }]);
  assert.deepEqual(of(events, 'reasoning').map(e => e.chars), [4]);
  assert.equal(of(events, 'reasoning')[0].text, undefined);
});

test('unknown session id creates a new chat', async () => {
  const { orc, sessions } = setup(createFakeProvider([{ type: 'done' }], { id: 'other' }));
  const res = await orc.send(null, 'hello', { source: 'text' });
  assert.ok(res.sessionId);
  assert.equal(sessions.load(res.sessionId).messages[0].content, 'hello');
});

// ---- brain hooks: system prompt, routing, turn stats ----
function setupBrain(provider, extra = {}) {
  return setup(provider, { orc: {
    systemPrompt: ctx => `SYS source=${ctx.source} tools=${ctx.tools.join(',')} model=${ctx.model}`,
    route: (text, ctx) => ({ tier: /hard/.test(text) ? 'deep' : 'fast', think: /hard/.test(text), reason: 'test', source: ctx.source }),
    ...extra,
  } });
}

test('system prompt is sent first on every round and never saved', async () => {
  const fp = createFakeProvider([
    [{ type: 'tool_call', id: 'c1', name: 'get_time', args: {} }, { type: 'done' }],
    [{ type: 'token', text: 'ok' }, { type: 'done' }],
  ]);
  fp.resolveModel = hints => (hints.tier === 'fast' ? 'small' : 'big');
  const { orc, s, sessions } = setupBrain(fp);
  await orc.send(s.id, 'hard question', { source: 'voice' });
  for (const call of fp.calls) {
    assert.equal(call.messages[0].role, 'system');
    assert.equal(call.messages[0].content, 'SYS source=voice tools=get_time model=big');
  }
  assert.ok(sessions.load(s.id).messages.every(m => m.role !== 'system'));
});

test('route hints reach the provider and a route event is emitted', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'hey' }, { type: 'done' }]);
  fp.resolveModel = hints => (hints.tier === 'fast' ? 'small' : 'big');
  const { orc, s, events } = setupBrain(fp);
  await orc.send(s.id, 'hi', { source: 'text' });
  assert.deepEqual(fp.calls[0].hints, { tier: 'fast', think: false, reason: 'test', source: 'text' });
  const r = of(events, 'route')[0];
  assert.deepEqual([r.tier, r.think, r.model], ['fast', false, 'small']);
});

test('turn event carries model, tokens and speed', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'a' }, { type: 'token', text: 'b' }, { type: 'done', usage: { promptTokens: 40, completionTokens: 20, evalMs: 400 } }]);
  fp.resolveModel = () => 'big';
  const { orc, s, events } = setupBrain(fp);
  await orc.send(s.id, 'hard one', { source: 'text' });
  const t = of(events, 'turn')[0];
  assert.equal(t.model, 'big');
  assert.equal(t.completionTokens, 20);
  assert.equal(t.promptTokens, 40);
  assert.equal(t.tps, 50);
  assert.equal(t.think, true);
  assert.ok(t.ms >= 0);
});

test('system prompt counts toward the context window', async () => {
  const fp = createFakeProvider([{ type: 'done' }], { contextMax: 100 });
  const { orc, s, sessions } = setup(fp, { orc: { systemPrompt: () => 'S'.repeat(200) } });
  const full = sessions.load(s.id);
  for (let i = 0; i < 4; i++) full.messages.push({ role: i % 2 ? 'assistant' : 'user', content: String(i).repeat(100) });
  sessions.save(full);
  await orc.send(s.id, 'Q'.repeat(50), { source: 'text' });
  const sent = fp.calls[0].messages;
  assert.equal(sent[0].role, 'system');
  const chars = sent.reduce((n, m) => n + m.content.length, 0);
  assert.ok(chars <= 400, `sent ${chars} chars`);
  assert.equal(sent.at(-1).content, 'Q'.repeat(50));
});
