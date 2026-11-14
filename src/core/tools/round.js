'use strict';
// One tool round: the calls the model made together, run as batches. Only reads that need no confirmation share a batch
// (parallelSafe); everything else runs alone, in order. Every call still goes through `run` (the exec path), so exec() stays
// the only authority: this file decides WHEN calls run, never WHETHER they may.
const { classify, plan, backoffMs } = require('./recover');
const { check } = require('../tasks/plan');
const { softFail, NEEDS_OK } = require('../brain/guard');
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

// One call with its recovery policy (see recover.js). `run` is always the exec path, so a retry or a verify read is authorized
// again; nothing here widens what may run. A write that may have happened is never retried: it is verified or reported unknown.
async function attemptCall({ call, run, contractOf = () => null, repair = null, sleep = ms => new Promise(r => setTimeout(r, ms)), signal }) {
  const go = async (c, extra) => { try { return await run(c, extra); } catch (e) { return failure(e); } };
  const c = contractOf(call.name) || { effect: 'write', idempotent: false, verify: null };   // unknown contract: fail closed as a write
  let res = await go(call);
  const act = plan(classify(res), { effect: c.effect, idempotent: c.idempotent, attempt: 0 });
  if (act === 'retry' && !signal?.aborted) {
    await sleep(backoffMs(0));
    res = { ...(await go(call)), retried: true };
  } else if (act === 'repair' && repair) {
    let fixed = null;
    try { fixed = await repair(call, res); } catch { /* a failed repair leaves the original failure */ }
    if (fixed && JSON.stringify(fixed.args ?? {}) !== JSON.stringify(call.args ?? {})) res = await go({ ...call, name: fixed.name || call.name, args: fixed.args });
  } else if (act === 'rediscover') {
    return { ...res, rediscover: true, tool: call.name };
  } else if (act === 'verify_or_unknown') {
    return onTimeout(call, res, c, go);
  }
  return afterSuccess(call, res, c, go);
}

// the verify read: through run (exec), fresh so the ledger cannot answer from before the write. -> { vres, expect } or null
async function verifyRead(call, res, v, go) {
  const args = typeof v.args === 'function' ? v.args(call.args, res) : (v.args ?? {});
  const vres = await go({ id: call.id, name: v.tool, args }, { fresh: true });
  const expect = typeof v.expect === 'function' ? v.expect(call.args, vres) : v.expect;
  return { vres, expect };
}

async function onTimeout(call, res, c, go) {
  const unknown = text => ({ ...res, ok: false, unknown: true, text });
  if (!c.verify) return unknown(`Error: ${call.name} timed out; the outcome is unknown and it was not retried. Tell the user it may or may not have happened.`);
  const { vres, expect } = await verifyRead(call, res, c.verify, go);
  // expect === null: nothing checkable for this call, which cannot confirm it
  if (expect !== null && check(expect, vres).ok) {
    return { ok: true, text: 'The action timed out, but I checked and it went through: ' + vres.text, verified: true, ...(vres.untrusted && { untrusted: true }) };
  }
  return unknown('Error: it timed out and I could not confirm it happened. Do not say it was done.');
}

// a real success of a non-read tool with a verify contract: check it. A failed check keeps ok (the tool said it worked) but is
// flagged, and it never triggers a retry: the action may well have happened.
async function afterSuccess(call, res, c, go) {
  if (!res.ok || res.skipped || res.ledger || !c.verify || c.effect === 'read' || softFail(res.text) || String(res.text).startsWith(NEEDS_OK)) return res;
  const { vres, expect } = await verifyRead(call, res, c.verify, go);
  if (expect === null) return res;
  const v = check(expect, vres);
  if (v.ok) return { ...res, verified: true };
  return { ...res, verified: false, text: `${res.text} (I could not confirm it: ${v.why}.)` };
}

async function runBatch(batch, run, rec) {
  const go = call => attemptCall({ call, run, ...rec });
  if (batch.length === 1) {
    const j = batch[0];
    if (j.preset) return [j.preset];
    try { return [await go(j.call)]; } catch (e) { return [failure(e)]; }
  }
  // identical calls inside one batch run once: the model asked for the same read twice, one answer serves both
  const pending = new Map();
  return Promise.all(batch.map(j => {
    const k = sig(j.call);
    if (!pending.has(k)) pending.set(k, Promise.resolve().then(() => go(j.call)).catch(failure));
    return pending.get(k);
  }));
}

// -> results in job order. Taint from an untrusted result lands on `turn` (the object exec reads) after each batch and before the
// next one starts, so a confirm call that follows an untrusted read in the same round is refused instead of run.
async function runRound({ jobs, run, turn, signal, parallelSafeOf, parallel = true, contractOf, repair, sleep }) {
  const rec = { contractOf, repair, sleep, signal };
  const batches = parallel ? partition(jobs, parallelSafeOf) : jobs.map(j => [j]);
  const out = [];
  for (const batch of batches) {
    if (signal?.aborted) { for (const _ of batch) out.push({ ok: false, text: 'Error: aborted' }); continue; }
    const results = await runBatch(batch, run, rec);
    for (const res of results) if (res?.untrusted) turn.tainted = true;
    out.push(...results);
  }
  return out;
}

module.exports = { partition, runRound, attemptCall, PARALLEL_MAX };
