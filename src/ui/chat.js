// Chat renderer. Talks to main only through window.jarvis (preload).
(() => {
  const $ = id => document.getElementById(id);
  const log = $('log'), list = $('list'), search = $('search'), text = $('text');
  const sendBtn = $('sendBtn'), stopBtn = $('stopBtn'), micBtn = $('micBtn'), chip = $('chip'), stateEl = $('state');
  const wave = $('wave').getContext('2d');
  window.MiniOrbInstance = window.MiniOrb ? window.MiniOrb.create($('orb')) : null;

  let session = null;
  let chats = [];
  let state = 'idle';
  let providerReady = null;
  let live = null;        // { el, text } of the reply being streamed
  let renderQueued = false;
  let micReason = '';
  let routeLabel = '';
  let lookupEvents = [];
  let liveTools = [];     // names of the tools called so far this turn
  const statEl = $('stat');
  const levels = new Array(22).fill(0);

  const md = s => Markdown.toDom(Markdown.parse(s), document, { onCopy: c => window.jarvis.copy(c) });

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }

  // ---------- rail ----------
  async function refreshList() {
    chats = await window.jarvis.list();
    drawList();
  }
  function drawList() {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    const shown = chats.filter(c => !q || c.title.toLowerCase().includes(q));
    if (!shown.length) list.appendChild(el('li', 'empty', q ? 'No match' : 'No chats yet'));
    for (const c of shown) {
      const li = el('li', session && c.id === session.id ? 'active' : '', c.title);
      li.title = c.title;
      li.addEventListener('click', async () => { session = await window.jarvis.openChat(c.id); drawLog(); drawList(); text.focus(); });
      list.appendChild(li);
    }
  }
  search.addEventListener('input', drawList);

  // ---------- log ----------
  function lastAssistantIndex(msgs) {
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant') return i;
    return -1;
  }

  function lookupNote(items) {
    const names = { 'api.open-meteo.com': 'Open-Meteo', 'air-quality-api.open-meteo.com': 'Open-Meteo AQI', 'geocoding-api.open-meteo.com': 'Open-Meteo location', 'api.weather.gov': 'National Weather Service', 'en.wikipedia.org': 'Wikipedia', 'site.api.espn.com': 'ESPN' };
    const labels = items.map(x => {
      if (x.offline) return 'Wikipedia (offline)';
      const name = names[x.host] || x.host;
      const age = Math.max(0, (x.ageMs || 0) + Date.now() - (x.at || x.t || Date.now()));
      if (x.stale) return `${name} — last known ${new Date(Date.now() - age).toLocaleString()}`;
      return `${name} ${age < 60000 ? 'just now' : Math.floor(age / 60000) < 60 ? Math.floor(age / 60000) + ' min ago' : Math.floor(age / 3600000) + ' h ago'}`;
    });
    return el('div', 'lookup-note', 'Looked up: ' + [...new Set(labels)].join(' · '));
  }

  function drawLog() {
    log.replaceChildren();
    const msgs = session?.messages || [];
    if (!msgs.length && !live) log.appendChild(el('div', 'empty-log', 'READY. TYPE OR PRESS THE MIC.'));
    const lastA = lastAssistantIndex(msgs);
    msgs.forEach((m, i) => {
      if (m.role === 'user') { log.appendChild(el('div', 'msg user', m.content)); return; }
      if (m.role === 'tool') { log.appendChild(el('div', 'msg tool', `⚙ ${m.label || m.name}: ${String(m.content).slice(0, 120)}`)); return; }
      if (m.role !== 'assistant') return;
      if (m.skill) log.appendChild(el('div', 'msg tool', `⚙ ${m.skill}`));   // a skill answered without the model
      if (!m.content && m.toolCalls && !m.error) return;
      const box = el('div', 'msg assistant');
      box.appendChild(md(m.content || ''));
      if (m.lookups?.length) box.appendChild(lookupNote(m.lookups));
      if (m.stopped) box.appendChild(el('div', 'note', 'Stopped.'));
      if (m.error) {
        const n = el('div', 'note err', m.error);
        if (i === lastA) {
          const b = el('button', '', 'RETRY');
          b.addEventListener('click', retry);
          n.appendChild(b);
        }
        box.appendChild(n);
      } else if (i === lastA && providerReady === false) {
        const n = el('div', 'note');
        const b = el('button', '', 'OPEN SETTINGS');
        b.addEventListener('click', () => window.jarvis.openSettings());
        n.appendChild(b);
        box.appendChild(n);
      }
      log.appendChild(box);
    });
    if (live) {
      for (const name of liveTools) log.appendChild(el('div', 'msg tool', `⚙ ${name}`));   // tools called so far this turn, above the reply
      live.el = el('div', 'msg assistant live');
      live.el.appendChild(md(live.text));
      if (lookupEvents.length) live.el.appendChild(lookupNote(lookupEvents));
      log.appendChild(live.el);
    }
    log.scrollTop = log.scrollHeight;
  }

  function drawLive() {
    renderQueued = false;
    if (!live) return;
    if (!live.el || !live.el.isConnected) { drawLog(); return; }
    live.el.replaceChildren(md(live.text));
    if (lookupEvents.length) live.el.appendChild(lookupNote(lookupEvents));
    log.scrollTop = log.scrollHeight;
  }

  async function reload() {
    session = await window.jarvis.current();
    drawLog();
    refreshList();
  }

  // ---------- sending ----------
  function setBusy(b) {
    stopBtn.hidden = !b;
    sendBtn.hidden = b;
  }

  async function submit() {
    const raw = text.value;
    const t = raw.trim();
    if (!t) return;
    if (t.startsWith('/')) {
      const cmd = t.split(/\s+/)[0].toLowerCase();
      const cmds = {
        '/new': async () => { session = await window.jarvis.newChat(); live = null; drawLog(); refreshList(); },
        '/clear': async () => { session = await window.jarvis.clear(); drawLog(); refreshList(); },
        '/voice': () => window.jarvis.voice(),
        '/settings': () => window.jarvis.openSettings(),
      };
      if (cmds[cmd]) { text.value = ''; autosize(); await cmds[cmd](); return; }
    }
    text.value = '';
    autosize();
    const res = await window.jarvis.send(raw);
    if (res?.error === 'BUSY') { text.value = raw; autosize(); }
  }

  async function retry() { await window.jarvis.retry(); }

  function autosize() {
    text.style.height = 'auto';
    text.style.height = Math.min(120, text.scrollHeight) + 'px';
  }
  text.addEventListener('input', autosize);
  text.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  sendBtn.addEventListener('click', submit);
  stopBtn.addEventListener('click', () => window.jarvis.stop());
  micBtn.addEventListener('click', () => window.jarvis.voice());
  chip.addEventListener('click', () => window.jarvis.openSettings());
  $('newBtn').addEventListener('click', async () => { session = await window.jarvis.newChat(); live = null; drawLog(); refreshList(); text.focus(); });
  $('closeBtn').addEventListener('click', () => window.jarvis.hide());
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); window.jarvis.escape(); }
  });

  // ---------- events ----------
  const STATE_LABEL = { idle: 'IDLE', listening: 'LISTENING', thinking: 'THINKING', speaking: 'SPEAKING', error: 'ERROR' };

  function setState(ev) {
    state = ev.state;
    stateEl.textContent = STATE_LABEL[state] || state.toUpperCase();
    stateEl.className = 'state ' + state;
    if (ev.detail && (state === 'error' || state === 'idle')) stateEl.textContent += ' · ' + ev.detail;
    micBtn.classList.toggle('on', state === 'listening');
    if (typeof ev.detail === 'string' && ev.detail.startsWith('Mic unavailable')) {
      micReason = ev.detail;
      micBtn.disabled = true;
      micBtn.title = micReason;
    }
  }

  window.jarvis.onEvent(async ev => {
    if (window.MiniOrbInstance) window.MiniOrbInstance.event(ev);
    switch (ev.type) {
      case 'state':
        setState(ev);
        if (ev.state === 'thinking') {
          setBusy(true);
          lookupEvents = [];
          live = { el: null, text: '' };
          liveTools = [];
          session = await window.jarvis.current();
          drawLog();
          refreshList();
        } else if (ev.state === 'idle' || ev.state === 'speaking' || ev.state === 'error') {
          if (ev.state !== 'error') setBusy(false);
          if (live) { live = null; await reload(); }
        }
        break;
      case 'token':
        if (!live) live = { el: null, text: '' };
        live.text += ev.text;
        if (!renderQueued) { renderQueued = true; requestAnimationFrame(drawLive); }
        break;
      case 'retract':   // the model's last words were a false claim and are being redone
        if (live) { live.text = ''; drawLive(); }
        break;
      case 'tool':
        if (ev.phase === 'start') { liveTools.push(ev.label || ev.name); if (live) drawLog(); }
        if (ev.phase === 'end') reload();
        break;
      case 'net':
        if (live && (ev.ok || ev.cached)) {
          lookupEvents = lookupEvents.filter(x => x.host !== ev.host);
          lookupEvents.push(ev);
          drawLive();
        }
        break;
      case 'boot': showBoot(ev); break;
      case 'route':
        routeLabel = (ev.model ? String(ev.model).replace(/:latest$/, '').toUpperCase() : ev.tier?.toUpperCase() || '') + (ev.think ? ' · REASONING' : '');
        stateEl.textContent = (STATE_LABEL[state] || state.toUpperCase()) + (routeLabel ? ' · ' + routeLabel : '');
        break;
      case 'turn': {
        const parts = [];
        if (ev.tps) parts.push(`${ev.tps} TOK/S`);
        parts.push(`${(ev.ms / 1000).toFixed(1)} S`);
        if (ev.toolRounds) parts.push(`${ev.toolRounds} TOOL${ev.toolRounds > 1 ? 'S' : ''}`);
        statEl.textContent = parts.join(' · ');
        break;
      }
      case 'provider':
        providerReady = !!ev.ready;
        chip.textContent = ev.ready ? String(ev.label).toUpperCase() : 'NO MODEL SET';
        chip.classList.toggle('ready', !!ev.ready);
        break;
      case 'level':
        if (ev.source === 'mic') { levels.push(Math.min(1, ev.rms * 6)); levels.shift(); }
        break;
      case 'mic':
        micBtn.disabled = !ev.ok;
        micBtn.title = ev.ok ? 'Talk (Ctrl+Shift+Space)' : 'Mic unavailable: ' + (ev.reason || '');
        break;
    }
  });

  // ---------- boot sequence: one line per real stage result ----------
  const bootEl = $('boot'), bootList = $('bootList');
  let bootHide = 0;
  function showBoot(ev) {
    bootEl.hidden = false;
    bootEl.classList.remove('fade');
    const li = el('li', ev.stage === 'done' ? 'done' : ev.ok ? '' : 'bad');
    li.append(el('b', '', String(ev.stage).toUpperCase()), el('span', '', ev.detail || ''), el('i', '', ev.stage === 'done' ? (ev.ok ? 'ONLINE' : 'PARTIAL') : ev.ok ? 'OK' : 'OFF'));
    bootList.appendChild(li);
    clearTimeout(bootHide);
    if (ev.stage === 'done') {
      bootHide = setTimeout(() => { bootEl.classList.add('fade'); setTimeout(() => { bootEl.hidden = true; bootList.replaceChildren(); }, 650); }, 1400);
    }
  }

  // ---------- mic waveform ----------
  function drawWave() {
    const w = 44, h = 28;
    wave.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    wave.fillStyle = state === 'listening' ? css.getPropertyValue('--accent') : css.getPropertyValue('--muted');
    const bw = w / levels.length;
    levels.forEach((v, i) => {
      const bh = Math.max(2, v * h);
      wave.fillRect(i * bw + 0.5, (h - bh) / 2, Math.max(1, bw - 1), bh);
    });
    if (state !== 'listening') for (let i = 0; i < levels.length; i++) levels[i] *= 0.85;
    requestAnimationFrame(drawWave);
  }
  requestAnimationFrame(drawWave);

  window.jarvis.onShown(() => { text.focus(); reload(); });
  window.jarvis.status();
  reload();
  text.focus();
})();
