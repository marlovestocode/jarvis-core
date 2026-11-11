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

test('network citations belong to their turn, persist, and are never sent to the model', async () => {
  let ctx;
  const tools = createToolRunner([{ name: 'get_weather', params: {}, run: async () => { ctx.bus.emit('net', { source: 'weather', host: 'api.open-meteo.com', ok: true, cached: true, ageMs: 120000 }); return 'weather'; } }]);
  const fp = createFakeProvider([
    [{ type: 'tool_call', id: 'w', name: 'get_weather' }, { type: 'done' }],
    [{ type: 'token', text: 'Fine weather' }, { type: 'done' }],
    [{ type: 'token', text: 'Hi' }, { type: 'done' }],
  ]);
  ctx = setup(fp, { tools });
  await ctx.orc.send(ctx.s.id, 'weather');
  const reply = ctx.sessions.load(ctx.s.id).messages.at(-1);
  assert.equal(reply.lookups[0].host, 'api.open-meteo.com');
  await ctx.orc.send(ctx.s.id, 'hi');
  assert.equal(ctx.sessions.load(ctx.s.id).messages.at(-1).lookups, undefined);
  assert.ok(fp.calls.at(-1).messages.every(m => !('lookups' in m)));
});

test('a repeated identical tool call is not run again and the model is told to answer', async () => {
  const fp = createFakeProvider([
    [{ type: 'tool_call', id: 'a', name: 'get_time', args: {} }, { type: 'done' }],
    [{ type: 'tool_call', id: 'b', name: 'get_time', args: {} }, { type: 'done' }],
    [{ type: 'token', text: 'It is noon.' }, { type: 'done' }],
  ]);
  const { orc, s, ran, sessions } = setup(fp);
  const res = await orc.send(s.id, 'time?', { source: 'text' });
  assert.equal(res.reply, 'It is noon.');
  assert.equal(ran.length, 1);
  const tool = sessions.load(s.id).messages.filter(m => m.role === 'tool');
  assert.match(tool[1].content, /already made this exact call/);
});

test('tool loop capped at 5 rounds → error Too many tool rounds', async () => {
  const fp = createFakeProvider(Array.from({ length: 7 }, (_, i) => [{ type: 'tool_call', id: `c${i}`, name: 'get_time', args: { n: i } }, { type: 'done' }]));
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

test('contextMax 130: only the newest messages that fit are sent (content plus per-message overhead); session keeps all', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'k' }, { type: 'done' }], { contextMax: 130 });
  const { sessions, orc, s } = setup(fp, { tools: createToolRunner([]) });   // no tool definitions: only messages count here
  const full = sessions.load(s.id);
  for (let i = 0; i < 10; i++) full.messages.push({ role: i % 2 ? 'assistant' : 'user', content: String(i).repeat(100) });
  sessions.save(full);
  await orc.send(s.id, 'Q'.repeat(150), { source: 'text' });
  const sent = fp.calls[0].messages;
  const chars = sent.reduce((n, m) => n + m.content.length, 0);
  assert.ok(chars <= 520, 'sent ' + chars + ' chars');
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

test('hints.tools === false: no tools sent and the prompt lists none', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'hi' }, { type: 'done' }]);
  const seen = [];
  const { orc, s } = setup(fp, { orc: { systemPrompt: ctx => { seen.push(ctx); return 'S'; }, route: () => ({ tier: 'fast', think: false, tools: false }) } });
  await orc.send(s.id, 'hello', { source: 'text' });
  assert.equal(fp.calls[0].tools, undefined);
  assert.deepEqual(seen[0].tools, []);
  assert.equal(seen[0].brief, true);
});

test('skill fast path: answers without the model, records history, silent voice reply stays silent', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'MODEL' }, { type: 'done' }]);
  const fastPath = async (text, { source }) => (/^pause$/.test(text) ? { reply: source === 'voice' ? '' : 'Paused.', record: 'Paused.', tool: 'media_control', ok: true } : null);
  const { events, sessions, orc, s } = setup(fp, { orc: { fastPath } });
  const v = await orc.send(s.id, 'pause', { source: 'voice' });
  assert.equal(v.reply, ''); assert.equal(v.skill, 'media_control');
  assert.equal(of(events, 'token').length, 0);
  assert.deepEqual(of(events, 'tool').map(e => [e.name, e.phase]), [['media_control', 'start'], ['media_control', 'end']]);
  assert.deepEqual(sessions.load(s.id).messages.map(m => [m.role, m.content, !!m.silent]), [['user', 'pause', false], ['assistant', 'Paused.', true]]);
  const t = await orc.send(s.id, 'pause', { source: 'text' });
  assert.equal(t.reply, 'Paused.');
  assert.deepEqual(of(events, 'token').map(e => e.text), ['Paused.']);
  const m = await orc.send(s.id, 'hello there', { source: 'text' });
  assert.equal(m.reply, 'MODEL');   // not a skill: the model answers
});

test('skill fast path that throws falls back to the model', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'MODEL' }, { type: 'done' }]);
  const { orc, s } = setup(fp, { orc: { fastPath: async () => { throw new Error('host down'); } } });
  assert.equal((await orc.send(s.id, 'pause', { source: 'text' })).reply, 'MODEL');
});

test('promptInfo may be async (media line reaches the system prompt)', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'ok' }, { type: 'done' }]);
  const { orc, s } = setup(fp, { orc: { systemPrompt: ({ media }) => `SYS ${media}`, promptInfo: async () => ({ media: 'Media: playing X.' }) } });
  await orc.send(s.id, 'hi', { source: 'text' });
  assert.equal(fp.calls[0].messages[0].content, 'SYS Media: playing X.');
});

test('contextMax: tool definitions and room for the answer are taken out of the history budget', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'k' }, { type: 'done' }], { contextMax: 1000 });   // 4000 chars
  const { sessions, orc, s } = setup(fp);
  const full = sessions.load(s.id);
  for (let i = 0; i < 10; i++) full.messages.push({ role: i % 2 ? 'assistant' : 'user', content: String(i).repeat(600) });
  sessions.save(full);
  await orc.send(s.id, 'Q'.repeat(100), { source: 'text' });
  const sent = fp.calls[0].messages;
  const specChars = JSON.stringify(fp.calls[0].tools).length;
  assert.ok(specChars > 0);
  const chars = sent.reduce((n, m) => n + m.content.length, 0);
  assert.ok(chars + specChars * 1.3 + 400 <= 4000, `history ${chars} + tools ${specChars} must leave room in 4000 chars`);
  assert.equal(sent.at(-1).content, 'Q'.repeat(100));
  assert.ok(sent.length < 11);
});

test('stamp: each user message carries its own send time to the provider, the same text every turn, and history stays clean', async () => {
  const fp = createFakeProvider([[{ type: 'tool_call', id: 'c1', name: 'get_time', args: {} }, { type: 'done' }], [{ type: 'token', text: 'ok' }, { type: 'done' }]]);
  const { sessions, orc, s } = setup(fp, { orc: { stamp: d => `Now: ${d.getTime()}.`, systemPrompt: () => 'SYS' } });
  await orc.send(s.id, 'first', { source: 'text' });
  await new Promise(r => setTimeout(r, 5));
  await orc.send(s.id, 'second', { source: 'text' });
  const users = c => c.messages.filter(m => m.role === 'user').map(m => m.content);
  const saved = sessions.load(s.id).messages.filter(m => m.role === 'user');
  assert.deepEqual(saved.map(m => m.content), ['first', 'second']);
  assert.ok(saved[0].at > 0 && saved[1].at > saved[0].at);
  assert.deepEqual(users(fp.calls[0]), [`first\n\nNow: ${saved[0].at}.`]);
  assert.deepEqual(users(fp.calls[1]), users(fp.calls[0]));                               // the tool round: same prompt
  assert.deepEqual(users(fp.calls[2]), [`first\n\nNow: ${saved[0].at}.`, `second\n\nNow: ${saved[1].at}.`]);   // the old message is byte-identical
  assert.equal(fp.calls[0].messages[0].content, 'SYS');
  // a message from before stamps existed (no `at`) is sent as it is
  const old = sessions.create(); old.messages.push({ role: 'user', content: 'old' }, { role: 'assistant', content: 'a' }); sessions.save(old);
  await orc.send(old.id, 'new', { source: 'text' });
  assert.equal(users(fp.calls.at(-1))[0], 'old');
});

// --- W1: the memory block in the turn ---
function fakeBlock({ memo = 'Relevant from memory: Rex is a dog', ids = [7, 8], fail = false } = {}) {
  const calls = { forTurn: [], afterTurn: [], onUserMessage: [] };
  return {
    calls,
    async forTurn(a) { calls.forTurn.push(a); if (fail) throw new Error('recall broke'); return { memo, ids }; },
    afterTurn(a) { calls.afterTurn.push(a); },
    onUserMessage(a) { calls.onUserMessage.push(a); return false; },
  };
}

test('memory: the memo is on the current user message and identical on the next turn render', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'ok' }, { type: 'done' }]);
  const block = fakeBlock();
  const { sessions, orc, s } = setup(fp, { orc: { memoryBlock: block, stamp: d => `Now: ${d.getTime()}.`, systemPrompt: () => 'SYS' } });
  await orc.send(s.id, 'how is Rex', { source: 'text' });
  const saved = sessions.load(s.id).messages.filter(m => m.role === 'user');
  assert.equal(saved[0].memo, 'Relevant from memory: Rex is a dog');
  assert.equal(saved[0].content, 'how is Rex', 'history text stays clean');
  const users = c => c.messages.filter(m => m.role === 'user').map(m => m.content);
  assert.deepEqual(users(fp.calls[0]), [`how is Rex\n\nRelevant from memory: Rex is a dog\n\nNow: ${saved[0].at}.`]);
  block.forTurn = async () => ({ memo: 'Relevant from memory: something else', ids: [9] });
  await orc.send(s.id, 'and his vet?', { source: 'text' });
  assert.equal(users(fp.calls[1])[0], users(fp.calls[0])[0], 'the older message is byte-identical');
  assert.match(users(fp.calls[1])[1], /something else/);
});

test('memory: system prompt identical across two turns with the same profile', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'ok' }, { type: 'done' }]);
  const { orc, s } = setup(fp, { orc: { memoryBlock: fakeBlock(), promptInfo: () => ({ memory: 'likes jazz', memoryIds: [1] }), systemPrompt: ({ memory }) => `SYS ${memory}` } });
  await orc.send(s.id, 'one', { source: 'text' });
  await orc.send(s.id, 'two', { source: 'text' });
  assert.equal(fp.calls[0].messages[0].content, 'SYS likes jazz');
  assert.equal(fp.calls[1].messages[0].content, fp.calls[0].messages[0].content);
});

test('memory: forTurn gets the previous user message, brief and the profile ids', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'ok' }, { type: 'done' }]);
  const block = fakeBlock();
  const { orc, s } = setup(fp, { orc: { memoryBlock: block, promptInfo: () => ({ memoryIds: [1, 2] }), systemPrompt: () => 'SYS', route: () => ({ tier: 'fast', tools: false }) } });
  await orc.send(s.id, 'tell me about the vet', { source: 'text' });
  await orc.send(s.id, 'when?', { source: 'text' });
  assert.deepEqual(block.calls.forTurn[1], { text: 'when?', previousUserText: 'tell me about the vet', brief: true, profileIds: [1, 2] });
});

test('memory: forTurn throwing → the turn still answers, no memo', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'fine' }, { type: 'done' }]);
  const { sessions, orc, s } = setup(fp, { orc: { memoryBlock: fakeBlock({ fail: true }) } });
  const r = await orc.send(s.id, 'hello', { source: 'text' });
  assert.equal(r.reply, 'fine');
  assert.equal(sessions.load(s.id).messages[0].memo, undefined);
});

test('memory: a tainted turn → afterTurn gets tainted: true', async () => {
  const fp = createFakeProvider([
    [{ type: 'tool_call', id: 'c1', name: 'lookup_knowledge', args: {} }, { type: 'done' }],
    [{ type: 'token', text: 'done' }, { type: 'done' }],
  ]);
  const block = fakeBlock();
  const tools = createToolRunner([{ name: 'lookup_knowledge', description: 'w', params: {}, async run() { return 'page text'; } }]);
  const { orc, s } = setup(fp, { tools, orc: { memoryBlock: block } });
  await orc.send(s.id, 'read that page', { source: 'text' });
  assert.deepEqual(block.calls.afterTurn, [{ ids: [7, 8], tainted: true }]);
});

test('memory: "no, that\'s wrong" after a recall → onUserMessage gets the last ids', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'ok' }, { type: 'done' }]);
  const block = fakeBlock();
  const { orc, s, sessions } = setup(fp, { orc: { memoryBlock: block } });
  await orc.send(s.id, 'how is Rex', { source: 'text' });
  await orc.send(s.id, "no, that's wrong", { source: 'text' });
  assert.deepEqual(block.calls.onUserMessage[0], { text: 'how is Rex', lastIds: [] });
  assert.deepEqual(block.calls.onUserMessage[1], { text: "no, that's wrong", lastIds: [7, 8] });
  const other = sessions.create(); sessions.save(other);
  await orc.send(other.id, 'no', { source: 'text' });
  assert.deepEqual(block.calls.onUserMessage[2].lastIds, [], 'another chat has no last recall');
});

test('memory: a forgotten item is pruned from older saved memos before they are sent', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'ok' }, { type: 'done' }]);
  const block = fakeBlock({ memo: 'HEADER\nRex is a dog\nRex likes walks', ids: [7, 8] });
  let dead = new Set();
  block.prune = (memo, ids) => {
    if (!ids.some(id => dead.has(id))) return null;
    const lines = memo.split('\n');
    const keep = ids.map((id, i) => [id, lines[i + 1]]).filter(([id]) => !dead.has(id));
    return { memo: keep.length ? [lines[0], ...keep.map(x => x[1])].join('\n') : '', ids: keep.map(x => x[0]) };
  };
  const { sessions, orc, s } = setup(fp, { orc: { memoryBlock: block } });
  await orc.send(s.id, 'how is Rex', { source: 'text' });
  dead = new Set([7]);
  block.forTurn = async () => ({ memo: '', ids: [] });
  await orc.send(s.id, 'forget that he is a dog', { source: 'text' });
  const first = fp.calls[1].messages.filter(m => m.role === 'user')[0].content;
  assert.doesNotMatch(first, /Rex is a dog/);
  assert.match(first, /Rex likes walks/);
  const saved = sessions.load(s.id).messages[0];
  assert.deepEqual(saved.memoIds, [8]);
  assert.doesNotMatch(saved.memo, /Rex is a dog/);
});
