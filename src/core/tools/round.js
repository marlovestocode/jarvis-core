'use strict';
// One tool round: the calls the model made together, run as batches. Only reads that need no confirmation share a batch
// (parallelSafe); everything else runs alone, in order. Every call still goes through `run` (the exec path), so exec() stays
// the only authority: this file decides WHEN calls run, never WHETHER they may.
const PARALLEL_MAX = 4;   // a batch is capped so one round cannot open an unbounded number of page/file/net reads at once

// jobs: [{ call, preset }]; a preset result (a blocked or repeated call) never runs, so it never joins a batch
function partition(jobs, parallelSafeOf) {
  const batches = [];
  let cur = null;
  for (const j of jobs) {
    const ok = !j.preset && parallelSafeOf(j.call.name) === true;
    if (ok && cur && cur.length < PARALLEL_MAX) cur.push(j);
    else { cur = ok ? [j] : null; batches.push(ok ? cur : [j]); }
  }
  return batches;
}

const sig = c => `${c.name}:${JSON.stringify(c.args ?? {})}`;
const failure = e => ({ ok: false, text: `Error: ${e?.message || e}` });

async function runBatch(batch, run) {
  if (batch.length === 1) {
    const j = batch[0];
    if (j.preset) return [j.preset];
    try { return [await run(j.call)]; } catch (e) { return [failure(e)]; }
  }
  // identical calls inside one batch run once: the model asked for the same read twice, one answer serves both
  const pending = new Map();
  return Promise.all(batch.map(j => {
    const k = sig(j.call);
    if (!pending.has(k)) pending.set(k, Promise.resolve().then(() => run(j.call)).catch(failure));
    return pending.get(k);
  }));
}

// -> results in job order. Taint from an untrusted result lands on `turn` (the object exec reads) after each batch and before the
// next one starts, so a confirm call that follows an untrusted read in the same round is refused instead of run.
async function runRound({ jobs, run, turn, signal, parallelSafeOf, parallel = true }) {
  const batches = parallel ? partition(jobs, parallelSafeOf) : jobs.map(j => [j]);
  const out = [];
  for (const batch of batches) {
    if (signal?.aborted) { for (const _ of batch) out.push({ ok: false, text: 'Error: aborted' }); continue; }
    const results = await runBatch(batch, run);
    for (const res of results) if (res?.untrusted) turn.tainted = true;
    out.push(...results);
  }
  return out;
}

module.exports = { partition, runRound, PARALLEL_MAX };
