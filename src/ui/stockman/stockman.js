// StockMan page: asks /ai/stockman/state every few seconds and draws it. All text goes in as plain text nodes, and every
// number is formatted here; a missing part shows a dash or its own error, never a guess. Read-only: nothing on this page can place an order.
(function () {
  'use strict';
  const POLL_MS = 5000;
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, props, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v); }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  };
  const svg = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; };
  const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const pct = (x, d = 3) => (num(x) === null ? '—' : `${(x * 100).toFixed(d)}%`);
  const fix = (x, d = 1) => (num(x) === null ? '—' : x.toFixed(d));
  const clock = ms => new Date(ms).toLocaleTimeString([], { hour12: false });
  const ago = ms => { if (num(ms) === null) return '—'; const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 86400)} d`; };
  const clear = n => { while (n.firstChild) n.removeChild(n.firstChild); };
  const sign = x => (num(x) === null ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');

  function tile(label, value, sub, tone) {
    return el('div', { class: `hud-panel tile ${tone || ''}` }, el('div', { class: `hud-readout ${tone || ''}` }, el('div', { class: 'l', text: label }), el('div', { class: 'v', text: value }), el('div', { class: 's', text: sub || '' })));
  }

  function lineChart(host, points, { ref = null, unit = '', xFmt = clock } = {}) {
    clear(host);
    const W = 600, H = 170, L = 34, R = 8, T = 8, B = 20;
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
    if (!points.length) { const t = svg('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty' }); t.textContent = 'no quotes yet today (the sampler runs while the US market is open)'; s.append(t); host.append(s); return; }
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1);
    const y1 = Math.max(...ys, ref ?? 0, 1) * 1.15, y0 = 0;
    const X = x => L + ((x - x0) / (x1 - x0)) * (W - L - R), Y = y => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
    s.append(svg('line', { class: 'axis', x1: L, y1: Y(0), x2: W - R, y2: Y(0) }), svg('line', { class: 'axis', x1: L, y1: T, x2: L, y2: Y(0) }));
    if (ref !== null) { s.append(svg('line', { class: 'ref', x1: L, y1: Y(ref), x2: W - R, y2: Y(ref) })); const t = svg('text', { x: L + 4, y: Y(ref) - 4 }); t.textContent = `assumed ${ref} ${unit}`; s.append(t); }
    s.append(svg('polyline', { class: 'line', points: points.map(p => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ') }));
    for (const p of points) s.append(svg('circle', { class: 'pt', cx: X(p[0]).toFixed(1), cy: Y(p[1]).toFixed(1), r: 2.2 }));
    const tTop = svg('text', { x: 2, y: T + 8 }); tTop.textContent = fix(y1, 1); const tZero = svg('text', { x: 2, y: Y(0) }); tZero.textContent = '0';
    const tA = svg('text', { x: L, y: H - 4 }); tA.textContent = xFmt(x0); const tB = svg('text', { x: W - R, y: H - 4, 'text-anchor': 'end' }); tB.textContent = xFmt(x1);
    s.append(tTop, tZero, tA, tB); host.append(s);
  }
  function spark(series) {
    const s = svg('svg', { class: 'spark', viewBox: '0 0 120 22', preserveAspectRatio: 'none' });
    const ys = series.map(p => p[1]).filter(y => num(y) !== null);
    if (ys.length < 2) return s;
    const lo = Math.min(...ys, 0), hi = Math.max(...ys, 0), span = hi - lo || 1;
    const Y = y => 2 + (1 - (y - lo) / span) * 18;
    s.append(svg('line', { class: 'zero', x1: 0, y1: Y(0), x2: 120, y2: Y(0) }));
    s.append(svg('polyline', { class: 'line', points: ys.map((y, i) => `${((i / (ys.length - 1)) * 120).toFixed(1)},${Y(y).toFixed(1)}`).join(' ') }));
    return s;
  }
  function rows(tbody, list, cells) {
    clear(tbody);
    if (!list.length) { const tr = el('tr'); tr.append(el('td', { colspan: 9, class: 'no', text: 'nothing yet' })); tbody.append(tr); return; }
    for (const r of list) { const tr = el('tr'); for (const c of cells(r)) tr.append(c); tbody.append(tr); }
  }
  const td = (text, cls) => el('td', { class: cls || '', text });

  function draw(s) {
    const eng = s.engine && !s.engine.error ? s.engine : {};
    const breaker = eng.breaker?.state || '—';
    const live = eng.started === true;
    $('engine').textContent = live ? `ENGINE LIVE · ${String(eng.provider || '').toUpperCase()}` : 'ENGINE STARTING';
    $('engine').className = `hud-chip${live && breaker === 'closed' ? '' : ' warn'}`;
    $('live').className = `hud-dot ${live ? 'hud-pulse' : 'warn'}`;
    $('market').textContent = s.marketOpen === true ? 'MARKET OPEN' : 'MARKET CLOSED';
    $('market').className = `hud-chip${s.marketOpen === true ? '' : ' warn'}`;
    $('clock').textContent = `NY ${s.nyDay} · ${clock(s.asOf)}`;

    const d = s.data && !s.data.error ? s.data : {};
    const cov = d.coverage || {};
    const sp = s.spreads && !s.spreads.error ? s.spreads : null;
    const sm = sp?.summary || {};
    const sh = s.shadow && !s.shadow.error ? s.shadow : {};
    const fw = Array.isArray(s.forward) ? s.forward : [];
    const filled = (sh.reversal?.outcomesOk || 0) + (sh.momentum?.outcomesOk || 0);
    const open = Array.isArray(s.ledger) ? s.ledger.filter(r => r.status === 'open').reduce((a, r) => a + r.n, 0) : 0;
    const t = $('tiles'); clear(t);
    const spreadTone = num(sm.roundTripMedianBps) === null ? '' : sm.roundTripMedianBps > 10 ? 'warn' : 'ok';
    t.append(
      tile('Data freshness', cov.of ? `${cov.fresh} / ${cov.of}` : '—', `symbols fresh for ${d.targetSession || '—'}, data ${ago(d.dataAgeMs)} old`, cov.of && cov.fresh < cov.of ? 'warn' : ''),
      tile('Quoted spread', num(sm.roundTripMedianBps) === null ? '—' : `${fix(sm.roundTripMedianBps)} bps`, `median per symbol today, ${sm.samples || 0} quotes, assumed 10`, spreadTone),
      tile('Shadow days', `${sh.reversal?.days ?? 0} / ${sh.momentum?.days ?? 0}`, 'reversal / momentum days logged'),
      tile('Outcomes filled', String(filled), `${(sh.reversal?.outcomesGap || 0) + (sh.momentum?.outcomesGap || 0)} gaps, none filled in`),
      tile('Paper positions', String(open), s.switches?.paperTrading ? 'paper opener ON' : 'paper opener OFF', s.switches?.paperTrading ? 'warn' : ''),
      tile('Provider', breaker.toUpperCase(), `${eng.calls ?? 0} calls, ${eng.failures ?? 0} failed`, breaker === 'closed' ? '' : 'crit'),
    );

    if (sp) {
      lineChart($('c-spread'), sp.buckets.map(b => [b.t, b.avg]), { ref: sp.assumedBps, unit: 'bps' });
      const fillTop = (tbl, list) => rows($(tbl).tBodies[0], list, r => [td(r.symbol), td(`${fix(r.bps, 2)} bps`, 'n'), td(`${r.n}×`, 'n')]);
      fillTop('t-wide', sp.widest); fillTop('t-tight', sp.tightest);
      rows($('t-quotes').tBodies[0], sp.latest, r => [td(r.symbol), td(fix(r.bid, 2), 'n'), td(fix(r.ask, 2), 'n'), td(fix(r.bps, 2), 'n'), td(clock(r.at))]);
    }
    const op = s.options && !s.options.error ? s.options : null;
    rows($('t-odte').tBodies[0], op ? Object.entries(op.byDte || {}).map(([k, v]) => ({ k, ...v })) : [], r => [td(`${r.k} days`), td(String(r.samples), 'n'), td(r.medianSpreadPct === null ? '—' : `${(r.medianSpreadPct * 100).toFixed(1)}%`, 'n'), td(fix(r.medianSpreadAbs, 2), 'n')]);
    rows($('t-ounder').tBodies[0], op ? (op.perUnderlying || []).slice(0, 12) : [], r => [td(r.underlying), td(String(r.samples), 'n'), td(`${(r.medianSpreadPct * 100).toFixed(1)}%`, 'n')]);
    rows($('t-forward').tBodies[0], fw, r => {
      const c = el('td'); c.append(spark(r.series || []));
      return [td(r.label), td(String(r.days), 'n'), td(String(r.names), 'n'), td(pct(r.meanGross), `n ${sign(r.meanGross)}`), td(pct(r.meanNet10), `n ${sign(r.meanNet10)}`), td(r.winShare === null ? '—' : `${(r.winShare * 100).toFixed(0)}%`, 'n'), c];
    });
    rows($('t-bt').tBodies[0], Array.isArray(s.backtests) ? s.backtests : [], r => [td(r.variant), td(r.period), td(String(r.windows ?? '—'), 'n'), td(pct(r.grossExcess), `n ${sign(r.grossExcess)}`), td(pct(r.net10), `n ${sign(r.net10)}`), td(`[${pct(r.lo)}, ${pct(r.hi)}]`), td(r.pass ? 'yes' : 'NO', r.pass ? 'yes' : 'no')]);

    const lines = $('lines'); clear(lines);
    const sums = s.summaries && !s.summaries.error ? s.summaries : {};
    for (const [k, v] of Object.entries(sums)) if (v) { lines.append(el('dt', { text: k }), el('dd', { text: v })); }
    if (!lines.firstChild) lines.append(el('dt', { text: 'status' }), el('dd', { text: 'no stage has reported yet' }));

    const sys = $('sys'); clear(sys);
    const add = (k, v, cls) => sys.append(el('dt', { text: k }), el('dd', { class: cls || '', text: v }));
    add('Engine', live ? 'running' : 'starting', live ? '' : 'warn');
    add('Provider breaker', breaker, breaker === 'closed' ? '' : 'crit');
    add('Last provider ok', eng.lastOkAt ? `${ago(s.asOf - eng.lastOkAt)} ago` : '—');
    if (eng.lastError) add('Last provider error', String(eng.lastError.message || eng.lastError).slice(0, 160), 'warn');
    add('Database version', String(eng.dbVersion ?? '—'));
    add('Features', Array.isArray(eng.features) ? eng.features.join(', ') : '—');
    add('Paper trading', s.switches?.paperTrading ? 'ON' : 'off (no rule passed tuning)', s.switches?.paperTrading ? 'warn' : '');
    if (s.router && !s.router.error) add('Broker router', `${Object.entries(s.router.positions || {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'no positions yet'}${s.router.last ? `; last step ${s.router.last.status}` : ''}`, s.router.last && s.router.last.status !== 'ok' ? 'warn' : '');
    add('Alpaca orders', s.switches?.brokerOrders ? `ON, cap USD ${s.switches.brokerMaxNotionalUsd}` : 'off (paper account reads only)', s.switches?.brokerOrders ? 'warn' : '');

    const ev = $('events'); clear(ev);
    for (const e of Array.isArray(s.events) ? s.events : []) ev.append(el('li', { class: e.level }, el('b', { text: clock(e.at) }), `${e.source}: ${e.message}`));
    if (!ev.firstChild) ev.append(el('li', { text: 'no events' }));
    document.querySelectorAll('.hud-reveal:not(.in)').forEach(n => n.classList.add('in'));
  }

  let busy = false;
  async function poll() {
    if (busy) return; busy = true;
    try {
      const r = await fetch('/ai/stockman/state', { cache: 'no-store' });
      const body = await r.json();
      if (!r.ok || body.error) throw new Error(body.error || `HTTP ${r.status}`);
      draw(body);
      $('status').textContent = `Updated ${clock(Date.now())}; refreshes every ${POLL_MS / 1000} s.`;
      $('age').textContent = '';
    } catch (err) {
      $('engine').textContent = 'ENGINE OFFLINE'; $('engine').className = 'hud-chip crit'; $('live').className = 'hud-dot crit';
      $('status').textContent = `Cannot read the engine: ${String(err.message || err)}. Retrying.`;
      document.querySelectorAll('.hud-reveal:not(.in)').forEach(n => n.classList.add('in'));
    } finally { busy = false; }
  }
  poll();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
}());
