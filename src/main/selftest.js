// Dev-only self-test: drives the real app and writes report.json + screenshots.
// Off unless JARVIS_SELFTEST=<out dir>. JARVIS_SELFTEST_MODE picks the script.
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const wait = ms => new Promise(r => setTimeout(r, ms));

async function run(ctx, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const mode = process.env.JARVIS_SELFTEST_MODE || 'chat';
  const report = { mode, steps: [] };
  const step = (name, data) => report.steps.push({ name, ...data });
  const win = () => ctx.windows.chat;
  const js = code => win().webContents.executeJavaScript(code, true);
  const shot = async name => {
    const img = await win().webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG());
  };
  const dom = () => js(`({
    msgs: [...document.querySelectorAll('.msg')].map(e => e.className + ' | ' + e.textContent),
    chip: document.getElementById('chip').textContent,
    state: document.getElementById('state').textContent,
    list: [...document.querySelectorAll('#list li')].map(e => e.textContent),
    buttons: [...document.querySelectorAll('.note button')].map(b => b.textContent),
    micDisabled: document.getElementById('micBtn').disabled,
  })`);
  const type = async t => {
    await js(`(() => { const ta = document.getElementById('text'); ta.value = ${JSON.stringify(t)};
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  };
  const extra = ctx.selftestModes || {};

  try {
    await new Promise(r => (win().webContents.isLoading() ? win().webContents.once('did-finish-load', r) : r()));
    step('hotkeys', { failed: ctx.hotkeys.failed, registered: ctx.hotkeys.registered });
    step('bridge', { port: ctx.bridge?.port ?? null });
    if (mode === 'chat') {
      ctx.windows.showChat();
      await wait(600);
      await type('hi');
      await wait(2500);
      step('after hi', await dom());
      await shot('chat-hi');
      await type('/new');
      await wait(800);
      step('after /new', await dom());
      await shot('chat-new');
    } else if (mode === 'list') {
      ctx.windows.showChat();
      await wait(1000);
      step('list', await dom());
      await shot('chat-list');
    } else if (mode === 'orb') {
      ctx.windows.showChat();
      await wait(600);
      await type('hello orb');
      await wait(90);
      await shot('orb-streaming');
      await wait(2000);
      ctx.bus.emit('state', { state: 'error', detail: 'selftest' });
      await wait(60);
      await shot('orb-error');
      ctx.bus.emit('state', { state: 'idle' });
      step('orb', await dom());
    } else if (mode === 'hotkey') {
      const t0 = Date.now();
      while (!win().isVisible() && Date.now() - t0 < 15000) await wait(100);
      step('visible after hotkey', { visible: win().isVisible(), ms: Date.now() - t0 });
      if (win().isVisible()) await shot('chat-hotkey');
    } else if (extra[mode]) {
      await extra[mode]({ ctx, step, js, dom, type, shot, wait });
    } else {
      step('unknown mode', {});
    }
  } catch (err) {
    step('error', { message: err.message, stack: err.stack });
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  app.quit();
}

module.exports = { run };
