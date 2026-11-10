// Settings renderer. Every change is saved at once through window.jarvis.settings.
(() => {
  const $ = id => document.getElementById(id);
  const S = window.jarvis.settings;
  let state = null;
  let savedT = 0;

  function opt(sel, items, value) {
    sel.replaceChildren();
    for (const it of items) {
      const o = document.createElement('option');
      o.value = it.id;
      o.textContent = it.label + (it.ready === undefined ? '' : it.ready ? '' : ' — not ready');
      sel.appendChild(o);
    }
    sel.value = value;
  }

  function render(d) {
    state = d;
    const c = d.config;
    opt($('provider'), d.providers, c.provider);
    const p = d.providers.find(x => x.id === c.provider);
    $('providerDetail').textContent = p ? (p.ready ? 'Ready. ' : '') + (p.detail || '') : '';
    for (const k of ['stt', 'tts', 'wake']) opt($(k), d.engines[k], c.engines[k]);
    $('wakeEnabled').checked = !!c.wakeEnabled;
    $('rate').value = c.voiceRate;
    $('rateVal').textContent = Number(c.voiceRate).toFixed(2) + '×';
    $('hkChat').value = c.hotkeys.chat;
    $('hkVoice').value = c.hotkeys.voice;
    const failed = (d.hotkeyFailures || []).filter(a => a === c.hotkeys.chat || a === c.hotkeys.voice);
    $('hkWarn').hidden = !failed.length;
    $('hkWarn').textContent = failed.length ? `Taken by another app: ${failed.join(', ')}. Pick another.` : '';
    const errs = d.errors || [];
    $('errors').hidden = !errs.length;
    $('errors').textContent = errs.join(' · ');
    if ($('mic').dataset.loaded) $('mic').value = c.micDeviceId || '';
  }

  async function save(patch) {
    render(await S.set(patch));
    $('saved').textContent = 'SAVED';
    clearTimeout(savedT);
    savedT = setTimeout(() => { $('saved').textContent = ''; }, 1200);
  }

  async function loadMics() {
    const sel = $('mic');
    sel.replaceChildren();
    const def = document.createElement('option');
    def.value = ''; def.textContent = 'System default';
    sel.appendChild(def);
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
      devs.forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId; o.textContent = d.label || `Microphone ${i + 1}`;
        sel.appendChild(o);
      });
      $('micDetail').textContent = devs.length ? '' : 'No microphone found. Chat still works.';
      const want = state?.config.micDeviceId || '';
      if (want && !devs.some(d => d.deviceId === want)) $('micDetail').textContent = 'The saved microphone is not connected; using the default.';
    } catch (err) {
      $('micDetail').textContent = 'Cannot list microphones: ' + err.message;
    }
    sel.dataset.loaded = '1';
    sel.value = state?.config.micDeviceId || '';
    if (sel.value !== (state?.config.micDeviceId || '')) sel.value = '';
  }

  // ---- hotkey capture: Electron accelerator from a keydown ----
  const KEYMAP = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert' };
  function accel(e) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
    let key = KEYMAP[e.key] || (/^F\d{1,2}$/.test(e.key) ? e.key : null);
    if (!key && e.code.startsWith('Key')) key = e.code.slice(3);
    if (!key && e.code.startsWith('Digit')) key = e.code.slice(5);
    if (!key) return null;
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    if (!mods.length && !/^F\d/.test(key)) return null; // plain letters would steal typing
    return [...mods, key].join('+');
  }

  function capture(input, field) {
    input.addEventListener('click', async () => {
      if (input.classList.contains('capturing')) return;
      input.classList.add('capturing');
      const before = input.value;
      input.value = 'Press keys… (Esc cancels)';
      await S.capture(true);
      const done = async value => {
        document.removeEventListener('keydown', onKey, true);
        input.classList.remove('capturing');
        await S.capture(false);
        if (value && value !== before) await save({ hotkeys: { [field]: value } });
        else input.value = before;
      };
      const onKey = e => {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) { done(null); return; }
        const a = accel(e);
        if (a) done(a);
      };
      document.addEventListener('keydown', onKey, true);
    });
  }

  $('provider').addEventListener('change', e => save({ provider: e.target.value }));
  for (const k of ['stt', 'tts', 'wake']) $(k).addEventListener('change', e => save({ engines: { [k]: e.target.value } }));
  $('wakeEnabled').addEventListener('change', e => save({ wakeEnabled: e.target.checked }));
  $('mic').addEventListener('change', e => save({ micDeviceId: e.target.value || null }));
  $('rate').addEventListener('input', e => { $('rateVal').textContent = Number(e.target.value).toFixed(2) + '×'; });
  $('rate').addEventListener('change', e => save({ voiceRate: Number(e.target.value) }));
  capture($('hkChat'), 'chat');
  capture($('hkVoice'), 'voice');
  $('closeBtn').addEventListener('click', () => S.close());
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('.capturing')) S.close(); });
  navigator.mediaDevices?.addEventListener?.('devicechange', loadMics);

  S.get().then(d => { render(d); loadMics(); });
})();
