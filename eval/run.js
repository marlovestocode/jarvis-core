// Live quality eval against local Ollama (not part of npm test).
//   node eval/run.js raw  [model]   model alone: no system prompt, no tools
//   node eval/run.js app            full jarvis-core brain: prompt, router, tools (skill groups when this branch has them)
// Env: JARVIS_EVAL_GROUP=tools  only the tool-choice questions; JARVIS_EVAL_STUBS=1  fake PC host, timers, media... for every
//      tool (the eval never touches the real PC); JARVIS_EVAL_OUT=<file>  write the results there.
// Writes eval/results-<mode>.json and prints a score.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
const HOST = 'http://127.0.0.1:11434';

// numbers in the answer: "25,072.33", "2.48e0", "1.3 × 10^4" (simple forms)
function numbers(text) {
  const s = String(text).replace(/(\d),(?=\d{3}\b)/g, '$1');
  const out = [];
  for (const m of s.matchAll(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?:\s*[×x*]\s*10\^?\s*\(?(-?\d+)\)?)?/g)) {
    let v = parseFloat(m[0]);
    if (m[1] !== undefined) v = parseFloat(m[0]) * Math.pow(10, +m[1]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

function grade(q, answer, result = {}) {
  // tool choice: the model called the expected tool (against stub hosts, so what the tool answered does not matter)
  if (q.pick) return (result.tools || []).includes(q.pick) && !result.error;
  if (q.tool) return (result.toolResults || []).some(t => t.name === q.tool && t.ok) && !result.error;
  if (q.text) return String(answer).toLowerCase().replace(/[\s,]/g, '').includes(q.text.toLowerCase().replace(/[\s,]/g, ''));
  const tol = q.tol === 0 ? 0.5 : Math.abs(q.num) * q.tol + 1e-12;
  return numbers(String(answer).slice(-300)).some(v => Math.abs(v - q.num) <= tol); // final answer, not working
}

async function rawAsk(model, q) {
  const r = await fetch(HOST + '/api/chat', {
    method: 'POST',
    body: JSON.stringify({ model, stream: false, think: false, messages: [{ role: 'user', content: q }] }),
  });
  const j = await r.json();
  return { answer: j.message?.content || '', tokens: j.eval_count, ms: Math.round((j.total_duration || 0) / 1e6) };
}

async function appAsk(make, q) {
  const { orc, sessions, events } = make();
  const t0 = Date.now();
  const res = await orc.send(null, q, { source: 'text' });
  const tools = events.filter(e => e.type === 'tool' && e.phase === 'start').map(e => e.name);
  const route = events.find(e => e.type === 'route');
  const s = sessions.load(res.sessionId);
  return { answer: res.reply || res.error || '', error: res.error, ms: Date.now() - t0, tools, route: route && `${route.model}${route.think ? '+think' : ''}`, steps: s.messages.length,
    toolResults: events.filter(e => e.type === 'tool' && e.phase === 'end').map(e => ({ name: e.name, ok: e.ok })),
    sources: events.filter(e => e.type === 'net'), evidence: s.messages.filter(m => m.role === 'tool').map(m => ({ name: m.name, text: m.content })) };
}

function baselineBrain() {
  const vm = require('node:vm');
  const { execFileSync } = require('node:child_process');
  const { createRequire } = require('node:module');
  const root = path.resolve(__dirname, '..');
  const cache = new Map();
  const load = file => {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    const local = createRequire(path.join(root, file));
    const code = execFileSync('git', ['-C', root, 'show', 'main:' + file], { encoding: 'utf8' });
    const requireAt = id => ['src/core/brain/prompt.js', 'src/core/brain/router.js'].includes(path.relative(root, local.resolve(id)).replace(/\\/g, '/')) ? load(path.relative(root, local.resolve(id)).replace(/\\/g, '/')) : local(id);
    vm.runInThisContext('(function(require,module,exports){' + code + '\n})', { filename: 'baseline/' + file })(requireAt, module, module.exports);
    cache.set(file, module.exports);
    return module.exports;
  };
  return load('src/core/brain/index.js');
}

function appFactory({ before = false } = {}) {
  const { createBus } = require('../src/core/bus');
  const { createSessionStore } = require('../src/core/session');
  const { createRegistry } = require('../src/core/providers/provider');
  const { NullProvider } = require('../src/core/providers/null-provider');
  const { createOllamaProvider } = require('../src/core/providers/ollama');
  const { createToolRunner } = require('../src/core/tools/registry');
  const { createOrchestrator } = require('../src/core/orchestrator');
  const { loadConfig, DEFAULTS } = require('../src/core/config');
  const brain = before ? baselineBrain() : require('../src/core/brain');
  const stubs = process.env.JARVIS_EVAL_STUBS ? require('../test/helpers/tool-deps').toolDeps() : {};
  const { createPolicy } = require('../src/core/net/policy');
  const { createFetcher } = require('../src/core/net/fetcher');
  const { createKiwix } = require('../src/core/knowledge/kiwix');
  const { createHardwareProbe } = require('../src/core/brain/hardware');
  const probe = createHardwareProbe();
  probe.get();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-eval-'));
  const config = loadConfig(process.env.JARVIS_DATA_DIR || path.join(os.homedir(), 'AppData', 'Roaming', 'jarvis-core'));
  config.provider = 'ollama';
  const kiwix = createKiwix({ exe: path.join(__dirname, '../engines/kiwix/kiwix-serve.exe'), zimDir: 'C:\\JarvisData\\library' });
  const make = () => {
    const bus = createBus();
    const events = [];
    bus.on('*', e => events.push(e));
    const sessions = createSessionStore(dir);
    const providers = createRegistry();
    providers.add(NullProvider);
    providers.add(createOllamaProvider({ getConfig: () => config }));
    const fetcher = createFetcher({ policy: createPolicy(() => config), bus, cacheDir: path.join(dir, 'cache') });
    const deps = { ...stubs, getStatus: async () => ({ ...(await probe.get()), model: config.ollama.model }), ...(!before ? { fetcher, kiwix, getConfig: () => config, bus } : {}) };
    // this branch: skill groups, like the app; an older branch has only the flat list
    const grouped = !before && typeof brain.defaultCatalog === 'function';
    let tools, selectGroups, caps;
    if (grouped) {
      const catalog = brain.defaultCatalog(deps);
      const skills = require('../src/core/skills');
      tools = createToolRunner(catalog.tools, { groups: catalog.groups });
      selectGroups = (text, o) => skills.selectGroups(text, o, catalog);
      caps = skills.capsLine(catalog, { browser: 'off' });
    } else tools = createToolRunner(brain.defaultTools(deps));
    const orc = createOrchestrator({
      bus, sessions, providers, tools, getConfig: () => config, selectGroups,
      systemPrompt: brain.systemPrompt, route: brain.route, timeoutMs: 120000,
      promptInfo: () => ({ hardware: probe.cached(), ...(caps ? { caps } : {}) }),
    });
    return { orc, sessions, events };
  };
  make.close = () => kiwix.close();
  make.model = config.ollama.model;
  return make;
}

async function run() {
  const mode = process.argv[2] || 'raw';
  if (!['app', 'before', 'raw'].includes(mode)) throw new Error('Mode must be app, before or raw');
  const make = mode === 'raw' ? null : appFactory({ before: mode === 'before' });
  const model = make?.model || process.argv[3] || 'jarvis-worker:latest';
  const questions = process.env.JARVIS_EVAL_GROUP ? QUESTIONS.filter(q => q.group === process.env.JARVIS_EVAL_GROUP || (process.env.JARVIS_EVAL_GROUP === 'knowledge' && q.group)) : QUESTIONS;
  const rows = [];
  let pass = 0, totalMs = 0;
  try {
    for (const q of questions) {
      let r;
      try { r = make ? await appAsk(make, q.q) : await rawAsk(model, q.q); } catch (err) { r = { answer: 'ERROR ' + err.message, error: err.message, ms: 0 }; }
      const ok = grade(q, r.answer, r);
      pass += ok; totalMs += r.ms || 0;
      rows.push({ id: q.id, group: q.group || 'brain', ok, ...r, answer: String(r.answer) });
      console.log(`${ok ? 'PASS' : 'FAIL'} ${q.id.padEnd(12)} ${String(r.ms).padStart(6)} ms ${r.route ? '[' + r.route + '] ' : ''}${r.tools?.length ? '{' + r.tools.join(',') + '} ' : ''}${String(r.answer).replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  } finally { make?.close(); }
  const groups = Object.fromEntries(['brain', 'fact', 'live', 'tools'].map(group => {
    const rs = rows.filter(r => r.group === group);
    return [group, { pass: rs.filter(r => r.ok).length, total: rs.length, offlineRetrieved: rs.filter(r => r.sources?.some(s => s.offline)).length }];
  }));
  console.log(`\nSCORE ${mode}: ${pass}/${questions.length}, total ${(totalMs / 1000).toFixed(1)} s; ${JSON.stringify(groups)}`);
  const file = process.env.JARVIS_EVAL_OUT || path.join(__dirname, `results-${mode}.json`);
  if (!process.env.JARVIS_EVAL_OUT && fs.existsSync(file)) fs.copyFileSync(file, file.replace('.json', `-previous-${Date.now()}.json`));
  fs.writeFileSync(file, JSON.stringify({ mode, model, at: new Date().toISOString(), pass, total: questions.length, totalMs, groups, rows }, null, 2));
}

if (require.main === module) run().catch(err => { console.error(err); process.exitCode = 1; });
module.exports = { grade, numbers, baselineBrain, appFactory };
