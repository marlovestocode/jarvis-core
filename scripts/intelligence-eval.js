// Offline baseline for the intelligence roadmap: runs test/fixtures/intelligence-eval-v<N>.json through the rule layer
// (selectGroups + clarify), the same two calls the orchestrator makes before any model is involved. No model, no GPU.
//   node scripts/intelligence-eval.js [--v 1] [--json] [--cat multi-system] [--model off|fake|ollama] [--noise 0.15] [--seed 1] [--budget ms]
// --model off (default) is this rule-only run, output unchanged. fake / ollama: see scripts/intelligence-eval-model.js.
// Per row: act = every expected group loaded; ask / decline = clarify said so; answer = nothing intercepted and no action group
// loaded; model = low confidence (the rules did not pretend to know) and no action group loaded by guess. mustNotAct adds
// "no group other than core/knowledge, no intercept that acts". confirmTool rows also check the tool exists and is risk 'confirm'.
// Measures only the rule layer: the model's own tool pick, argument construction, clarification wording and execution are not here.
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { selectGroups } = require('../src/core/skills/select');
const { clarify } = require('../src/core/skills/clarify');
const { toolDeps } = require('../test/helpers/tool-deps');

const vi = process.argv.indexOf('--v');
const version = vi > 0 ? process.argv[vi + 1] : '1';
const only = process.argv.indexOf('--cat') > 0 ? process.argv[process.argv.indexOf('--cat') + 1] : null;
const set = require(`../test/fixtures/intelligence-eval-v${version}.json`);
const catalog = buildCatalog(loadGroups(toolDeps()));
const PASSIVE = new Set(['core', 'knowledge']);

function judge(row) {
  const picked = selectGroups(row.text, { lastGroups: row.lastGroups || [], source: 'text' }, catalog);
  const c = clarify(row.text, { lastGroups: row.lastGroups || [], picked, catalog });
  const acting = picked.filter(g => !PASSIVE.has(g));
  const got = c ? c.kind : `${picked.join('+')}${picked.confidence ? `(${picked.confidence})` : ''}`;
  let ok;
  const e = row.expect;
  if (e === 'ask' || e === 'decline') ok = c?.kind === e;
  else if (e === 'answer') ok = !c && acting.length === 0;
  else if (e === 'model') ok = !c && picked.confidence === 'low' && acting.length === 0;
  else ok = !c && e.act.every(g => picked.includes(g));
  if (ok && row.mustNotAct) ok = !!c || acting.length === 0;   // an ask / decline is not an action
  if (ok && row.confirmTool) { const t = catalog.tools.find(x => x.name === row.confirmTool); ok = !!t && t.risk === 'confirm'; }
  // a wrong exposure is worse than a miss: loaded an action group (tools offered to the model, not executed) when the right outcome was ask / decline / answer / model
  const falseAction = !ok && typeof e === 'string' && !c && acting.length > 0;
  return { ok, got, falseAction };
}

const rows = set.rows.filter(r => !only || r.cat === only);
const mi = process.argv.indexOf('--model');
const mode = mi > 0 ? process.argv[mi + 1] : 'off';
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
if (require.main !== module) module.exports = { judge, catalog };
else if (mode === 'fake' || mode === 'ollama') runModelMode();
else if (mode !== 'off') { console.error(`unknown --model ${mode} (use off, fake or ollama)`); process.exitCode = 2; }
else runRuleOnly();

// --model fake|ollama: the same rows through the Phase 2 pipeline (scripts/intelligence-eval-model.js)
async function runModelMode() {
  const { runModel, print } = require('./intelligence-eval-model');
  let baseline = null;
  try { if (version === '1') baseline = require('../docs/intelligence/baseline-intelligence-eval-v1.json'); } catch { baseline = null; }
  const r = await runModel({ set, rows, mode, noise: arg('--noise', 0.15), seed: arg('--seed', 1), budgetMs: arg('--budget', 0), judge, ruleCatalog: catalog, baseline: only ? null : baseline });
  if (r.skip) { console.log(r.skip); return; }   // no local model is not a failure
  console.log(process.argv.includes('--json') ? JSON.stringify(r.out) : print(r.out, only ? null : baseline));
  process.exitCode = r.code;
}

function runRuleOnly() {
const by = {};
const misses = [];
let falseActions = 0;
const t0 = process.hrtime.bigint();
for (const row of rows) {
  const r = judge(row);
  const b = (by[row.cat] ||= { n: 0, ok: 0 });
  b.n++; if (r.ok) b.ok++; else misses.push({ id: row.id, text: row.text, want: row.expect, got: r.got });
  if (r.falseAction) falseActions++;
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const n = rows.length, ok = Object.values(by).reduce((a, b) => a + b.ok, 0);
const out = { version: set.version, total: n, passed: ok, accuracy: Math.round(ok / n * 1000) / 10, falseActions, ruleLayerMsPerRequest: Math.round(ms / n * 1000) / 1000, byCategory: by };
if (process.argv.includes('--json')) console.log(JSON.stringify(out));
else {
  console.log(`intelligence eval v${set.version}: ${out.accuracy}% (${ok}/${n}), non-action rows that still load an action group: ${falseActions}, rule layer ${out.ruleLayerMsPerRequest} ms/request`);
  for (const [k, v] of Object.entries(by)) console.log(`  ${k.padEnd(22)} ${v.ok}/${v.n}`);
  for (const m of misses) console.log(`  miss ${m.id}: "${m.text}" wanted ${JSON.stringify(m.want)} got ${m.got}`);
}
}
