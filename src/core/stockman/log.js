// StockMan logging. One shape everywhere: log.<level>(message, fields?). Fields are redacted (secrets.js) before they go anywhere.
//   Logger port: { debug, info, warn, error, child(name) }
// Sinks (where lines go) are plain functions, so jarvis's own log function plugs in: fromJarvisLog(ctx.log).
// An optional event sink copies lines at or above eventLevel into the engine_event table (db/events.js), the append-only
// record of what the framework did; a failing sink must never break the call that logged.
const { redact } = require('./secrets');

const RANK = { debug: 10, info: 20, warn: 30, error: 40 };

// consoleSink writes to stderr so stdout stays clean for CLI output
function consoleSink(line) { try { process.stderr.write(line + '\n'); } catch { /* closed */ } }

// jarvis's ctx.log takes (...args) and writes one line itself (src/main/main.js)
function fromJarvisLog(logFn) { return line => { try { logFn(line); } catch { /* a logger must not stop the caller */ } }; }

function format({ level, name, message, fields, at }) {
  const extra = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
  return `${new Date(at).toISOString()} ${level.toUpperCase().padEnd(5)} stockman.${name} ${message}${extra}`;
}

function createLogger({ level = 'info', sink = consoleSink, eventSink = null, eventLevel = 'warn', secrets = () => [], now = Date.now, name = 'core' } = {}) {
  const min = RANK[level] ?? RANK.info;
  const eventMin = RANK[eventLevel] ?? RANK.warn;
  function make(n) {
    const emit = lvl => (message, fields) => {
      const rank = RANK[lvl];
      if (rank < min && rank < eventMin) return;
      const clean = fields === undefined ? undefined : redact(fields, secrets());
      const text = redact(String(message), secrets());
      const at = now();
      if (rank >= min) { try { sink(format({ level: lvl, name: n, message: text, fields: clean, at })); } catch { /* sink failure */ } }
      if (eventSink && rank >= eventMin) { try { eventSink({ at, level: lvl, source: n, message: text, data: clean }); } catch { /* sink failure */ } }
    };
    return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error'), child: sub => make(`${n}.${sub}`) };
  }
  return make(name);
}

// a logger that records nothing, for tests and for code run without one
const silentLogger = (() => { const f = () => {}; const l = { debug: f, info: f, warn: f, error: f, child: () => l }; return l; })();

module.exports = { createLogger, consoleSink, fromJarvisLog, silentLogger, RANK };
