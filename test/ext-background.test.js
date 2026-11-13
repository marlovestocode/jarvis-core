// The extension's background worker (extension/background.js) run for real in Node against a fake `chrome` and WebSocket.
// Each scenario runs in its own process (test/helpers/ext-bg-scenarios.js): the worker keeps module state and timers.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');

const run = name => new Promise(resolve => {
  execFile(process.execPath, [path.join(__dirname, 'helpers/ext-bg-scenarios.js'), name], { timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: String(stderr || stdout).slice(0, 1500) }));
});

for (const [name, title] of [
  ['ports', 'all three ports are tried together; only the one that proves the link key is kept'],
  ['wrongProof', 'a server that cannot prove the key is refused and nothing it says is accepted'],
  ['commands', 'a command from JARVIS runs, is answered, and is written to the activity list with its timing and a badge flash'],
  ['prompts', 'prompts the music tab confirmed or left alone are listed and reported to JARVIS; other pages cannot report'],
  ['pendingPlays', 'twelve plays heard at once while JARVIS is away are all kept (no lost read-modify-write)'],
  ['silence', 'a link that goes silent for a minute is dropped and reported'],
]) {
  test('extension worker: ' + title, async () => {
    const r = await run(name);
    assert.equal(r.code, 0, r.out);
  });
}
