// JARVIS analytics page: reads /ai/metrics (same origin, this PC only) and draws everything as plain SVG and HTML.
// No libraries and no outside requests. Text is always set with textContent.
(() => {
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const state = { range: 'day', sort: 'calls', desc: true, data: null, timer: null };
  const params = new URLSearchParams(location.search);
  if (['hour', 'day', 'week', 'month'].includes(params.get('range'))) state.range = params.get('range');

  const el = (tag, attrs = {}, text) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  const sv = (tag, attrs = {}, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  const fmt = (n, d = 0) => (n === null || n === undefined ? '–' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
  const secs = ms => (ms === null || ms === undefined ? '–' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s');
  const bytes = n => (n === null || n === undefined ? '–' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');

  function query() {
    const q = new URLSearchParams({ range: state.range });
    for (const k of ['group', 'tool', 'source']) if ($(k).value) q.set(k, $(k).value);
    return q.toString();
  }

  async function load() {
    $('status').textContent = 'Loading…';
    try {
      const q = query();
      const r = await fetch('/ai/metrics?' + q, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      state.data = await r.json();
      $('export').href = '/ai/metrics?' + q;
      render();
      $('status').textContent = 'Updated ' + new Date().toLocaleTimeString() + ' · ' + new Date(state.data.range.from).toLocaleString() + ' to ' + new Date(state.data.range.to).toLocaleString();
    } catch (err) {
      $('status').textContent = 'Could not load the numbers: ' + err.message + '. Is JARVIS running?';
    }
  }

  function fillSelect(id, list) {
    const s = $(id), keep = s.value;
    const have = new Set([...s.options].map(o => o.value));
    for (const v of list) if (!have.has(v)) s.append(el('option', { value: v }, v));
    s.value = keep;
  }

  function tile(label, value, sub, cls = '') {
    const t = el('div', { class: 'tile ' + cls });
    t.append(el('b', {}, value), el('span', {}, label));
    if (sub) t.append(el('small', {}, sub));
    return t;
  }

  function renderTiles(d) {
    const t = d.totals, m = d.memory.latest;
    const box = $('tiles'); box.textContent = '';
    const rate = t.toolSuccessRate;
    box.append(
      tile('Conversation turns', fmt(t.turns), `${t.bySource.voice} voice · ${t.bySource.text} text`),
      tile('Typical reply', secs(t.p50TurnMs), `slowest 5 %: ${secs(t.p95TurnMs)}`),
      tile('Skill calls', fmt(t.toolCalls), `${fmt(t.fastPath)} answered without the model`),
      tile('Skill success', rate === null ? '–' : rate + ' %', `${t.toolFail} failed · ${t.softFails} said nothing happened · ${t.badArgs} bad arguments`, rate === null ? '' : rate >= 95 ? 'good' : rate >= 80 ? 'warn' : 'bad'),
      tile('Errors', fmt(t.errors), `${t.warnings} warnings`, t.errors ? 'bad' : 'good'),
      tile('Asked instead of guessing', fmt(t.clarify.ask), `${t.clarify.decline} declined (no tool)`),
      tile('YouTube prompts', fmt(t.prompts.confirmed), `${t.prompts.skipped} left alone`),
      tile('Memory', m ? fmt(m.rssMB) + ' MB' : '–', m ? `store: ${fmt(m.cortexNodes)} items, ${bytes(m.cortexBytes)}` : 'no samples yet'),
    );
  }

  // ---- charts: plain SVG ----
  const W = 520, H = 190, P = { l: 38, r: 38, t: 10, b: 22 };
  function frame(times, max, right = null) {
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    for (let i = 0; i <= 4; i++) {
      const y = P.t + (H - P.t - P.b) * i / 4;
      svg.append(sv('line', { x1: P.l, x2: W - P.r, y1: y, y2: y, class: 'grid-line' }));
      svg.append(sv('text', { x: P.l - 4, y: y + 3, 'text-anchor': 'end' }, fmt(max * (1 - i / 4), max < 10 ? 1 : 0)));
      if (right) svg.append(sv('text', { x: W - P.r + 4, y: y + 3 }, fmt(right * (1 - i / 4), right < 10 ? 1 : 0)));
    }
    const span = state.data.range.to - state.data.range.from;
    for (let i = 0; i <= 3; i++) {
      const t = state.data.range.from + span * i / 3;
      const d = new Date(t);
      svg.append(sv('text', { x: P.l + (W - P.l - P.r) * i / 3, y: H - 6, 'text-anchor': i === 0 ? 'start' : i === 3 ? 'end' : 'middle' }, span > 2 * 864e5 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    }
    return svg;
  }
  const X = (i, n) => P.l + (W - P.l - P.r) * (n <= 1 ? 0.5 : i / (n - 1));
  const Y = (v, max) => P.t + (H - P.t - P.b) * (1 - (max ? v / max : 0));
  function legend(items) { const l = el('div', { class: 'legend' }); for (const [c, t] of items) { const s = el('span'); const i = el('i'); i.style.background = c; s.append(i, t); l.append(s); } return l; }
  function path(vals, max, cls, n) {
    let dStr = '', pen = false;
    vals.forEach((v, i) => { if (v === null || v === undefined) { pen = false; return; } dStr += `${pen ? 'L' : 'M'}${X(i, n).toFixed(1)} ${Y(v, max).toFixed(1)}`; pen = true; });
    return sv('path', { d: dStr, class: 'ln ' + cls });
  }
  const empty = (box, msg) => { box.textContent = ''; box.append(el('div', { class: 'empty' }, msg)); };

  function renderTurns(d) {
    const box = $('c-turns'), s = d.series, n = s.t.length;
    if (!s.turns.some(Boolean) && !s.errors.some(Boolean)) return empty(box, 'No conversation in this range.');
    const max = Math.max(1, ...s.turns, ...s.errors);
    const svg = frame(s.t, max);
    const bw = Math.max(1, (W - P.l - P.r) / n - 1);
    s.turns.forEach((v, i) => { if (v) { const h = (H - P.t - P.b) * v / max; svg.append(sv('rect', { x: P.l + (W - P.l - P.r) * i / n, y: H - P.b - h, width: bw, height: h, class: 'bar-s1', rx: 1 })); } });
    s.errors.forEach((v, i) => { if (v) { const h = (H - P.t - P.b) * v / max; svg.append(sv('rect', { x: P.l + (W - P.l - P.r) * i / n + bw * 0.25, y: H - P.b - h, width: bw * 0.5, height: h, class: 'bar-bad', rx: 1 })); } });
    box.textContent = ''; box.append(legend([['var(--s1)', 'turns'], ['var(--bad)', 'errors']]), svg);
  }

  function renderLatency(d) {
    const box = $('c-latency'), s = d.series, n = s.t.length;
    const p50 = s.latencyP50.map(v => (v === null ? null : v / 1000)), p95 = s.latencyP95.map(v => (v === null ? null : v / 1000));
    if (!p50.some(v => v !== null)) return empty(box, 'No replies in this range.');
    const max = Math.max(1, ...p50.filter(v => v !== null), ...p95.filter(v => v !== null));
    const svg = frame(s.t, max);
    svg.append(path(p95, max, 's3', n), path(p50, max, 's1', n));
    box.textContent = ''; box.append(legend([['var(--s1)', 'median'], ['var(--s3)', 'slowest 5 %']]), svg);
  }

  function renderMemory(d) {
    const box = $('c-memory'), m = d.memory, n = m.t.length;
    if (!n) return empty(box, 'No memory samples yet. JARVIS takes one a minute.');
    const rss = m.rssMB, heap = m.heapMB, nodes = m.cortexNodes;
    const max = Math.max(1, ...rss.filter(v => v !== null), ...heap.filter(v => v !== null));
    const maxN = Math.max(1, ...nodes.filter(v => v !== null));
    const svg = frame(m.t, max, maxN);
    svg.append(path(rss, max, 's1', n), path(heap, max, 's2', n), path(nodes, maxN, 's3', n));
    const g = m.growthPerDay;
    box.textContent = ''; box.append(legend([['var(--s1)', 'process MB'], ['var(--s2)', 'heap MB'], ['var(--s3)', 'memory-store items']]), svg,
      el('p', { class: 'muted note' }, `Growth per day: process ${g.rssMB === null ? '–' : fmt(g.rssMB, 1) + ' MB'}, memory store ${g.cortexNodes === null ? '–' : fmt(g.cortexNodes, 1) + ' items'}${g.cortexBytes === null ? '' : ' (' + bytes(g.cortexBytes) + ')'}.`));
  }

  const NAMES = { ollama: 'Language model', ytmusic: 'YouTube Music', wallpaper: 'Wallpaper', speechHost: 'Speech host', mediaHost: 'Media host', pcHost: 'PC host' };
  function renderConn(d) {
    const box = $('c-conn'); box.textContent = '';
    const list = Object.entries(d.connections);
    if (!list.length) return empty(box, 'No connection checks yet.');
    for (const [k, c] of list) {
      const row = el('div', { class: 'bar' });
      const track = el('div', { class: 'track' }), fill = el('div', { class: 'fill' });
      fill.style.width = c.upPct + '%'; fill.style.background = c.upPct >= 99 ? 'var(--good)' : c.upPct >= 90 ? 'var(--warn)' : 'var(--bad)';
      track.append(fill);
      row.append(el('span', {}, NAMES[k] || k), track, el('span', { class: 'n' }, c.upPct + ' %'));
      row.title = `${c.samples} checks`;
      box.append(row);
    }
  }

  function renderSkills(d) {
    const tb = document.querySelector('#skills tbody'); tb.textContent = '';
    const rows = [...d.tools].sort((a, b) => {
      const x = a[state.sort], y = b[state.sort];
      const c = typeof x === 'string' || typeof y === 'string' ? String(x ?? '').localeCompare(String(y ?? '')) : (x ?? -1) - (y ?? -1);
      return state.desc ? -c : c;
    });
    if (!rows.length) { const tr = el('tr'); const td = el('td', { colspan: 9, class: 'muted' }, 'No skill calls in this range.'); tr.append(td); tb.append(tr); return; }
    for (const r of rows) {
      const tr = el('tr');
      tr.append(el('td', {}, r.name), el('td', {}, r.group || ''), el('td', { class: 'n' }, fmt(r.calls)), el('td', { class: 'n ' + (r.successRate >= 95 ? 'good' : r.successRate < 80 ? 'bad' : '') }, r.successRate + ' %'),
        el('td', { class: 'n' }, fmt(r.fail)), el('td', { class: 'n' }, fmt(r.soft)), el('td', { class: 'n' }, fmt(r.badArgs)), el('td', { class: 'n' }, fmt(r.avgMs)), el('td', { class: 'n' }, fmt(r.p95Ms)));
      tb.append(tr);
    }
  }

  function render() {
    const d = state.data;
    fillSelect('group', d.filters.groups); fillSelect('tool', d.filters.tools);
    renderTiles(d); renderTurns(d); renderLatency(d); renderMemory(d); renderConn(d); renderSkills(d);
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
  function schedule() { clearInterval(state.timer); if ($('auto').checked) state.timer = setInterval(() => { if (!document.hidden) load(); }, 30000); }
  $('auto').addEventListener('change', schedule);
  for (const x of document.querySelectorAll('#ranges button')) x.classList.toggle('on', x.dataset.range === state.range);
  schedule();
  load();
})();
