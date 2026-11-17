// JARVIS analytics page: reads /ai/metrics (same origin, this PC only) and draws everything as plain SVG and HTML,
// using the shared HUD kit (/ai/hud.js). No libraries, no outside requests. Text is always set with textContent.
(() => {
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const HUD = window.HUD || { countUp: (e, v, o) => { e.textContent = (o && o.fmt ? o.fmt(v) : v); }, reveal() { document.querySelectorAll('.hud-reveal').forEach(e => e.classList.add('in')); }, ring: () => document.createElementNS(NS, 'svg'), spark: () => document.createElementNS(NS, 'svg'), reduced: true };
  const state = { range: 'day', sort: 'calls', desc: true, data: null, timer: null, prev: {}, beatT: 0 };
  const REFRESH_MS = 30000;
  const params = new URLSearchParams(location.search);
  if (['hour', 'day', 'week', 'month'].includes(params.get('range'))) state.range = params.get('range');

  const el = (tag, attrs = {}, text) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  const sv = (tag, attrs = {}, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '–' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
  const secs = ms => (ms === null || ms === undefined ? '–' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s');
  const bytes = n => (n === null || n === undefined ? '–' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
  const clean = a => (a || []).map(v => (typeof v === 'number' && Number.isFinite(v) ? v : null));

  function query() {
    const q = new URLSearchParams({ range: state.range });
    for (const k of ['group', 'tool', 'source']) if ($(k).value) q.set(k, $(k).value);
    return q.toString();
  }

  // the thin line under the header drains over one refresh period, so you can see the page is live
  function beat() {
    const b = $('beat'); b.classList.remove('run'); void b.offsetWidth;
    if ($('auto').checked && !HUD.reduced) b.classList.add('run');
  }

  async function load() {
    $('status').textContent = 'SYNCING…';
    try {
      const q = query();
      const r = await fetch('/ai/metrics?' + q, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      state.data = await r.json();
      $('export').href = '/ai/metrics?' + q;
      $('live').classList.remove('crit'); $('live').classList.add('hud-pulse');
      render();
      $('status').textContent = 'UPDATED ' + new Date().toLocaleTimeString() + ' · ' + new Date(state.data.range.from).toLocaleString() + ' → ' + new Date(state.data.range.to).toLocaleString();
    } catch (err) {
      $('live').classList.add('crit'); $('live').classList.remove('hud-pulse');
      $('status').textContent = 'Could not load the numbers: ' + err.message + '. Is JARVIS running?';
    }
    beat();
  }

  function fillSelect(id, list) {
    const s = $(id), keep = s.value;
    const have = new Set([...s.options].map(o => o.value));
    for (const v of list) if (!have.has(v)) s.append(el('option', { value: v }, v));
    s.value = keep;
  }

  // ---- hero tiles ----
  function tile(key, label, num, fm, sub, cls = '', series = null) {
    const t = el('div', { class: 'tile hud-panel hud-reveal ' + cls });
    const ro = el('div', { class: 'hud-readout' }), v = el('div', { class: 'v' }), l = el('div', { class: 'l' }, label);
    const isNum = typeof num === 'number';
    if (isNum) { const was = state.prev[key]; HUD.countUp(v, num, { fmt: fm }); if (was !== undefined && was !== num) v.classList.add('hud-flash'); state.prev[key] = num; } else v.textContent = num;
    ro.append(v, l);
    if (sub) ro.append(el('div', { class: 's', title: sub }, sub));
    t.append(ro);
    if (series && clean(series).some(x => x !== null)) t.append(HUD.spark(clean(series), { w: 70, h: 28 }));
    return t;
  }

  function renderTiles(d) {
    const t = d.totals, m = d.memory.latest, s = d.series;
    const box = $('tiles'); box.textContent = '';
    const rate = t.toolSuccessRate;
    const n0 = x => fmt(x);
    box.append(
      tile('turns', 'Conversation turns', t.turns, n0, `${t.bySource.voice} voice · ${t.bySource.text} text`, '', s.turns),
      tile('p50', 'Typical reply', t.p50TurnMs === null ? '–' : t.p50TurnMs / 1000, x => secs(x * 1000), `slowest 5 %: ${secs(t.p95TurnMs)}`, '', (s.latencyP50 || []).map(v => (v === null ? null : v / 1000))),
      tile('calls', 'Skill calls', t.toolCalls, n0, `${fmt(t.fastPath)} answered without the model`, '', s.toolCalls),
      tile('rate', 'Skill success', rate === null ? '–' : rate, x => fmt(x, 1) + ' %', `${t.toolFail} failed · ${t.softFails} said nothing happened · ${t.badArgs} bad arguments`, rate === null ? '' : rate >= 95 ? 'ok' : rate >= 80 ? 'warn' : 'crit', s.toolFails ? s.toolFails.map(v => -v) : null),
      tile('errs', 'Errors', t.errors, n0, `${t.warnings} warnings`, t.errors ? 'crit' : 'ok', s.errors),
      tile('ask', 'Asked, not guessed', t.clarify.ask, n0, `${t.clarify.decline} declined (no tool)`),
      tile('yt', 'YouTube prompts', t.prompts.confirmed, n0, `${t.prompts.skipped} left alone`),
      tile('mem', 'Memory', m ? m.rssMB : '–', x => fmt(x) + ' MB', m ? `store: ${fmt(m.cortexNodes)} items, ${bytes(m.cortexBytes)}` : 'no samples yet', '', d.memory.rssMB),
    );
  }

  // ---- core health: one big ring + the proportions that explain it ----
  function meter(label, value, pct, cls = '') {
    const m = el('div', { class: 'meter' }), tr = el('div', { class: 'track' }), f = el('div', { class: 'fill ' + cls });
    const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
    tr.append(f); m.append(el('span', {}, label), el('b', {}, value), tr);
    requestAnimationFrame(() => requestAnimationFrame(() => { f.style.width = p + '%'; }));
    return m;
  }
  function renderHealth(d) {
    const t = d.totals, box = $('health'); box.textContent = '';
    const rate = t.toolSuccessRate, cls = rate === null ? '' : rate >= 95 ? 'ok' : rate >= 80 ? 'warn' : 'crit';
    const wrap = el('div', { class: 'health' }), rb = el('div', { class: 'ringbox ' + cls });
    const c = el('div', { class: 'c' }); const b = el('b'); HUD.countUp(b, rate, { fmt: x => fmt(x, 1) + '%' }); c.append(b, el('span', {}, 'SKILL SUCCESS'));
    rb.append(HUD.ring(rate, { size: 132 }), c);
    const calls = t.toolCalls || 0, turns = t.turns || 0, share = (a, bb) => (bb ? a / bb * 100 : 0);
    const ms = el('div', { class: 'meters' });
    ms.append(
      meter('Failed calls', `${fmt(t.toolFail)} / ${fmt(calls)}`, share(t.toolFail, calls), t.toolFail ? 'crit' : ''),
      meter('Said “nothing happened”', `${fmt(t.softFails)}`, share(t.softFails, calls), t.softFails ? 'warn' : ''),
      meter('Bad arguments', `${fmt(t.badArgs)}`, share(t.badArgs, calls), t.badArgs ? 'warn' : ''),
      meter('Voice share of turns', `${fmt(t.bySource.voice)} / ${fmt(turns)}`, share(t.bySource.voice, turns), 's2'),
    );
    wrap.append(rb, ms); box.append(wrap);
  }

  // ---- charts: plain SVG with glow, draw-in and a hover readout ----
  const W = 560, H = 200, P = { l: 42, r: 42, t: 12, b: 22 }, PW = W - P.l - P.r, PH = H - P.t - P.b;
  let gid = 0;
  const X = (i, n) => P.l + PW * (n <= 1 ? 0.5 : i / (n - 1));
  const Y = (v, max) => P.t + PH * (1 - (max ? v / max : 0));
  const fmtTime = (ts, span) => { const d = new Date(ts); return span > 2 * 864e5 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  function frame(range, max, right = null) {
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    for (let i = 0; i <= 4; i++) {
      const y = P.t + PH * i / 4;
      svg.append(sv('line', { x1: P.l, x2: W - P.r, y1: y, y2: y, class: 'grid-line' + (i === 4 ? ' zero' : '') }));
      svg.append(sv('text', { x: P.l - 6, y: y + 3, 'text-anchor': 'end' }, fmt(max * (1 - i / 4), max < 10 ? 1 : 0)));
      if (right) svg.append(sv('text', { x: W - P.r + 6, y: y + 3 }, fmt(right * (1 - i / 4), right < 10 ? 1 : 0)));
    }
    const span = range.to - range.from;
    for (let i = 0; i <= 3; i++) svg.append(sv('text', { x: P.l + PW * i / 3, y: H - 5, 'text-anchor': i === 0 ? 'start' : i === 3 ? 'end' : 'middle' }, fmtTime(range.from + span * i / 3, span)));
    return svg;
  }
  const legend = items => { const l = el('div', { class: 'legend' }); for (const [c, t] of items) { const s = el('span'); s.append(el('i', { class: c }), t); l.append(s); } return l; };
  const empty = (box, msg) => { box.textContent = ''; box.append(el('div', { class: 'empty' }, msg)); };
  function segments(vals, max, n) {
    const segs = []; let cur = null;
    vals.forEach((v, i) => { if (v === null) { cur = null; return; } if (!cur) { cur = []; segs.push(cur); } cur.push([X(i, n), Y(v, max)]); });
    return segs;
  }
  function line(vals, max, cls, n) {
    const d = segments(vals, max, n).map(s => s.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('')).join('');
    return sv('path', { d: d || 'M0 0', class: 'ln hud-draw ' + cls, pathLength: 1 });
  }
  function area(svg, vals, max, n, stopCls) {
    const id = 'g' + (++gid), defs = sv('defs'), g = sv('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 });
    g.append(sv('stop', { offset: '0%', 'stop-opacity': 0.35, class: stopCls }), sv('stop', { offset: '100%', 'stop-opacity': 0, class: stopCls }));
    defs.append(g); svg.append(defs);
    for (const s of segments(vals, max, n)) {
      const base = (P.t + PH).toFixed(1);
      svg.append(sv('path', { d: `M${s[0][0].toFixed(1)} ${base}` + s.map(p => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('') + `L${s[s.length - 1][0].toFixed(1)} ${base}Z`, fill: `url(#${id})`, class: 'area' }));
    }
  }
  // hover: a crosshair, a dot per series and a readout card. rows = [{ label, cls, vals, f, max }]
  function hover(box, svg, n, range, rows, xOf) {
    const cross = sv('line', { y1: P.t, y2: P.t + PH, class: 'cross', visibility: 'hidden' });
    const dots = rows.map(r => sv('circle', { r: 4, class: 'dotm ' + r.cls, visibility: 'hidden' }));
    svg.append(cross, ...dots);
    const tip = el('div', { class: 'tip' }); tip.hidden = true; box.append(tip);
    const span = range.to - range.from;
    svg.addEventListener('pointermove', e => {
      const r = svg.getBoundingClientRect(); if (!r.width) return;
      const xr = (e.clientX - r.left) / r.width * W;
      let i = 0, best = Infinity; for (let k = 0; k < n; k++) { const dx = Math.abs(xOf(k) - xr); if (dx < best) { best = dx; i = k; } }
      if (xr < P.l - 8 || xr > W - P.r + 8) return leave();
      const x = xOf(i).toFixed(1); cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      tip.textContent = ''; const when = n > 1 ? range.from + span * i / (n - 1) : range.from;
      tip.append(el('time', {}, new Date(when).toLocaleString()));
      rows.forEach((row, k) => {
        const v = row.vals[i], dm = dots[k];
        if (v === null || v === undefined) dm.setAttribute('visibility', 'hidden'); else { dm.setAttribute('cx', x); dm.setAttribute('cy', Y(v, row.max).toFixed(1)); dm.setAttribute('visibility', 'visible'); }
        const line = el('div'); const lab = el('span'); lab.append(el('i', { class: row.cls }), row.label); line.append(lab, el('b', {}, v === null || v === undefined ? '–' : row.f(v))); tip.append(line);
      });
      tip.hidden = false; const pct = xOf(i) / W * 100; tip.style.left = pct > 58 ? 'auto' : `calc(${pct}% + 12px)`; tip.style.right = pct > 58 ? `calc(${100 - pct}% + 12px)` : 'auto';
    });
    const leave = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dots.forEach(x => x.setAttribute('visibility', 'hidden')); };
    svg.addEventListener('pointerleave', leave);
  }

  function renderTurns(d) {
    const box = $('c-turns'), s = d.series, n = s.t.length;
    if (!s.turns.some(Boolean) && !s.errors.some(Boolean)) return empty(box, 'No conversation in this range');
    const max = Math.max(1, ...s.turns, ...s.errors);
    const svg = frame(d.range, max);
    const slot = PW / n, bw = Math.max(1, slot - 1.5), XB = i => P.l + slot * (i + 0.5);
    s.turns.forEach((v, i) => { if (v) { const h = PH * v / max; svg.append(sv('rect', { x: (XB(i) - bw / 2).toFixed(1), y: (P.t + PH - h).toFixed(1), width: bw.toFixed(1), height: h.toFixed(1), class: 'bar-s1', rx: 1 })); } });
    s.errors.forEach((v, i) => { if (v) { const h = PH * v / max; svg.append(sv('rect', { x: (XB(i) - bw / 4).toFixed(1), y: (P.t + PH - h).toFixed(1), width: (bw / 2).toFixed(1), height: h.toFixed(1), class: 'bar-bad', rx: 1 })); } });
    box.textContent = ''; box.append(legend([['s1', 'TURNS'], ['bad', 'ERRORS']]), svg);
    hover(box, svg, n, d.range, [{ label: 'turns', cls: 's1', vals: s.turns, f: v => fmt(v), max }, { label: 'errors', cls: 'bad', vals: s.errors, f: v => fmt(v), max }], XB);
  }

  function renderLatency(d) {
    const box = $('c-latency'), s = d.series, n = s.t.length;
    const p50 = clean(s.latencyP50).map(v => (v === null ? null : v / 1000)), p95 = clean(s.latencyP95).map(v => (v === null ? null : v / 1000));
    if (!p50.some(v => v !== null)) return empty(box, 'No replies in this range');
    const max = Math.max(1, ...p50.filter(v => v !== null), ...p95.filter(v => v !== null));
    const svg = frame(d.range, max);
    area(svg, p50, max, n, 'stop-a');
    svg.append(line(p95, max, 's3', n), line(p50, max, 's1', n));
    box.textContent = ''; box.append(legend([['s1', 'MEDIAN'], ['s3', 'SLOWEST 5 %']]), svg);
    hover(box, svg, n, d.range, [{ label: 'median', cls: 's1', vals: p50, f: v => v.toFixed(1) + ' s', max }, { label: 'slowest 5 %', cls: 's3', vals: p95, f: v => v.toFixed(1) + ' s', max }], i => X(i, n));
  }

  function renderMemory(d) {
    const box = $('c-memory'), m = d.memory, n = m.t.length;
    if (!n) return empty(box, 'No memory samples yet · one a minute');
    const rss = clean(m.rssMB), heap = clean(m.heapMB), nodes = clean(m.cortexNodes);
    const max = Math.max(1, ...rss.filter(v => v !== null), ...heap.filter(v => v !== null));
    const maxN = Math.max(1, ...nodes.filter(v => v !== null));
    const range = { from: m.t[0], to: m.t[n - 1] > m.t[0] ? m.t[n - 1] : d.range.to };
    const svg = frame(range, max, maxN);
    area(svg, rss, max, n, 'stop-a');
    svg.append(line(rss, max, 's1', n), line(heap, max, 's2', n), line(nodes, maxN, 's3', n));
    const g = m.growthPerDay;
    box.textContent = ''; box.append(legend([['s1', 'PROCESS MB'], ['s2', 'HEAP MB'], ['s3', 'STORE ITEMS']]), svg,
      el('p', { class: 'hud-sub note' }, `Growth per day: process ${g.rssMB === null ? '–' : fmt(g.rssMB, 1) + ' MB'}, memory store ${g.cortexNodes === null ? '–' : fmt(g.cortexNodes, 1) + ' items'}${g.cortexBytes === null ? '' : ' (' + bytes(g.cortexBytes) + ')'}.`));
    hover(box, svg, n, range, [{ label: 'process', cls: 's1', vals: rss, f: v => fmt(v, 1) + ' MB', max }, { label: 'heap', cls: 's2', vals: heap, f: v => fmt(v, 1) + ' MB', max }, { label: 'store items', cls: 's3', vals: nodes, f: v => fmt(v), max: maxN }], i => X(i, n));
  }

  // ---- links: a ring and a 20-cell strip per service ----
  const NAMES = { ollama: 'Language model', ytmusic: 'YouTube Music', wallpaper: 'Wallpaper', speechHost: 'Speech host', mediaHost: 'Media host', pcHost: 'PC host' };
  function renderConn(d) {
    const box = $('c-conn'); box.textContent = '';
    const list = Object.entries(d.connections || {});
    if (!list.length) return empty(box, 'No connection checks yet');
    const wrap = el('div', { class: 'links' });
    for (const [k, c] of list) {
      const cls = c.upPct >= 99 ? '' : c.upPct >= 90 ? 'warn' : 'crit';
      const row = el('div', { class: 'link', title: `${c.samples} checks` });
      const nm = el('div', { class: 'nm' }); nm.append(el('span', {}, NAMES[k] || k), el('small', {}, `${c.drops || 0} drops · ${c.reconnects || 0} reconnects`));
      const pips = el('div', { class: 'pips ' + cls }), lit = Math.round(Math.max(0, Math.min(100, c.upPct)) / 5);
      for (let i = 0; i < 20; i++) { const p = el('i'); p.style.transitionDelay = i * 25 + 'ms'; pips.append(p); requestAnimationFrame(() => requestAnimationFrame(() => { if (i < lit) p.classList.add('on'); })); }
      row.append(HUD.ring(c.upPct, { size: 40, good: 99, warn: 90 }), nm, pips, el('span', { class: 'pct' }, c.upPct + ' %'));
      wrap.append(row);
    }
    box.append(wrap);
  }

  function renderSkills(d) {
    const tb = document.querySelector('#skills tbody'); tb.textContent = '';
    for (const th of document.querySelectorAll('#skills th')) { const on = th.dataset.k === state.sort; th.classList.toggle('sorted', on); th.classList.toggle('asc', on && !state.desc); }
    const rows = [...d.tools].sort((a, b) => {
      const x = a[state.sort], y = b[state.sort];
      const c = typeof x === 'string' || typeof y === 'string' ? String(x ?? '').localeCompare(String(y ?? '')) : (x ?? -1) - (y ?? -1);
      return state.desc ? -c : c;
    });
    if (!rows.length) { const tr = el('tr'); tr.append(el('td', { colspan: 9, class: 'muted' }, 'No skill calls in this range')); tb.append(tr); return; }
    for (const r of rows) {
      const tr = el('tr'), cls = r.successRate >= 95 ? '' : r.successRate < 80 ? 'crit' : 'warn';
      const ok = el('td', { class: 'n' }), sr = el('span', { class: 'sr' }), tk = el('span', { class: 'track' }), f = el('span', { class: 'fill ' + cls });
      f.style.width = Math.max(0, Math.min(100, r.successRate)) + '%'; tk.append(f); sr.append(el('span', { class: cls === 'crit' ? 'bad' : '' }, r.successRate + ' %'), tk); ok.append(sr);
      tr.append(el('td', {}, r.name), el('td', { class: 'muted' }, r.group || ''), el('td', { class: 'n' }, fmt(r.calls)), ok,
        el('td', { class: 'n' + (r.fail ? ' bad' : '') }, fmt(r.fail)), el('td', { class: 'n' }, fmt(r.soft)), el('td', { class: 'n' }, fmt(r.badArgs)), el('td', { class: 'n' }, fmt(r.avgMs)), el('td', { class: 'n' }, fmt(r.p95Ms)));
      tb.append(tr);
    }
  }

  function render() {
    const d = state.data;
    fillSelect('group', d.filters.groups); fillSelect('tool', d.filters.tools);
    renderTiles(d); renderHealth(d); renderTurns(d); renderLatency(d); renderMemory(d); renderConn(d); renderSkills(d);
    HUD.reveal(document);
  }

  // ---- live link: the running core's public event stream (no text, only states and timings) drives the header ----
  const CORE = { idle: ['IDLE', ''], listening: ['LISTENING', ''], thinking: ['THINKING', 'warn'], speaking: ['SPEAKING', ''], error: ['ERROR', 'crit'] };
  function setCore(label, cls) { const c = $('core'); c.textContent = label; c.className = 'hud-chip' + (cls ? ' ' + cls : ''); }
  function tick(text) { const t = $('ticker'); t.textContent = text; t.classList.remove('hud-flash'); void t.offsetWidth; t.classList.add('hud-flash'); }
  let soon = 0;
  function refreshSoon() { clearTimeout(soon); soon = setTimeout(() => { if ($('auto').checked && !document.hidden) load(); }, 1500); }   // the log has the turn by now
  function link() {
    if (!window.EventSource) { setCore('NO LIVE LINK', 'warn'); return; }
    const es = new EventSource('/ai/stream');
    const on = (type, fn) => es.addEventListener(type, e => { try { fn(JSON.parse(e.data)); } catch { /* a malformed event is ignored */ } });
    es.onopen = () => setCore('LINKED', '');
    es.onerror = () => { setCore('OFFLINE', 'crit'); $('live').classList.add('off'); $('live').classList.remove('busy'); };
    on('state', d => {
      const [label, cls] = CORE[d.state] || [String(d.state || '').toUpperCase(), ''];
      setCore(label, cls); $('live').classList.remove('off'); $('live').classList.toggle('busy', d.state === 'thinking' || d.state === 'speaking' || d.state === 'listening');
    });
    on('tool', d => { if (d.phase === 'end') tick(`${d.name || 'skill'} ${d.ok === false ? 'failed' : 'ok'}`); });
    on('turn', d => { tick(`reply ${secs(d.ms)}${d.tps ? ' · ' + Math.round(d.tps) + ' tok/s' : ''}`); refreshSoon(); });
  }

  for (const b of document.querySelectorAll('#ranges button')) b.addEventListener('click', () => {
    state.range = b.dataset.range;
    for (const x of document.querySelectorAll('#ranges button')) x.classList.toggle('on', x === b);
    load();
  });
  for (const id of ['group', 'tool', 'source']) $(id).addEventListener('change', load);
  for (const th of document.querySelectorAll('#skills th')) th.addEventListener('click', () => {
    const k = th.dataset.k; state.desc = state.sort === k ? !state.desc : true; state.sort = k; if (state.data) renderSkills(state.data);
  });
  function schedule() { clearInterval(state.timer); if ($('auto').checked) state.timer = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS); beat(); }
  $('auto').addEventListener('change', schedule);
  for (const x of document.querySelectorAll('#ranges button')) x.classList.toggle('on', x.dataset.range === state.range);
  schedule();
  link();
  load();
})();
