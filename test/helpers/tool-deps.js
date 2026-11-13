// Stub dependencies that make defaultTools build every tool (no real PC, network or timers).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBus } = require('../../src/core/bus');
const { DEFAULTS } = require('../../src/core/config');
const { createTimerStore } = require('../../src/core/timers/store');
const { createScheduler } = require('../../src/core/timers/scheduler');
const { createConfirm } = require('../../src/core/pc/confirm');
const { createActionLog } = require('../../src/core/pc/actions-log');
const { createFakePcHost } = require('./fake-pc-host');

function toolDeps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jtd-'));
  const any = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : () => ({})) });
  const scheduler = createScheduler({ store: createTimerStore({ file: path.join(dir, 't.json') }), bus: createBus(), setTimer: () => 1, clearTimer: () => {} });
  const roots = ['C:\t\Desktop', 'C:\t\Documents', 'C:\t\Downloads', 'C:\t\Projects'];
  const pc = { host: createFakePcHost(), getAllowlist: async () => [], roots, confirm: createConfirm({}), actionLog: createActionLog({ file: path.join(dir, 'a.log') }) };
  const browserLink = { connected: false, request: async () => { throw new Error('no extension in tests'); } };
  const analytics = { metrics: { summary: () => 'ok', query: () => ({}) }, openDashboard: async () => 'http://127.0.0.1:47801/ai/dashboard' };
  const self = { getChecks: () => [], about: () => ({ version: '0.0.0', startedAt: 0 }), logFile: path.join(dir, 'jarvis.log'), dataDir: dir };
  return { self, analytics, browserLink, getStatus: async () => ({}), fetch: async () => ({}), fetcher: any, web: any, kiwix: any, getConfig: () => DEFAULTS, applySettings: () => [], bus: createBus(), media: any, ytm: any, lyrics: any, ytPlaylists: any, memory: any, chats: any, cortex: any, playLog: any, scheduler, pc };
}

// the real tool objects for some names, as the prompt now takes them (its guidance line is the tool's own hint)
function realTools(names) {
  const { loadGroups, buildCatalog } = require('../../src/core/skills');
  const cat = buildCatalog(loadGroups(toolDeps()));
  return names.map(n => cat.tools.find(t => t.name === n) || { name: n });
}

module.exports = { toolDeps, realTools };
