// Local event bridge for the wallpaper (spec §5). Binds 127.0.0.1 only.
//   GET  /ai/hello            { app: 'jarvis-core', version }  (port discovery)
//   GET  /ai/stream           SSE: "event: <type>\ndata: <json>"; current state + provider on connect
//   POST /ai/open[?mode=voice] 204; foreign Origins refused (the wallpaper sends none)
//   GET  /ai/brain[?max=&focus=1,2]   the shape of the cortex (ids, kinds, weights, links), no text
//   GET  /ai/brain/labels?ids=1,2     a few words per node: only when the user allows it, and only to a page with no Origin
//                                     or file:// (never a localhost web page or a sandboxed frame, which sends Origin: null)
// Host/Origin rules copied from sysmon-widget/src/main/bridge.js (okHost, okOrigin).
const http = require('node:http');

const HOST = '127.0.0.1';
const DEFAULT_PORTS = [47801, 47802, 47803, 47804, 47805, 47806];
const LEVEL_MIN_MS = 1000 / 30; // ≤ 30 Hz per source
const CLIENT_MAX_BUFFER = 1024 * 1024;   // bytes waiting for one client; over this it is not reading and is dropped

const okOrigin = o => !o || o === 'null' || o === 'file://' || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o);

function listen(server, port) {
  return new Promise((res, rej) => {
    const onErr = err => { server.off('listening', onOk); rej(err); };
    const onOk = () => { server.off('error', onErr); res(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, HOST);
  });
}

const okLabelOrigin = o => !o || o === 'file://';
const idList = v => String(v || '').split(',').map(Number).filter(Number.isInteger).slice(0, 48);

// dashboard = { query(opts) → summary, files: { html, js, css } } | null: the analytics page (src/ui/dashboard) and its numbers, same-origin only
// brain = { view(opts), labels(ids), labelsOn(), skills() } | null: the cortex picture for the wallpaper (skills() = the skill groups, so tools can fire their neuron)
async function startBridge({ bus, version, onOpen = () => {}, ports = DEFAULT_PORTS, pingMs = 15000, clientMaxBuffer = CLIENT_MAX_BUFFER, brain = null, dashboard = null }) {
  const clients = new Set();
  let dropped = 0;
  let port = null;
  let lastState = { type: 'state', t: Date.now(), state: 'idle' };
  let lastProvider = null;
  const lastLevel = new Map(); // source -> time sent
  const BOOT_REPLAY_MS = 20000;
  let bootEvents = [];         // replayed to clients that connect during boot (the wallpaper often starts later)

  const okHost = h => h === `${HOST}:${port}` || h === `localhost:${port}`; // blocks DNS rebinding

  // A stalled client (a paused wallpaper) would make Node hold every event for it in memory.
  // It is dropped instead; EventSource reconnects (retry: 3000) and gets the current state again.
  function send(res, text) {
    if (res.writableLength > clientMaxBuffer) { clients.delete(res); dropped++; res.destroy(); return; }
    res.write(text);
  }
  // Any page on localhost (or a sandboxed frame, which sends Origin: null) may read this stream, so the words of the
  // conversation never go out on it: the wallpaper draws a spark per token, not the text.
  // A tool event keeps its name and phase; its label (and args) quote what the user asked for, so they stay on the bus for the chat window.
  function publicEvent(ev) {
    if (ev.type === 'token' && 'text' in ev) return { ...ev, text: '' };
    if (ev.type === 'tool') { const { label, args, ...rest } = ev; return rest; }
    return ev;
  }
  function write(res, ev) {
    const out = publicEvent(ev);
    send(res, `event: ${out.type}\ndata: ${JSON.stringify(out)}\n\n`);
  }

  const offBus = bus.on('*', ev => {
    if (ev.type === 'state') lastState = ev;
    if (ev.type === 'provider') lastProvider = ev;
    if (ev.type === 'boot') bootEvents.push(ev);
    if (ev.type === 'level') {
      const now = Date.now();
      const src = ev.source || 'mic';
      if (now - (lastLevel.get(src) ?? -Infinity) < LEVEL_MIN_MS) return;
      lastLevel.set(src, now);
    }
    for (const res of clients) write(res, ev);
  });

  function handle(req, res) {
    const origin = req.headers.origin;
    if (!okHost(req.headers.host) || !okOrigin(origin)) { res.writeHead(403); return res.end(); }
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    const [url, query = ''] = req.url.split('?');

    if (req.method === 'POST' && url === '/ai/open') {
      // No Origin is allowed: Chromium sends none for a POST from a file:// page (the wallpaper).
      // Web pages always send one on cross-site POSTs, and foreign origins are refused above.
      const mode = new URLSearchParams(query).get('mode') === 'voice' ? 'voice' : 'chat';
      res.writeHead(204, cors); res.end();
      try { onOpen(mode); } catch { /* the app logs its own errors */ }
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405, cors); return res.end(); }

    if (url === '/ai/hello') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ app: 'jarvis-core', version }));
    }
    if (url === '/ai/brain' && brain) {
      const q = new URLSearchParams(query);
      let body;
      try { body = brain.view({ max: q.get('max'), focus: idList(q.get('focus')) }); } catch { res.writeHead(503, cors); return res.end(); }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      let skills = [];
      try { skills = brain.skills?.() || []; } catch { /* the picture works without them */ }
      return res.end(JSON.stringify({ ...body, labels: !!brain.labelsOn?.(), skills }));
    }
    if (url === '/ai/brain/labels' && brain) {
      if (!brain.labelsOn?.() || !okLabelOrigin(origin)) { res.writeHead(403, cors); return res.end(); }
      let body;
      try { body = brain.labels(idList(new URLSearchParams(query).get('ids'))); } catch { res.writeHead(503, cors); return res.end(); }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(body));
    }
    if (dashboard && (url === '/ai/dashboard' || url === '/ai/dashboard.js' || url === '/ai/dashboard.css' || url === '/ai/metrics')) {
      // only this page itself (no Origin, or its own origin) may read the numbers: another localhost page cannot
      if (origin && origin !== `http://${HOST}:${port}` && origin !== `http://localhost:${port}`) { res.writeHead(403, cors); return res.end(); }
      const q = new URLSearchParams(query);
      if (url === '/ai/metrics') {
        const RANGE = { hour: 3600e3, day: 864e5, week: 7 * 864e5, month: 30 * 864e5 };
        const to = Date.now(), span = RANGE[q.get('range')] || RANGE.day;
        const pick = k => { const v = q.get(k); return v && v.length <= 64 ? v : null; };
        let body;
        try { body = dashboard.query({ from: to - span, to, group: pick('group'), tool: pick('tool'), source: pick('source') }); } catch { res.writeHead(503, cors); return res.end(); }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(body));
      }
      const asset = url === '/ai/dashboard' ? ['text/html; charset=utf-8', dashboard.files.html] : url === '/ai/dashboard.js' ? ['text/javascript; charset=utf-8', dashboard.files.js] : ['text/css; charset=utf-8', dashboard.files.css];
      res.writeHead(200, { 'Content-Type': asset[0], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      return res.end(asset[1]);
    }
    if (url === '/ai/stream') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      write(res, lastState);
      if (lastProvider) write(res, lastProvider);
      bootEvents = bootEvents.filter(e => Date.now() - e.t < BOOT_REPLAY_MS);
      for (const e of bootEvents) write(res, e);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404, cors); res.end();
  }

  const server = http.createServer(handle);
  let bound = false;
  let lastErr;
  for (const p of ports) {
    try {
      port = p;
      await listen(server, p);
      bound = true;
      break;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') break;
    }
  }
  if (!bound) {
    offBus();
    throw new Error(`bridge could not bind any port (${ports.join(', ')}): ${lastErr?.code || lastErr?.message}`);
  }

  const ping = setInterval(() => { for (const res of clients) send(res, ': ping\n\n'); }, pingMs);
  ping.unref?.();

  function close() {
    clearInterval(ping);
    offBus();
    for (const res of clients) res.end();
    clients.clear();
    return new Promise(r => server.close(() => r()));
  }

  return { port, address: server.address().address, close, clients: () => clients.size, stats: () => ({ clients: clients.size, dropped, capBytes: clientMaxBuffer }) };
}

module.exports = { startBridge, okOrigin, okLabelOrigin, DEFAULT_PORTS };
