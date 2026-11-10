// Live quality eval against local Ollama (not part of npm test).
//   node eval/run.js raw  [model]   model alone: no system prompt, no tools
//   node eval/run.js app            full jarvis-core brain: prompt, router, tools
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

function grade(q, answer) {
  if (q.text) return String(answer).replace(/[\s,]/g, '').includes(q.text);
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
  return { answer: res.reply || res.error || '', ms: Date.now() - t0, tools, route: route && `${route.model}${route.think ? '+think' : ''}`, steps: s.messages.length };
}

function appFactory() {
  const { createBus } = require('../src/core/bus');
  const { createSessionStore } = require('../src/core/session');
  const { createRegistry } = require('../src/core/providers/provider');
  const { NullProvider } = require('../src/core/providers/null-provider');
  const { createOllamaProvider } = require('../src/core/providers/ollama');
  const { createToolRunner } = require('../src/core/tools/registry');
  const { createOrchestrator } = require('../src/core/orchestrator');
  const { loadConfig, DEFAULTS } = require('../src/core/config');
  const brain = require('../src/core/brain');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-eval-'));
  const config = { ...DEFAULTS, provider: 'ollama', ollama: { ...DEFAULTS.ollama } };
  return () => {
    const bus = createBus();
    const events = [];
    bus.on('*', e => events.push(e));
    const sessions = createSessionStore(dir);
    const providers = createRegistry();
    providers.add(NullProvider);
    providers.add(createOllamaProvider({ getConfig: () => config }));
    const tools = createToolRunner(brain.defaultTools({ getStatus: async () => ({}) }));
    const orc = createOrchestrator({
      bus, sessions, providers, tools, getConfig: () => config,
      systemPrompt: brain.systemPrompt, route: brain.route, timeoutMs: 120000,
    });
    return { orc, sessions, events };
  };
}

(async () => {
  const mode = process.argv[2] || 'raw';
  const model = process.argv[3] || 'jarvis-worker:latest';
  const make = mode === 'app' ? appFactory() : null;
  const rows = [];
  let pass = 0, totalMs = 0;
  for (const q of QUESTIONS) {
    let r;
    try { r = mode === 'app' ? await appAsk(make, q.q) : await rawAsk(model, q.q); } catch (err) { r = { answer: 'ERROR ' + err.message, ms: 0 }; }
    const ok = grade(q, r.answer);
    pass += ok; totalMs += r.ms || 0;
    rows.push({ id: q.id, ok, ms: r.ms, tools: r.tools, route: r.route, answer: String(r.answer) });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${q.id.padEnd(10)} ${String(r.ms).padStart(6)} ms ${r.route ? '[' + r.route + '] ' : ''}${r.tools?.length ? '{' + r.tools.join(',') + '} ' : ''}${String(r.answer).replace(/\s+/g, ' ').slice(0, 110)}`);
  }
  console.log(`\nSCORE ${mode}: ${pass}/${QUESTIONS.length}, total ${(totalMs / 1000).toFixed(1)} s`);
  fs.writeFileSync(path.join(__dirname, `results-${mode}.json`), JSON.stringify({ mode, model, pass, total: QUESTIONS.length, totalMs, rows }, null, 2));
})();

module.exports = { grade, numbers };
