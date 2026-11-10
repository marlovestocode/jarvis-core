// Boot sequence: run startup stages, announce each real result as a 'boot' event
// (the chat and the wallpaper draw these; nothing is faked), then 'done'.
async function runBoot(bus, stages) {
  const t0 = Date.now();
  let okCount = 0;
  for (const s of stages) {
    const t = Date.now();
    let ok = true, detail = '';
    try {
      const r = await s.run();
      if (r && typeof r === 'object' && 'ok' in r) { ok = !!r.ok; detail = String(r.detail ?? ''); }
      else detail = r === undefined || r === null ? '' : String(r);
    } catch (err) {
      ok = false;
      detail = err?.message || String(err);
    }
    if (ok) okCount++;
    bus.emit('boot', { stage: s.stage, ok, detail, ms: Date.now() - t });
  }
  const ok = okCount === stages.length;
  bus.emit('boot', { stage: 'done', ok, detail: `${okCount} of ${stages.length} ready`, ms: Date.now() - t0 });
  return { ok, ms: Date.now() - t0 };
}

// Electron login item for "Start with Windows" (tray only: --hidden).
function loginItem({ enabled, execPath, appPath, packaged }) {
  return { openAtLogin: !!enabled, path: execPath, args: packaged ? ['--hidden'] : [appPath, '--hidden'] };
}

module.exports = { runBoot, loginItem };
