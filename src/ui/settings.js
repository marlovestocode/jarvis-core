// Settings renderer. Every change is saved at once through window.jarvis.settings.
(() => {
  const $ = id => document.getElementById(id);
  const S = window.jarvis.settings;
  let state = null;
  let savedT = 0;
  let places = [];

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
    const isOllama = c.provider === 'ollama';
    $('modelRow').hidden = !isOllama;
    $('autoRow').hidden = !isOllama;
    $('fastRow').hidden = !isOllama || !c.ollama.auto;
    $('thinkRow').hidden = !isOllama || !!c.ollama.auto;   // auto decides thinking per question
    if (isOllama) {
      const models = d.models || [];
      const withMissing = id => (models.some(m => m.id === id) ? models : [{ id, label: id + ' (not in Ollama)' }, ...models]);
      opt($('model'), withMissing(c.ollama.model), c.ollama.model);
      opt($('fastModel'), [{ id: '', label: 'Same as main model (GPU)' }, ...(c.ollama.fastModel ? withMissing(c.ollama.fastModel) : models)], c.ollama.fastModel || '');
      $('auto').checked = !!c.ollama.auto;
      $('think').checked = !!c.ollama.think;
      if (!models.length) $('providerDetail').textContent = 'No local models found. Start Ollama and pull a model.';
    }
    for (const k of ['stt', 'tts', 'wake']) opt($(k), d.engines[k], c.engines[k]);
    $('wakeEnabled').checked = !!c.wakeEnabled;
    $('speakerGate').checked = !!c.speakerGate;
    if (document.activeElement !== $('userName')) $('userName').value = c.user.name;
    if (document.activeElement !== $('userAbout')) $('userAbout').value = c.user.about;
    $('sttGpu').checked = !!c.sttGpu;
    $('logPlays').checked = !!c.music.logPlays;
    $('browserOn').checked = !!c.browser.enabled;
    $('proactiveOn').checked = !!c.proactive.enabled;
    $('dnd').checked = !!c.proactive.dnd;
    $('quietStart').value = c.proactive.quietStart;
    $('quietEnd').value = c.proactive.quietEnd;
    const mon = c.proactive.monitors || {};
    const mt = mon.timersSoon || {}, ms = mon.sysmon || {};
    $('monTimers').checked = !!mt.enabled;
    $('monSys').checked = !!ms.enabled;
    for (const [id, v] of [['monLead', mt.leadMin], ['monCpu', ms.cpu], ['monRam', ms.ram], ['monDisk', ms.disk], ['monTemp', ms.temp]]) if (document.activeElement !== $(id) && v != null) $(id).value = v;
    $('startAtLogin').checked = !!c.startAtLogin;
    if (c.memory) { $('memAuto').checked = !!c.memory.autoCapture; $('memChats').checked = !!c.memory.usePastChats; }
    if (d.dialects) { const sel = $('dialect'); if (sel.options.length !== d.dialects.length) { sel.textContent = ''; for (const x of d.dialects) { const o = document.createElement('option'); o.value = x.id; o.textContent = x.label; sel.append(o); } } sel.value = c.speech.dialect; }
    $('contractions').checked = c.speech.contractions !== false;
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
    for (const [key, id] of Object.entries({ enabled: 'onlineEnabled', weather: 'onlineWeather', news: 'onlineNews', sports: 'onlineSports', wiki: 'onlineWiki', web: 'onlineWeb' })) {
      $(id).checked = !!c.online[key];
      $(id).disabled = key !== 'enabled' && !c.online.enabled;
    }
    $('placeSearch').disabled = !c.online.enabled || !c.online.weather;
    $('units').value = c.location.units;
    $('locationDetail').textContent = `Home: ${c.location.city} (${c.location.lat.toFixed(4)}, ${c.location.lon.toFixed(4)})`;
    drawItems('feeds', c.news.feeds, x => x, i => save({ news: { feeds: c.news.feeds.filter((_, n) => n !== i) } }));
    drawItems('teams', c.sports.follow, x => `${x.league.toUpperCase()} · ${x.team}`, i => save({ sports: { follow: c.sports.follow.filter((_, n) => n !== i) } }));
    const lib = d.library;
    $('libraryDetail').textContent = lib ? `${lib.installed ? 'Wikipedia installed' : 'Not installed — online fallback when enabled'}\n${lib.path}\n${(lib.sizeBytes / 1e9).toFixed(2)} GB · ${lib.articles == null ? 'Article count unavailable' : lib.articles.toLocaleString() + ' articles'} · ${lib.running ? 'Kiwix running' : 'Kiwix stopped'}` : 'Library status unavailable';
  }

  function drawItems(id, items, label, remove) {
    $(id).replaceChildren();
    for (const [i, item] of items.entries()) {
      const li = document.createElement('li'), span = document.createElement('span'), button = document.createElement('button');
      span.textContent = label(item); button.textContent = 'REMOVE'; button.type = 'button';
      button.addEventListener('click', () => remove(i));
      li.append(span, button); $(id).appendChild(li);
    }
  }

  async function save(patch) {
    const body = document.querySelector('.body');
    body.inert = true;
    try {
      const d = await S.set(patch);
      render(d);
      $('saved').textContent = d.errors?.length ? 'NOT SAVED' : 'SAVED';
      clearTimeout(savedT);
      savedT = setTimeout(() => { $('saved').textContent = ''; }, 1200);
      return !d.errors?.length;
    } catch (err) {
      $('errors').hidden = false; $('errors').textContent = err.message;
      return false;
    } finally { body.inert = false; }
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
  $('model').addEventListener('change', e => save({ ollama: { model: e.target.value } }));
  $('think').addEventListener('change', e => save({ ollama: { think: e.target.checked } }));
  $('auto').addEventListener('change', e => save({ ollama: { auto: e.target.checked } }));
  $('fastModel').addEventListener('change', e => save({ ollama: { fastModel: e.target.value } }));
  $('startAtLogin').addEventListener('change', e => save({ startAtLogin: e.target.checked }));
  for (const k of ['stt', 'tts', 'wake']) $(k).addEventListener('change', e => save({ engines: { [k]: e.target.value } }));
  $('wakeEnabled').addEventListener('change', e => save({ wakeEnabled: e.target.checked }));
  $('userName').addEventListener('change', e => save({ user: { name: e.target.value } }));
  $('userAbout').addEventListener('change', e => save({ user: { about: e.target.value } }));
  $('speakerGate').addEventListener('change', e => save({ speakerGate: e.target.checked }));
  $('logPlays').addEventListener('change', e => save({ music: { logPlays: e.target.checked } }));
  $('browserOn').addEventListener('change', e => save({ browser: { enabled: e.target.checked } }));
  $('sttGpu').addEventListener('change', e => save({ sttGpu: e.target.checked }));
  $('memAuto').addEventListener('change', e => save({ memory: { autoCapture: e.target.checked } }));
  $('memChats').addEventListener('change', e => save({ memory: { usePastChats: e.target.checked } }));
  $('proactiveOn').addEventListener('change', e => save({ proactive: { enabled: e.target.checked } }));
  $('dnd').addEventListener('change', e => save({ proactive: { dnd: e.target.checked } }));
  $('quietStart').addEventListener('change', e => save({ proactive: { quietStart: e.target.value } }));
  $('quietEnd').addEventListener('change', e => save({ proactive: { quietEnd: e.target.value } }));
  $('monTimers').addEventListener('change', e => save({ proactive: { monitors: { timersSoon: { enabled: e.target.checked } } } }));
  $('monLead').addEventListener('change', async e => { if (e.target.value === '') { e.target.blur(); render(await S.get()); return; } save({ proactive: { monitors: { timersSoon: { leadMin: Number(e.target.value) } } } }); });
  $('monSys').addEventListener('change', e => save({ proactive: { monitors: { sysmon: { enabled: e.target.checked } } } }));
  for (const [id, f] of [['monCpu', 'cpu'], ['monRam', 'ram'], ['monDisk', 'disk'], ['monTemp', 'temp']]) $(id).addEventListener('change', async e => { if (e.target.value === '') { e.target.blur(); render(await S.get()); return; } save({ proactive: { monitors: { sysmon: { [f]: Number(e.target.value) } } } }); });
  function showVoice(v, msg) {
    $('voiceState').textContent = v.available ? (v.enrolled ? 'Your voice: enrolled' : 'Your voice: not enrolled') : 'Your voice: model missing';
    $('voiceEnroll').textContent = v.enrolled ? 'Re-enroll' : 'Enroll';
    $('voiceEnroll').disabled = !v.available || v.enrolling;
    $('voiceClear').hidden = !v.enrolled;
    $('voiceDetail').textContent = msg || (v.enrolled ? 'Only your voice can wake JARVIS by name. The hotkey always works.' : 'Enroll once so JARVIS knows your voice.');
  }
  $('voiceEnroll').addEventListener('click', async () => {
    $('voiceEnroll').disabled = true;
    $('voiceDetail').textContent = 'Listening for 12 seconds. Keep talking in your normal voice: read something aloud, or just chat.';
    try { const r = await S.speakerEnroll(); showVoice(r, r.ok ? `Done: ${r.count} voice samples saved.` : r.reason); }
    catch (err) { $('voiceDetail').textContent = err.message; $('voiceEnroll').disabled = false; }
  });
  $('voiceClear').addEventListener('click', async () => showVoice(await S.speakerClear(), 'Voice print removed.'));
  $('mic').addEventListener('change', e => save({ micDeviceId: e.target.value || null }));
  $('rate').addEventListener('input', e => { $('rateVal').textContent = Number(e.target.value).toFixed(2) + '×'; });
  $('dialect').addEventListener('change', e => save({ speech: { dialect: e.target.value } }));
  $('contractions').addEventListener('change', e => save({ speech: { contractions: e.target.checked } }));
  $('rate').addEventListener('change', e => save({ voiceRate: Number(e.target.value) }));
  for (const [key, id] of Object.entries({ enabled: 'onlineEnabled', weather: 'onlineWeather', news: 'onlineNews', sports: 'onlineSports', wiki: 'onlineWiki', web: 'onlineWeb' })) $(id).addEventListener('change', e => save({ online: { [key]: e.target.checked } }));
  $('units').addEventListener('change', e => save({ location: { units: e.target.value } }));
  $('placeForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('placeSearch').disabled = true;
    try {
      const r = await S.places($('placeQuery').value.trim());
      places = r.places || [];
      $('placeRow').hidden = !places.length;
      opt($('placePick'), [{ id: '', label: 'Choose a city…' }, ...places.map((p, i) => ({ id: String(i), label: `${p.name} (${p.country})` }))], '');
      $('placeDetail').textContent = r.error || (places.length ? 'Select the matching city to save it.' : 'No matching city. Try a nearby city or region.');
    } catch (err) { $('placeDetail').textContent = err.message; }
    finally { $('placeSearch').disabled = !state.config.online.enabled || !state.config.online.weather; }
  });
  $('placePick').addEventListener('change', async e => {
    if (e.target.value === '') return;
    const p = places[Number(e.target.value)];
    if (await save({ location: { city: p.name, lat: p.lat, lon: p.lon, country: p.country } })) { $('placeRow').hidden = true; $('placeDetail').textContent = 'Home location saved.'; }
  });
  $('feedForm').addEventListener('submit', async e => { e.preventDefault(); if (await save({ news: { feeds: [...state.config.news.feeds, $('feedUrl').value.trim()] } })) $('feedUrl').value = ''; });
  $('teamForm').addEventListener('submit', async e => { e.preventDefault(); if (await save({ sports: { follow: [...state.config.sports.follow, { league: $('teamLeague').value, team: $('teamName').value.trim() }] } })) $('teamName').value = ''; });
  $('libraryRefresh').addEventListener('click', async () => { try { render(await S.get()); } catch (err) { $('libraryDetail').textContent = err.message; } });
  capture($('hkChat'), 'chat');
  capture($('hkVoice'), 'voice');
  $('closeBtn').addEventListener('click', () => S.close());
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('.capturing')) S.close(); });
  navigator.mediaDevices?.addEventListener?.('devicechange', loadMics);

  S.get().then(d => { render(d); loadMics(); });
  S.speakerStatus().then(v => showVoice(v)).catch(() => {});
})();

// Settings → Memory (cortex wave 1): review queue, saved facts, connections, chat summaries, embedding model.
// Everything goes through window.jarvis.settings.memory; the main process validates every payload.
(() => {
  const $ = id => document.getElementById(id);
  const M = window.jarvis.settings.memory;
  if (!M) { $('memory').hidden = true; return; }
  const say = t => { $('memDetail').textContent = t || ''; };
  const TIER = { profile: 'always known', note: 'when relevant' };
  let pendingIds = [];

  function button(label, fn) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }
  function row(text, origin, buttons) {
    const li = document.createElement('li'), span = document.createElement('span');
    span.textContent = text;
    if (origin) { const o = document.createElement('small'); o.className = 'origin'; o.textContent = origin; span.appendChild(o); }
    li.append(span, ...buttons);
    return li;
  }
  // inline edit: the text becomes an input; Enter saves, Esc cancels
  function editInline(li, text, onSave) {
    const input = document.createElement('input');
    input.className = 'inline'; input.value = text; input.maxLength = 200;
    li.replaceChildren(input);
    input.focus();
    input.addEventListener('keydown', async e => {
      e.stopPropagation();
      if (e.key === 'Escape') refresh();
      if (e.key === 'Enter') { e.preventDefault(); await onSave(input.value.trim()); }
    });
  }
  const check = r => { if (r && r.ok === false) say(r.error || r.reason || 'Not saved.'); return r; };

  async function refresh() {
    const [pend, act, sums] = await Promise.all([
      M.list({ status: 'pending' }),
      M.list({ status: 'active', ...($('memQuery').value.trim() && { query: $('memQuery').value.trim() }), ...($('memTier').value && { tier: $('memTier').value }) }),
      M.summaries(),
    ]);
    pendingIds = (pend.items || []).map(i => i.id);
    $('pendingCount').textContent = pendingIds.length ? String(pendingIds.length) : '';
    $('pendingAll').hidden = pendingIds.length < 2;
    $('memPending').replaceChildren(...(pend.items || []).map(i => {
      const li = row(i.text, `${TIER[i.tier] || i.tier} · ${i.origin}`, []);
      li.append(
        button('APPROVE', async () => { check(await M.approve([i.id])); refresh(); }),
        button('EDIT', () => editInline(li, i.text, async t => { check(await M.approve([i.id], t)); refresh(); })),
        button('REJECT', async () => { check(await M.reject([i.id])); refresh(); }));
      return li;
    }));
    if (!pendingIds.length) $('memPending').replaceChildren(row('Nothing to review.', '', []));
    const st = act.stats || pend.stats;
    $('activeCount').textContent = st ? `${st.active} / ${st.cap}` : '';
    $('memActive').replaceChildren(...(act.items || []).map(i => {
      const li = row(i.text, `${TIER[i.tier] || i.tier} · ${i.origin}`, []);
      li.append(
        button('EDIT', () => editInline(li, i.text, async t => { check(await M.edit({ id: i.id, text: t })); refresh(); })),
        button(i.tier === 'profile' ? 'WHEN RELEVANT' : 'ALWAYS', async () => { check(await M.edit({ id: i.id, tier: i.tier === 'profile' ? 'note' : 'profile' })); refresh(); }),
        button('LINKS', () => links(i.id)),
        button('DELETE', async () => { check(await M.remove(i.id)); refresh(); }));
      return li;
    }));
    const sumItems = sums.items || [];
    $('memSummaries').replaceChildren(...sumItems.map(i => row(i.text, `${i.title || 'chat'}${i.exists ? '' : ' · chat deleted'}`,
      [button('DELETE', async () => { check(await M.deleteSummary({ sessionId: i.sessionId })); refresh(); })])));
    if (!sumItems.length) $('memSummaries').replaceChildren(row('No chat summaries yet.', '', []));
  }

  async function links(id) {
    const r = await M.neighbors(id);
    if (!r.ok) { $('memConnections').textContent = r.error; return; }
    $('memConnections').textContent = r.neighbors.length
      ? `${r.node.text}\n` + r.neighbors.map(n => `  ${n.type} → ${n.kind}: ${n.text}${n.status === 'active' ? '' : ' (' + n.status + ')'}`).join('\n')
      : `${r.node.text}\n  nothing linked yet`;
  }

  async function embedder() {
    const e = await M.embedder();
    $('embedState').textContent = `Embedding model: ${e.model || 'nomic-embed-text'}`;
    $('embedInstall').hidden = !!e.installed || !!e.pulling;
    $('embedDetail').textContent = e.pulling ? 'Downloading…'
      : e.installed ? `Installed. Recall uses meaning, not only words${e.queue ? ` (${e.queue} waiting to be indexed)` : ''}.`
        : 'Not installed: recall matches words only. Install downloads it into your local Ollama.';
  }

  $('approveAll').addEventListener('click', async () => { check(await M.approve(pendingIds)); refresh(); });
  $('rejectAll').addEventListener('click', async () => { check(await M.reject(pendingIds)); refresh(); });
  $('memSearchForm').addEventListener('submit', e => { e.preventDefault(); refresh(); });
  $('memQuery').addEventListener('change', () => refresh());
  $('memTier').addEventListener('change', () => refresh());
  $('embedInstall').addEventListener('click', async () => {
    $('embedInstall').disabled = true;
    try { const r = await M.installEmbedder(); say(r.declined ? 'Not downloaded.' : r.ok ? 'Embedding model installed.' : r.error); }
    finally { $('embedInstall').disabled = false; embedder(); }
  });
  $('memExport').addEventListener('click', async () => { const r = await M.exportFile(); say(r.ok ? `Saved ${r.count} items to ${r.path}` : r.cancelled ? '' : r.error); });
  $('memImport').addEventListener('click', async () => { const r = await M.importFile(); say(r.ok ? `${r.proposed} facts added to review (${r.skipped} skipped).` : r.cancelled ? '' : r.error); refresh(); });
  $('sumDeleteAll').addEventListener('click', async () => {
    if (!window.confirm('Delete every chat summary? The chats themselves stay.')) return;
    check(await M.deleteSummary({ all: true })); refresh();
  });
  $('memWipe').addEventListener('click', async () => {
    if (!window.confirm('Forget everything JARVIS knows about you: every fact, name and chat summary? This cannot be undone.')) return;
    const r = await M.wipe('FORGET');
    say(r.ok ? 'Memory cleared.' : r.error);
    refresh();
  });
  refresh().catch(err => say(err.message));
  embedder().catch(() => {});
})();
