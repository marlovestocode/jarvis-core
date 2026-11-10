// Local event bridge for the wallpaper (spec §5). Binds 127.0.0.1 only.
//   GET  /ai/hello            { app: 'jarvis-core', version }  (port discovery)
//   GET  /ai/stream           SSE: "event: <type>\ndata: <json>"; current state + provider on connect
//   POST /ai/open[?mode=voice] 204; needs an Origin header (pages only)
// Host/Origin rules copied from sysmon-widget/src/main/bridge.js (okHost, okOrigin).
const http = require('node:http');

const HOST = '127.0.0.1';
const DEFAULT_PORTS = [47801, 47802, 47803, 47804, 47805, 47806];
const LEVEL_MIN_MS = 1000 / 30; // ≤ 30 Hz per source

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

async function startBridge({ bus, version, onOpen = () => {}, ports = DEFAULT_PORTS, pingMs = 15000 }) {
  const clients = new Set();
  let port = null;
  let lastState = { type: 'state', t: Date.now(), state: 'idle' };
  let lastProvider = null;
  const lastLevel = new Map(); // source -> time sent
  const BOOT_REPLAY_MS = 20000;
  let bootEvents = [];         // replayed to clients that connect during boot (the wallpaper often starts later)

  const okHost = h => h === `${HOST}:${port}` || h === `localhost:${port}`; // blocks DNS rebinding

  function write(res, ev) {
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
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
      if (!origin) { res.writeHead(403); return res.end(); }
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

  const ping = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, pingMs);
  ping.unref?.();

  function close() {
    clearInterval(ping);
    offBus();
    for (const res of clients) res.end();
    clients.clear();
    return new Promise(r => server.close(() => r()));
  }

  return { port, address: server.address().address, close, clients: () => clients.size };
}

module.exports = { startBridge, okOrigin, DEFAULT_PORTS };
