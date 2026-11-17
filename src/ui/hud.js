// HUD kit: tiny helpers shared by chat, settings and analytics. No libraries, no network.
// Motion is skipped (final values shown at once) when the user prefers reduced motion.
(function (root) {
  const NS = 'http://www.w3.org/2000/svg';
  const reduced = (() => { try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; } })();
  const raf = f => (root.requestAnimationFrame ? root.requestAnimationFrame(f) : setTimeout(() => f(Date.now()), 16));
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const sv = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

  // Count an element's text up to `to`. fmt(n) formats each frame; a non-number just shows fmt text as is.
  function countUp(el, to, { dur = 800, fmt = n => Math.round(n).toLocaleString() } = {}) {
    const end = num(to);
    if (end === null) { el.textContent = '–'; return; }
    if (reduced || dur <= 0) { el.textContent = fmt(end); return; }
    const from = num(parseFloat(String(el.dataset && el.dataset.v))) ?? 0;
    if (el.dataset) el.dataset.v = String(end);
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (end - from) * e);
      if (k < 1) raf(step); else el.textContent = fmt(end);
    };
    raf(step);
  }

  // Staggered entrance: every .hud-reveal inside `rootEl` gets .in, 45 ms apart.
  function reveal(rootEl) {
    const list = [...(rootEl || document).querySelectorAll('.hud-reveal:not(.in)')];
    list.forEach((el, i) => {
      if (reduced) { el.classList.add('in'); return; }
      el.style.transitionDelay = Math.min(i, 24) * 45 + 'ms';
      raf(() => raf(() => el.classList.add('in')));
    });
  }

  // Ring gauge, 0..100. Colour class from thresholds unless given.
  function ring(value, { size = 44, cls = '', good = 95, warn = 80 } = {}) {
    const v = num(value), pct = v === null ? 0 : Math.max(0, Math.min(100, v));
    const r = 18, C = 2 * Math.PI * r;
    const state = cls || (v === null ? 'none' : pct >= good ? 'ok' : pct >= warn ? 'warn' : 'crit');
    const svg = sv('svg', { viewBox: '0 0 44 44', width: size, height: size, class: 'hud-ring ' + state, role: 'img', 'aria-label': v === null ? 'no data' : Math.round(pct) + ' percent' });
    svg.append(sv('circle', { cx: 22, cy: 22, r, class: 'hud-ring-track' }));
    const bar = sv('circle', { cx: 22, cy: 22, r, class: 'hud-ring-bar', transform: 'rotate(-90 22 22)', 'stroke-dasharray': C.toFixed(2) });
    bar.setAttribute('stroke-dashoffset', C.toFixed(2));
    svg.append(bar);
    const apply = () => bar.setAttribute('stroke-dashoffset', (C * (1 - pct / 100)).toFixed(2));
    if (reduced) apply(); else raf(() => raf(apply));
    return svg;
  }

  // Sparkline from numbers (nulls make gaps). Always returns an svg, empty when there is nothing to draw.
  function spark(values, { w = 100, h = 24, cls = '' } = {}) {
    const svg = sv('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: 'hud-spark ' + cls, 'aria-hidden': 'true', preserveAspectRatio: 'none' });
    const vals = (values || []).map(num), real = vals.filter(v => v !== null);
    if (!real.length) return svg;
    const lo = Math.min(...real), hi = Math.max(...real), span = hi - lo || 1, n = vals.length;
    const X = i => (n <= 1 ? w / 2 : 2 + (w - 4) * i / (n - 1));
    const Y = v => (hi === lo ? h / 2 : h - 2 - (h - 4) * (v - lo) / span);
    let d = '', pen = false;
    vals.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`; pen = true; });
    svg.append(sv('path', { d, class: 'hud-spark-line' }));
    return svg;
  }

  const HUD = { countUp, reveal, ring, spark, reduced };
  root.HUD = HUD;
  if (typeof module !== 'undefined' && module.exports) module.exports = HUD;
})(typeof window !== 'undefined' ? window : globalThis);
