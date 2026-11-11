const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadGroups, buildCatalog, selectGroups } = require('../src/core/skills');
const { createToolRunner } = require('../src/core/tools/registry');
const { runChecks, report, readLog, isFault } = require('../src/core/self/diagnostics');
const { inspectConfig, DEFAULTS } = require('../src/core/config');
const { applyPatch } = require('../src/core/settings');
const { route } = require('../src/core/brain/router');
const { systemPrompt } = require('../src/core/brain');
const { toolDeps } = require('./helpers/tool-deps');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jself-'));
const iso = ms => new Date(ms).toISOString();

function setup(over = {}, deps = toolDeps()) {
  Object.assign(deps, over);
  const catalog = buildCatalog(loadGroups(deps));
  const runner = createToolRunner(catalog.tools, { groups: catalog.groups });
  return { deps, catalog, runner, scope: runner.turn(['core', 'self']), ctx: { turn: { tainted: false } } };
}

// ---- the check runner ----
test('runChecks: text is ok, off is off, false / a throw / no answer are failures', async () => {
  const r = await runChecks([
    { id: 'a', run: () => 'fine' },
    { id: 'b', run: async () => ({ ok: true, detail: 'also fine' }) },
    { id: 'c', run: () => ({ off: true, detail: 'switched off' }) },
    { id: 'd', run: () => ({ ok: false, detail: 'broken' }) },
    { id: 'e', run: () => { throw new Error('boom'); } },
    { id: 'f', run: () => new Promise(() => {}), timeoutMs: 20 },
  ]);
  assert.deepEqual(r.map(x => [x.id, x.state, x.detail]), [['a', 'ok', 'fine'], ['b', 'ok', 'also fine'], ['c', 'off', 'switched off'], ['d', 'fail', 'broken'], ['e', 'fail', 'boom'], ['f', 'fail', 'no answer']]);
  const text = report(r);
  assert.match(text, /^Self-check: 2 ok, 3 with a problem, 1 off \(6 checks\)\./);
  assert.ok(text.indexOf('PROBLEMS: d: broken; e: boom; f: no answer.') < text.indexOf('Off or not set up'), 'problems come first');
  assert.match(text, /Off or not set up \(not faults\): c: switched off\./);
  assert.match(text, /Working: a: fine; b: also fine\./);
});

test('readLog: newest lines with their time; isFault picks warnings, errors and OFF stages', () => {
  const file = path.join(tmp(), 'jarvis.log');
  assert.deepEqual(readLog(file), [], 'no log yet');
  fs.writeFileSync(file, [`${iso(1000)}  boot core: ok v0.1.0 (1 ms)`, `${iso(2000)}  boot sysmon: OFF not running (3 ms)`, `${iso(3000)}  warn: Voice turn failed: x`, 'a line with no time', `${iso(4000)}  wake word heard`].join('\n') + '\n');
  const lines = readLog(file);
  assert.equal(lines.length, 5);
  assert.deepEqual(lines[1], { at: 2000, text: 'boot sysmon: OFF not running (3 ms)' });
  assert.equal(lines[3].at, 0);
  assert.deepEqual(lines.filter(l => isFault(l.text)).map(l => l.at), [2000, 3000]);
  assert.equal(isFault('turned the lights off'), false, 'only the capital OFF of a boot stage');
  // a long log is read from its end, and the cut first line is dropped
  fs.writeFileSync(file, Array.from({ length: 200 }, (_, i) => `${iso(i * 1000)}  line ${i}`).join('\n') + '\n');
  const tail = readLog(file, { maxBytes: 400 });
  assert.ok(tail.length > 3 && tail.length < 20);
  assert.equal(tail.at(-1).text, 'line 199');
  assert.match(tail[0].text, /^line \d+$/);
});

// ---- settings ----
test('inspectConfig: unknown keys and refused values are named; changed settings are listed', () => {
  const dir = tmp();
  assert.deepEqual({ ...inspectConfig(dir), config: null, file: null }, { file: null, exists: false, error: '', broken: false, ignored: [], changed: [], config: null });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ provider: 'ollama', oldKey: 1, vad: 'nope', endSilenceMs: 9000, ollama: { model: 'm', color: 'red' }, wakeEnabled: false }));
  const c = inspectConfig(dir);
  assert.equal(c.exists, true);
  assert.deepEqual(c.ignored.sort(), ['endSilenceMs', 'oldKey', 'ollama.color', 'vad']);
  assert.deepEqual(c.changed.sort(), ['endSilenceMs', 'ollama.model', 'provider']);   // 9000 is clamped to 1500: in effect, and not what the file says
  assert.equal(c.config.vad, DEFAULTS.vad);
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
  const bad = inspectConfig(dir);
  assert.ok(bad.error);
  assert.deepEqual(bad.changed, []);
  assert.ok(fs.existsSync(path.join(dir, 'config.json')), 'inspecting never moves or rewrites the file');
});

test('applyPatch: does not write into the config it was given', () => {
  const current = { ...DEFAULTS, user: { name: 'Ann', about: '' } };
  const { config } = applyPatch(current, { user: { name: 'Bea' } }, { providers: { get: () => null }, engines: {} });
  assert.equal(config.user.name, 'Bea');
  assert.equal(current.user.name, 'Ann');
  // the frozen defaults can be patched too (the write used to be dropped silently)
  assert.equal(applyPatch(DEFAULTS, { user: { name: 'Bea' } }, { providers: { get: () => null }, engines: {} }).config.user.name, 'Bea');
});

// ---- skill loading ----
test('loadGroups: every group loads with full dependencies; a group that throws is reported, the rest still load', () => {
  const ok = loadGroups(toolDeps());
  assert.deepEqual(ok.missing, []);
  assert.ok(ok.some(g => g.id === 'self'));
  const deps = toolDeps();
  Object.defineProperty(deps, 'memory', { get() { throw new Error('boom'); }, enumerable: true });
  const groups = loadGroups(deps);
  assert.deepEqual(groups.missing, [{ id: 'memory', error: 'boom' }]);
  assert.equal(groups.length, ok.length - 1);
  assert.deepEqual(buildCatalog(groups).missing, groups.missing);
  // without its dependency a group is left out, with no error
  assert.deepEqual(loadGroups({}).missing.find(m => m.id === 'self'), { id: 'self' });
});

test('runner: counts calls and failures per tool', async () => {
  const { runner, ctx } = setup();
  await runner.run('calculate', { expression: '1+1' }, ctx);
  await runner.run('calculate', { expression: '1+' }, ctx);
  await runner.run('nope', {}, ctx);
  const s = runner.stats().get('calculate');
  assert.equal(s.calls, 2);
  assert.equal(s.fails, 1);
  assert.match(s.lastError, /^Error: /);
  assert.equal(runner.stats().has('nope'), false);
});

// ---- the tools ----
test('skills_list: the overview is the live catalog (every group, every tool), with what cannot work and what failed', async () => {
  const { catalog, scope, ctx } = setup({ fetch: async () => { throw new Error('down'); } });
  let r = await scope.run('skills_list', {}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.text, new RegExp(`^${catalog.groups.length} skill groups, ${catalog.tools.length} tools\\. Loaded for this request: core, self`));
  for (const g of catalog.groups) assert.ok(r.text.includes(`- ${g.id} (${g.label})`), g.id);
  for (const t of catalog.tools) assert.match(r.text, new RegExp(`\\b${t.name}\\b`), t.name);
  assert.match(r.text, /- browser \(.*\) \[CANNOT WORK NOW: off in settings\]/);
  assert.match(r.text, /- system \(.*\) \[CANNOT WORK NOW: sysmon is not running\]/);
  assert.match(r.text, /No tool has failed since start\./);
  assert.equal(r.untrusted, undefined);

  await scope.run('get_system_stats', {}, ctx);   // fails: sysmon is down
  r = await scope.run('skills_list', {}, ctx);
  assert.match(r.text, /Failed since start: get_system_stats 1 of 1 \(last: Error: Sysmon is not running\)/);
});

test('skills_list: one group in detail, by id, label or tool name; unknown and unloaded groups say so', async () => {
  const { scope, ctx, catalog } = setup();
  const r = await scope.run('skills_list', { group: 'pc' }, ctx);
  const pc = catalog.groups.find(g => g.id === 'pc');
  assert.match(r.text, new RegExp(`^pc: ${pc.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. ${pc.tools.length} tools\\. Can work now\\.`));
  assert.equal(r.text.split('\n').length, pc.tools.length + 1);
  assert.match(r.text, /- close_app: .* \(asks first\)/);
  assert.doesNotMatch(r.text, /- open_app: .*asks first/);
  assert.match((await scope.run('skills_list', { group: 'calculate' }, ctx)).text, /^math: /);
  assert.match((await scope.run('skills_list', { group: 'browser' }, ctx)).text, /CANNOT WORK NOW: off in settings/);
  const none = await scope.run('skills_list', { group: 'teleport' }, ctx);
  assert.equal(none.ok, false);
  assert.match(none.text, /No skill group or tool called "teleport"\. Groups: core, /);

  const deps = toolDeps();
  Object.defineProperty(deps, 'memory', { get() { throw new Error('boom'); }, enumerable: true });
  const broken = setup({}, deps);
  assert.match((await broken.scope.run('skills_list', {}, broken.ctx)).text, /FAILED TO LOAD: memory \(boom\)\./);
  assert.match((await broken.scope.run('skills_list', { group: 'memory' }, broken.ctx)).text, /memory is not loaded: it failed to load \(boom\)/);
  const diag = await broken.scope.run('self_diagnostics', {}, broken.ctx);
  assert.match(diag.text, /PROBLEMS: .*skills: did not load: memory \(boom\)/);
});

test('self_diagnostics: the app checks, the skills, tool failures and faults logged since start', async () => {
  const dir = tmp();
  const logFile = path.join(dir, 'jarvis.log');
  const startedAt = Date.now() - 60000;
  fs.writeFileSync(logFile, `${iso(startedAt - 5000)}  warn: old trouble\n${iso(startedAt + 1000)}  boot core: ok\n${iso(startedAt + 1500)}  boot sysmon: OFF not running (2 ms)\n`);
  const self = { getChecks: () => [{ id: 'model', run: () => 'Ollama: ready' }, { id: 'sysmon', run: () => ({ off: true, detail: 'not running' }) }], about: () => ({ version: '9.9.9', startedAt }), logFile, dataDir: dir };
  const { scope, ctx, catalog } = setup({ self });
  let r = await scope.run('self_diagnostics', {}, ctx);
  assert.equal(r.ok, true);
  assert.match(r.text, /^Self-check: 4 ok, 0 with a problem, 1 off \(5 checks\)\./);
  assert.doesNotMatch(r.text, /PROBLEMS/);
  assert.match(r.text, /Off or not set up \(not faults\): sysmon: not running\./);
  assert.match(r.text, new RegExp(`skills: ${catalog.groups.length} groups, ${catalog.tools.length} tools`));
  assert.match(r.text, /tool runs: 0 calls since start, none failed/);
  assert.match(r.text, /log: no faults logged since start/);   // the old warning is from before this start; a stage that was off at boot belongs to the startup check

  fs.appendFileSync(logFile, `${iso(startedAt + 2000)}  tool failed: get_weather (Error: offline)\n`);
  await scope.run('calculate', { expression: '1+' }, ctx);
  r = await scope.run('self_diagnostics', {}, ctx);
  assert.match(r.text, /^Self-check: 2 ok, 2 with a problem, 1 off/);
  assert.match(r.text, /PROBLEMS: tool runs: calculate failed 1 of 1 \(last: Error: .*\); log: 1 fault line since start \(last: tool failed: get_weather \(Error: offline\)\); self_log shows them\./);
});

test('self_config: version, uptime, changed settings and ignored entries, from config.json', async () => {
  const dir = tmp();
  const self = { getChecks: () => [], about: () => ({ version: '9.9.9', electron: '45.0.0', node: '22.0.0', startedAt: Date.now() - 3 * 3600000 - 5 * 60000 }), logFile: path.join(dir, 'jarvis.log'), dataDir: dir };
  const { scope, ctx } = setup({ self });
  let r = await scope.run('self_config', {}, ctx);
  assert.match(r.text, /^JARVIS core v9\.9\.9, Electron 45\.0\.0, Node 22\.0\.0; running for 3 h 5 min\./);
  assert.match(r.text, /Settings file: none yet; defaults are in use\./);
  assert.match(r.text, /Every setting is at its default\./);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ provider: 'ollama', hotkeys: { chat: 'Alt+J' }, junk: true }));
  r = await scope.run('self_config', {}, ctx);
  assert.match(r.text, /Settings file: config\.json, read fine\./);
  assert.match(r.text, /Changed from the defaults \(2\): provider = "ollama"; hotkeys\.chat = "Alt\+J"\./);
  assert.match(r.text, /IGNORED or adjusted entries in config\.json \(unknown key or bad value\): junk\./);
});

test('self_log: fault lines by default, all lines or a text filter on request; its text is untrusted', async () => {
  const dir = tmp();
  const logFile = path.join(dir, 'jarvis.log');
  const self = { getChecks: () => [], about: () => ({ startedAt: 5000 }), logFile, dataDir: dir };
  const { scope, ctx } = setup({ self });
  assert.equal((await scope.run('self_log', {}, ctx)).text, 'The log is empty.');
  fs.writeFileSync(logFile, [`${iso(1000)}  bridge off: ports taken`, `${iso(6000)}  boot core: ok`, `${iso(7000)}  warn: Voice turn failed: mic`, `${iso(8000)}  wake word heard`].join('\n') + '\n');
  let r = await scope.run('self_log', {}, ctx);
  assert.equal(r.untrusted, true);
  const rows = r.text.split('\n');
  assert.equal(rows[0], 'Fault lines: showing the last 2 of 2 (1 since this start):');
  assert.match(rows[1], /^\d\d-\d\d \d\d:\d\d:\d\d bridge off: ports taken$/);
  assert.match(rows[2], /warn: Voice turn failed: mic$/);
  r = await scope.run('self_log', { show: 'all', lines: 1 }, ctx);
  assert.match(r.text, /^Log lines: showing the last 1 of 4 /);
  assert.match(r.text, /wake word heard$/);
  assert.match((await scope.run('self_log', { contains: 'VOICE' }, ctx)).text, /showing the last 1 of 1 /);
  assert.equal((await scope.run('self_log', { contains: 'zzz' }, ctx)).text, 'No fault lines with "zzz" in the last 4 log lines.');
  // what it read is text from outside: no confirm tool may start in the same turn
  const turn = { tainted: true };
  assert.match((await scope.run('close_app', { name: 'x' }, { turn })).text, /won't start that from text I read/);
});

// ---- reaching the tools ----
test('self questions get tools and the self group; small talk stays quick', () => {
  const { catalog } = setup();
  for (const q of ['run diagnostics', 'run a self-check', 'is everything working', 'what can you do', 'list your skills', 'what tools do you have', 'what version are you', 'show your settings', 'show recent errors', 'what went wrong']) {
    assert.equal(route(q).tools, true, q);
    assert.deepEqual(selectGroups(q, {}, catalog), ['core', 'self'], q);
  }
  for (const q of ['hi', 'thanks', 'who are you', 'tell me a joke']) assert.equal(route(q).tools, false, q);
  assert.deepEqual(selectGroups('turn off the lights', {}, catalog).includes('self'), false);
});

test('prompt and aliases: the self tools are named, and plausible wrong names reach them', async () => {
  const { catalog, runner, ctx } = setup();
  const self = catalog.groups.find(g => g.id === 'self').tools.map(t => t.name);
  assert.deepEqual(self, ['self_diagnostics', 'skills_list', 'self_config', 'self_log']);
  const prompt = systemPrompt({ tools: self });
  for (const n of self) assert.match(prompt, new RegExp(`\\b${n}\\b`), n);
  for (const a of ['diagnostics', 'health_check', 'list_skills', 'list_tools', 'get_version', 'error_log']) assert.doesNotMatch((await runner.run(a, {}, ctx)).text, /unknown tool/, a);
});
