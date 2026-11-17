// jarvis's side of the engine process: starts worker.js as a child, keeps it alive, and gives jarvis the same small surface the
// in-process app had (start, stop, health, tools) plus request(op, args) to ask it for data.
//   const engine = createStockmanProcess({ bus, log, getConfig, dataDir });  await engine.start();  ...  await engine.stop();
// Supervision: a crash restarts the worker with growing delay; more than maxRestarts within the window, or exit code 2 (bad config or
// migration), stops trying and the state becomes 'failed' (jarvis keeps running; the status tool says why). Worker events are forwarded
// to jarvis's bus as { type: 'stockman', topic, ... }. Health is cached from the worker's pushes, so health() is synchronous.
// Testable: `fork` is injectable, so unit tests use a fake child and one test runs the real worker.
const path = require('node:path');
const { createBusLink, createMemoryLink } = require('./jarvis/link');
const { createStockmanTools } = require('./jarvis/tools');
const { StockmanError, TransientError } = require('./errors');
const { FATAL_EXIT } = require('./worker');

function createStockmanProcess({
  fork = (...a) => require('node:child_process').fork(...a),
  workerPath = path.join(__dirname, 'worker.js'),
  execPath = process.execPath, env = process.env,
  dataDir, getConfig = () => ({}), bus, link, log = () => {},
  startTimeoutMs = 15000, requestTimeoutMs = 20000, stopTimeoutMs = 5000,
  restart = {},
} = {}) {
  const policy = { maxRestarts: 5, baseMs: 1000, maxMs: 30000, resetAfterMs: 60000, ...restart };
  const out = link || (bus ? createBusLink({ bus }) : createMemoryLink());
  let state = 'stopped', child = null, lastHealth = null, lastExit = null, failReason = null;
  let restarts = 0, readyAt = 0, restartTimer = null, stopping = false, seq = 0, lastOnline = null, startPromise = null;
  const pending = new Map();

  const emptyStocks = { provider: 'unknown', breaker: { state: 'unknown' }, limiter: {}, calls: 0, failures: 0, lastOkAt: null, lastError: null };

  function rejectPending(why) {
    for (const [id, p] of pending) { clearTimeout(p.timer); pending.delete(id); p.reject(new TransientError(why)); }
  }
  const pipeLines = (stream, tag) => stream?.on('data', d => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) log(`stockman ${tag}: ${l}`); });

  function syncOnline() {
    if (!child || state !== 'running') return;
    let online; try { online = getConfig()?.online; } catch { return; }
    const j = JSON.stringify(online ?? null);
    if (j === lastOnline || !online) return;
    lastOnline = j;
    try { child.send({ type: 'online', online }); } catch { /* the exit handler will deal with a dead child */ }
  }

  // spawns one worker and resolves when it says ready; rejects if it dies, says fatal, or takes too long
  function spawn() {
    return new Promise((resolve, reject) => {
      let settled = false, fatal = null;
      const c = fork(workerPath, [], { execPath, execArgv: [], env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
      child = c;
      const settle = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      // exited: true because the kill below ends in an 'exit' event, and that handler does the restart accounting
      const timer = setTimeout(() => { settle(reject, Object.assign(new TransientError(`engine did not become ready within ${startTimeoutMs} ms`), { exited: true })); try { c.kill(); } catch { /* gone */ } }, startTimeoutMs);
      pipeLines(c.stdout, 'out'); pipeLines(c.stderr, 'err');
      c.on('message', msg => {
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'ready': lastHealth = msg.health; readyAt = Date.now(); state = 'running'; lastOnline = null; syncOnline(); settle(resolve); break;
          case 'fatal': fatal = String(msg.error || 'unknown'); break;
          case 'health': lastHealth = msg.health; break;
          case 'log': log(String(msg.line)); break;
          case 'event': try { out.publish(String(msg.topic), msg.payload || {}); } catch (err) { log(`stockman: dropped event ${msg.topic}: ${err.message}`); } break;
          case 'reply': { const p = pending.get(msg.id); if (!p) break; pending.delete(msg.id); clearTimeout(p.timer); if (msg.ok) p.resolve(msg.result); else p.reject(new StockmanError(msg.error?.message || 'engine error', { code: msg.error?.code || 'UNKNOWN', retryable: msg.error?.retryable === true })); break; }
          default: break;
        }
      });
      c.on('error', err => { log(`stockman engine process error: ${err.message}`); settle(reject, err); });
      c.on('exit', (code, signal) => {
        if (child === c) child = null;
        lastExit = { code, signal, at: Date.now(), fatal };
        rejectPending('engine process ended');
        settle(reject, Object.assign(new StockmanError(fatal ? `engine could not start: ${fatal}` : `engine exited before it was ready (code ${code}, signal ${signal})`, { code: fatal ? 'FATAL' : 'EXIT' }), { fatal: !!fatal || code === FATAL_EXIT, exited: true }));
        if (!stopping && state !== 'failed') onUnexpectedExit(code, signal, fatal, state === 'running');   // 'failed' = start() already gave up on this child
      });
      try { c.send({ type: 'init', dataDir, online: (() => { try { return getConfig()?.online; } catch { return undefined; } })() }); } catch (err) { settle(reject, err); }
    });
  }

  function giveUp(reason) {
    state = 'failed'; failReason = reason;
    log(`stockman engine stopped for good: ${reason}`);
    try { out.publish('engine-failed', { reason: reason.slice(0, 200) }); } catch { /* link */ }
  }

  function onUnexpectedExit(code, signal, fatal, wasUp) {
    if (state === 'starting') return;                       // start() reports it
    if (fatal || code === FATAL_EXIT) return giveUp(fatal ? `could not start: ${fatal}` : 'could not start (exit code 2)');
    if (wasUp && Date.now() - readyAt > policy.resetAfterMs) restarts = 0;
    restarts++;
    if (restarts > policy.maxRestarts) return giveUp(`crashed ${restarts - 1} times in a row (last: code ${code}, signal ${signal})`);
    state = 'restarting';
    const wait = Math.min(policy.maxMs, policy.baseMs * 2 ** (restarts - 1));
    log(`stockman engine ended (code ${code}, signal ${signal}); restart ${restarts} of ${policy.maxRestarts} in ${wait} ms`);
    try { out.publish('engine-down', { restart: restarts, inMs: wait }); } catch { /* link */ }
    restartTimer = setTimeout(async () => {
      restartTimer = null;
      if (stopping) return;
      try { await spawn(); log('stockman engine restarted'); try { out.publish('engine-up', { restarts }); } catch { /* link */ } } catch (err) {
        if (stopping) return;
        if (err.fatal) giveUp(err.message);
        else if (!err.exited) onUnexpectedExit(null, null, null, false);   // the process never started (spawn error): count it and try again; an exit is counted by its own handler
      }
    }, wait);
    restartTimer.unref?.();
  }

  const engine = {
    link: out,
    async start() {
      if (state === 'running') return engine;
      if (startPromise) return startPromise;
      stopping = false; state = 'starting'; failReason = null; restarts = 0;
      startPromise = spawn().then(() => engine, err => { state = 'failed'; failReason = err.message; if (child) { try { child.kill(); } catch { /* gone */ } } throw err; }).finally(() => { startPromise = null; });
      return startPromise;
    },

    async stop() {
      if (state === 'stopped') return;
      stopping = true; state = 'stopping';
      clearTimeout(restartTimer); restartTimer = null;
      const c = child;
      if (c) {
        await new Promise(resolve => {
          const t = setTimeout(() => { try { c.kill(); } catch { /* gone */ } resolve(); }, stopTimeoutMs);
          c.once('exit', () => { clearTimeout(t); resolve(); });
          try { c.send({ type: 'stop' }); } catch { try { c.kill(); } catch { /* gone */ } resolve(); }
        });
      }
      rejectPending('engine stopped');
      state = 'stopped'; child = null;
    },

    // synchronous: the last health the worker pushed, with the process state added
    health() {
      const base = lastHealth || { started: false, enabled: true, db: null, stocks: emptyStocks, features: [] };
      return { ...base, started: state === 'running' && base.started === true, link: out.name, process: { state, pid: child?.pid ?? null, restarts, lastExit, failReason } };
    },

    // ask the engine for data: op is health | quote | quotes | history | events (see worker.js)
    request(op, args = {}) {
      if (state !== 'running' || !child) return Promise.reject(new TransientError(`engine is ${state}${failReason ? `: ${failReason}` : ''}`));
      syncOnline();
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new TransientError(`engine did not answer ${op} within ${requestTimeoutMs} ms`)); }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { child.send({ type: 'request', id, op, args }); } catch (err) { pending.delete(id); clearTimeout(timer); reject(new TransientError(`could not reach the engine: ${err.message}`)); }
      });
    },

    tools: () => createStockmanTools({ stockman: engine }),
  };
  return engine;
}

module.exports = { createStockmanProcess };
