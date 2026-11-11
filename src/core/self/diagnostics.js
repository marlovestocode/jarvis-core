// Self-check: run a list of checks and say what each one really found (nothing is assumed or cached).
// A check has the shape of a boot stage (boot.js): { id, run() → string | { ok, detail } | { off: true, detail }, timeoutMs? }.
// A throw or no answer in time is a failure. Result: { id, state, detail, ms } with state
//   'ok'   working
//   'off'  not in use (switched off, not installed, optional part not running): not a fault
//   'fail' should work and does not
const fs = require('node:fs');

async function runChecks(checks, { timeoutMs = 4000 } = {}) {
  return Promise.all(checks.map(async c => {
    const t = Date.now();
    let timer, state = 'ok', detail = '';
    try {
      const r = await Promise.race([
        Promise.resolve().then(() => c.run()),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('no answer')), c.timeoutMs || timeoutMs); }),
      ]);
      if (r && typeof r === 'object') {
        state = r.off ? 'off' : r.ok === false ? 'fail' : 'ok';
        detail = String(r.detail ?? '');
      } else detail = r === undefined || r === null ? '' : String(r);
    } catch (err) {
      state = 'fail';
      detail = err?.message || String(err);
    } finally {
      clearTimeout(timer);
    }
    return { id: c.id, state, detail, ms: Date.now() - t };
  }));
}

// Problems first: that is what the reader needs.
function report(results) {
  const of = state => results.filter(r => r.state === state);
  const list = rs => rs.map(r => `${r.id}: ${r.detail || r.state}`).join('; ');
  const fail = of('fail'), off = of('off'), ok = of('ok');
  const L = [`Self-check: ${ok.length} ok, ${fail.length} with a problem, ${off.length} off (${results.length} checks).`];
  if (fail.length) L.push(`PROBLEMS: ${list(fail)}.`);
  if (off.length) L.push(`Off or not set up (not faults): ${list(off)}.`);
  if (ok.length) L.push(`Working: ${list(ok)}.`);
  return L.join('\n');
}

// ---- the app log (<data>/jarvis.log, written by ctx.log in main.js): "<ISO time>  <text>" per line ----
const LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(.*)$/;
// A line that reports a fault. The log is free text, so this is a word match, not a level:
// boot stages that did not start say "OFF", bus warnings are prefixed "warn:" (main.js).
const FAULT = /\b(?:errors?|fail(?:ed|ure)?|warn(?:ing)?|timed out|unavailable|not registered|crash(?:ed)?|unhandled|rejected|bridge off)\b/i;
const isFault = text => FAULT.test(text) || /\bOFF\b/.test(text);

// The newest lines of the log, oldest first: [{ at (ms, 0 when the line has no time), text }]. Reads at most maxBytes from the end.
function readLog(file, { maxBytes = 256 * 1024 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
    if (len < size) lines.shift();   // the first line is cut off
    return lines.map(line => {
      const m = LINE.exec(line);
      return m ? { at: Date.parse(m[1]) || 0, text: m[2] } : { at: 0, text: line };
    });
  } catch {
    return [];   // no log yet
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

module.exports = { runChecks, report, readLog, isFault };
