'use strict';
// Baseline vs new tool intelligence on the same fixtures.
//   node scripts/tool-intelligence-eval.js [--set v1|heldout] [--registry real|synth100|synth300|synth500|all] [--mode both|baseline|new]
//        [--noise 0.1] [--seed 1] [--model fake|ollama] [--json]
// The model is a scripted oracle: this measures the pipeline (discovery, recovery, duplicates, refusals), NOT how well a real LLM
// reads requests. --model ollama only runs the live GROUP-selection eval (intelligence-eval.js); tool-level live runs are not built.
// Exit code 1 when a gate fails (new worse than baseline on selection or completion, an unsafe exec, extra model calls).
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runSet, metrics } = require('./tool-eval-run');

const FILES = { v1: '../test/fixtures/tool-eval-v1.json', heldout: '../test/fixtures/tool-eval-heldout.json' };
const arg = (argv, k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const pct = x => `${(x * 100).toFixed(1)}%`;
const f1 = x => (Math.round(x * 10) / 10).toString();

function load(set) { return require(FILES[set]); }

// the gates that depend only on a pair of runs of the same rows
function gatesFor({ baseline, nw, rows }) {
  const fails = [];
  if (nw.metrics.selectionAccuracy < baseline.metrics.selectionAccuracy) fails.push('selectionAccuracy below baseline');
  if (nw.metrics.completion < baseline.metrics.completion) fails.push('completion below baseline');
  if (nw.metrics.unsafeExecs > 0 || baseline.metrics.unsafeExecs > 0) fails.push('unsafe exec');
  if (nw.metrics.extraCallsMax > 1) fails.push('more than one extra model call');
  const simple = nw.rows.filter(r => r.simple);
  if (simple.some(r => r.extra > 0 || r.embeds > 0)) fails.push('a simple command made an extra model or embed call');
  if (nw.metrics.dupWrites > 0) fails.push('a duplicate write ran');
  return fails;
}

function table(title, a, b) {
  const L = [title];
  const row = (name, x, y) => L.push(`  ${name.padEnd(22)} ${String(x).padStart(10)} ${String(y).padStart(10)}`);
  L.push(`  ${''.padEnd(22)} ${'baseline'.padStart(10)} ${'new'.padStart(10)}`);
  row('rows', a.rows, b.rows);
  row('selectionAccuracy', pct(a.selectionAccuracy), pct(b.selectionAccuracy));
  row('completion', pct(a.completion), pct(b.completion));
  row('unnecessaryCalls', a.unnecessaryCalls, b.unnecessaryCalls);
  row('dupWrites', a.dupWrites, b.dupWrites);
  row('executionFailures', a.executionFailures, b.executionFailures);
  row('latency p50/p95 ms', `${a.latencyMs.p50}/${a.latencyMs.p95}`, `${b.latencyMs.p50}/${b.latencyMs.p95}`);
  row('modelCalls / row', f1(a.modelCalls), f1(b.modelCalls));
  row('specTokens / round', a.specTokens, b.specTokens);
  row('promptTokens / row', a.promptTokens, b.promptTokens);
  row('unsafeExecs', a.unsafeExecs, b.unsafeExecs);
  row('extraCallsMax', a.extraCallsMax, b.extraCallsMax);
  return L.join('\n');
}

async function compare({ set, registries, noise, seed, delay }) {
  const all = load(set).rows.filter(r => registries.includes(r.registry));
  const opts = { noise, seed, modelDelayMs: delay, set };
  const baseline = await runSet({ rows: all, mode: 'baseline', ...opts });
  const nw = await runSet({ rows: all, mode: 'new', ...opts });
  return { baseline, nw, rows: all };
}

async function main(argv) {
  const set = arg(argv, 'set', 'v1'), reg = arg(argv, 'registry', 'all'), mode = arg(argv, 'mode', 'both');
  const noise = Number(arg(argv, 'noise', 0.1)), seed = Number(arg(argv, 'seed', 1)), json = argv.includes('--json');
  if (arg(argv, 'model', 'fake') === 'ollama') {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'intelligence-eval.js'), '--model', 'ollama'], { stdio: 'inherit' });
    console.log('(live model: only the group-selection eval ran; the tool-level bench is oracle-only and never a gate)');
    return r.status || 0;
  }
  const registries = reg === 'all' ? ['real', 'synth100', 'synth300', 'synth500'] : [reg];
  const res = await compare({ set, registries, noise, seed, delay: 30 });
  const cats = [...new Set(res.rows.map(r => r.cat))];
  const out = { set, noise, seed, overall: { baseline: res.baseline.metrics, new: res.nw.metrics }, byCategory: {}, byRegistry: {} };
  const sub = (run, f) => ({ rows: run.rows.filter(f) });
  for (const c of cats) out.byCategory[c] = { baseline: metrics(sub(res.baseline, r => r.cat === c).rows), new: metrics(sub(res.nw, r => r.cat === c).rows) };
  for (const g of registries) out.byRegistry[g] = { baseline: metrics(sub(res.baseline, r => r.registry === g).rows), new: metrics(sub(res.nw, r => r.registry === g).rows) };
  const fails = gatesFor({ baseline: res.baseline, nw: res.nw });
  if (json) { console.log(JSON.stringify({ ...out, fails })); return fails.length ? 1 : 0; }
  console.log(`tool intelligence eval, set=${set}, noise ${noise}, seed ${seed}, model=fake oracle`);
  console.log('  NOTE: a scripted oracle simulates the model\'s tool choices; this measures the pipeline, not LLM quality.');
  if (mode !== 'new' && mode !== 'baseline') console.log(table('overall', out.overall.baseline, out.overall.new));
  for (const g of registries) console.log(table(`registry ${g}`, out.byRegistry[g].baseline, out.byRegistry[g].new));
  console.log('\n  per category (completion, selection baseline -> new)');
  for (const c of cats) { const b = out.byCategory[c].baseline, n = out.byCategory[c].new; console.log(`  ${c.padEnd(20)} n=${String(b.rows).padStart(2)}  completion ${pct(b.completion).padStart(6)} -> ${pct(n.completion).padStart(6)}  selection ${pct(b.selectionAccuracy).padStart(6)} -> ${pct(n.selectionAccuracy).padStart(6)}  unnecessary ${b.unnecessaryCalls} -> ${n.unnecessaryCalls}`); }
  for (const r of res.nw.rows.filter(x => !x.ok)) console.log(`  new miss ${r.id}: ${r.reply}`);
  console.log(fails.length ? `GATES FAILED: ${fails.join('; ')}` : 'gates: pass');
  return fails.length ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { console.error(e); process.exitCode = 1; });
module.exports = { compare, gatesFor };
