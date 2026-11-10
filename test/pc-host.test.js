const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPcHost } = require('../src/core/pc/host');

function fakeRequest(answers = {}) {
  const sent = [];
  const request = async (cmd, args = {}) => {
    sent.push({ cmd, args });
    const a = answers[cmd];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(args) : a;
  };
  return { request, sent };
}

test('pc host: every call is a command name plus typed args', async () => {
  const { request, sent } = fakeRequest({
    startApps: [{ name: 'Spotify', appId: 'SpotifyAB.Spotify_zpdnekdrzrea0!Spotify' }, { name: 'Bad' }],
    windows: [{ hwnd: 10, pid: 4, app: 'chrome', title: 'YouTube' }, { hwnd: 'x' }],
    launch: {}, alive: [4], closeMain: true, kill: true, focus: true, recycle: { gone: true, inBin: true }, lock: true, power: true,
  });
  const h = createPcHost({ request });
  assert.deepEqual(await h.startApps(), [{ name: 'Spotify', appId: 'SpotifyAB.Spotify_zpdnekdrzrea0!Spotify' }]);
  assert.deepEqual(await h.windows(), [{ hwnd: 10, pid: 4, app: 'chrome', title: 'YouTube' }]);
  await h.launch('C:\\Users\\me\\Documents\\a.pdf');
  assert.deepEqual(await h.alive([4, 5]), [4]);
  assert.equal(await h.closeMain(4), true);
  assert.equal(await h.kill(4), true);
  assert.equal(await h.focus(10), true);
  assert.deepEqual(await h.recycle('C:\\Users\\me\\Downloads\\x.txt'), { gone: true, inBin: true });
  assert.equal(await h.lock(), true);
  assert.equal(await h.power('sleep'), true);
  assert.deepEqual(sent.map(s => s.cmd), ['startApps', 'windows', 'launch', 'alive', 'closeMain', 'kill', 'focus', 'recycle', 'lock', 'power']);
  assert.deepEqual(sent[2].args, { target: 'C:\\Users\\me\\Documents\\a.pdf' });
  assert.deepEqual(sent[3].args, { pids: [4, 5] });
  assert.deepEqual(sent[9].args, { mode: 'sleep' });
});

test('pc host: bad arguments are refused before anything is sent', async () => {
  const { request, sent } = fakeRequest({});
  const h = createPcHost({ request });
  await assert.rejects(h.launch(''), /target/);
  await assert.rejects(h.launch(42), /target/);
  await assert.rejects(h.launch('a\nb'), /target/);
  await assert.rejects(h.closeMain('4; Stop-Computer'), /pid/);
  await assert.rejects(h.kill(-1), /pid/);
  await assert.rejects(h.focus(1.5), /hwnd/);
  await assert.rejects(h.alive(['1']), /pid/);
  await assert.rejects(h.recycle('relative\\x.txt'), /absolute/);
  await assert.rejects(h.power('format'), /mode/);
  assert.equal(sent.length, 0);
});

test('pc host script: no string-built commands, no registry, no permanent delete', () => {
  const ps = fs.readFileSync(path.join(__dirname, '../src/core/pc/pc-host.ps1'), 'utf8');
  for (const bad of [/Invoke-Expression/i, /\biex\b/i, /-Command\b/i, /Remove-Item/i, /\bdel\b/i, /Set-ItemProperty/i, /New-ItemProperty/i, /HKLM:|HKCU:|Registry::/i, /Format-Volume/i, /\[IO\.File\]::Delete/i, /DeletePermanently|DeleteDirectory\([^)]*DeletePermanently/i]) {
    assert.doesNotMatch(ps, bad, String(bad));
  }
  assert.match(ps, /SendToRecycleBin/);
  for (const cmd of ['startApps', 'launch', 'windows', 'alive', 'closeMain', 'kill', 'focus', 'recycle', 'lock', 'power']) assert.match(ps, new RegExp(`'${cmd}'`), cmd);
});

test('pc host: PowerShell unwraps one-item lists; the client turns them back into lists', async () => {
  const { request } = fakeRequest({ alive: 4, windows: { hwnd: 10, pid: 4, app: 'chrome', title: 'YouTube' }, startApps: { name: 'Spotify', appId: 'S!App' } });
  const h = createPcHost({ request });
  assert.deepEqual(await h.alive([4]), [4]);
  assert.equal((await h.windows()).length, 1);
  assert.equal((await h.startApps()).length, 1);
});
