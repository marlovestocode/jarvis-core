// Settings panel logic: validate a patch from the UI and describe what can be chosen.
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function applyPatch(current, patch = {}, { providers, engines }) {
  const config = { ...current, engines: { ...current.engines }, hotkeys: { ...current.hotkeys }, ollama: { ...current.ollama } };
  const errors = [];
  if (!isObj(patch)) return { config, errors: ['bad patch'] };

  if ('provider' in patch) {
    if (typeof patch.provider === 'string' && providers.get(patch.provider)) config.provider = patch.provider;
    else errors.push(`Unknown provider "${patch.provider}"`);
  }
  if (isObj(patch.ollama)) {
    const next = { ...config.ollama };
    if ('model' in patch.ollama) {
      if (typeof patch.ollama.model === 'string' && patch.ollama.model.trim()) next.model = patch.ollama.model.trim();
      else errors.push('Empty Ollama model');
    }
    if ('host' in patch.ollama) {
      const h = typeof patch.ollama.host === 'string' ? patch.ollama.host.trim().replace(/\/+$/, '') : '';
      if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h)) next.host = h;
      else errors.push('Ollama host must be local (http://127.0.0.1:11434)');
    }
    if ('think' in patch.ollama) next.think = !!patch.ollama.think;
    config.ollama = next;
  }
  if (isObj(patch.engines)) {
    for (const kind of ['stt', 'tts', 'wake']) {
      if (!(kind in patch.engines)) continue;
      const id = patch.engines[kind];
      if (typeof id === 'string' && engines[kind].get(id)) config.engines[kind] = id;
      else errors.push(`Unknown ${kind} engine "${id}"`);
    }
  }
  if ('wakeEnabled' in patch) config.wakeEnabled = !!patch.wakeEnabled;
  if ('micDeviceId' in patch) {
    if (patch.micDeviceId === null || typeof patch.micDeviceId === 'string') config.micDeviceId = patch.micDeviceId || null;
    else errors.push('Bad mic device');
  }
  if ('voiceRate' in patch) {
    const r = Number(patch.voiceRate);
    if (Number.isFinite(r)) config.voiceRate = Math.round(Math.max(0.5, Math.min(2, r)) * 100) / 100;
    else errors.push('Bad voice rate');
  }
  if (isObj(patch.hotkeys)) {
    const next = { ...config.hotkeys };
    for (const k of ['chat', 'voice']) {
      if (!(k in patch.hotkeys)) continue;
      const v = patch.hotkeys[k];
      if (typeof v === 'string' && v.trim()) next[k] = v.trim();
      else errors.push(`Empty ${k} hotkey`);
    }
    if (next.chat === next.voice) errors.push('Chat and voice hotkeys must differ');
    else config.hotkeys = next;
  }
  return { config, errors };
}

async function statusSafe(item, timeoutMs) {
  let timer;
  try {
    const st = await Promise.race([
      Promise.resolve().then(() => item.status()),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('No answer')), timeoutMs); }),
    ]);
    return { ready: !!st?.ready, detail: String(st?.detail ?? '') };
  } catch (err) {
    return { ready: false, detail: err?.message || 'status failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function describe({ config, providers, engines, hotkeyFailures = [], statusTimeoutMs = 4000 }) {
  const list = async reg => Promise.all(reg.list().map(async ({ id, label }) => ({ id, label, ...(await statusSafe(reg.get(id), statusTimeoutMs)) })));
  const [p, stt, tts, wake] = await Promise.all([list(providers), list(engines.stt), list(engines.tts), list(engines.wake)]);
  let models = [];
  const ollama = providers.get('ollama');
  if (ollama?.listModels) {
    let timer;
    try { models = await Promise.race([
      ollama.listModels(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('No answer')), statusTimeoutMs); }),
    ]); } catch { models = []; } finally { clearTimeout(timer); }
  }
  return { config, providers: p, engines: { stt, tts, wake }, models, hotkeyFailures: [...hotkeyFailures] };
}

module.exports = { applyPatch, describe };
