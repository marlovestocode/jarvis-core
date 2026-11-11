// Link to the JARVIS YouTube Music extension: a tiny WebSocket server on 127.0.0.1:47830-47832.
// Only the extension may connect (Origin chrome-extension://<EXTENSION_ID>); web pages and other
// extensions are refused. With a secret, each side also proves it knows it before any command or play
// is accepted (challenge → hello+proof → auth+proof; the proofs name the port, so a relay on another port fails).
// JARVIS sends { id, cmd, args }; the extension answers { id, ok, result | error }.
const http = require('node:http');
const crypto = require('node:crypto');
const { EXTENSION_ID } = require('./ytmusic-id');
const { proof, same } = require('./link-key');

const HOST = '127.0.0.1';
const PORTS = [47830, 47831, 47832];
const MAX_FRAME = 4 * 1024 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---- minimal RFC 6455 framing (text, ping/pong, close; client frames are masked) ----
function frame(op, payload = Buffer.alloc(0)) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, payload]);
}

function createParser(onFrame) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = !!(buf[0] & 0x80), op = buf[0] & 0x0f, masked = !!(buf[1] & 0x80);
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_FRAME) throw new Error('frame too large');
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let data = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const k = buf.subarray(off, off + 4); data = Buffer.from(data.map((b, i) => b ^ k[i & 3])); }
      buf = buf.subarray(need);
      onFrame(fin, op, data);
    }
  };
}

function startYtMusicLink({ log = () => {}, ports = PORTS, extensionId = EXTENSION_ID, timeoutMs = 15000, onChange = () => {}, onPlay = () => {}, onReject = () => {}, secret = null, authMs = 5000 } = {}) {
  let rejected = 0, lastRejectLog = 0;   // a stale extension retries every few seconds: say it once, not every time
  let sock = null;            // the connected extension (one at a time; newest wins)
  let authed = false;         // the extension proved it knows the secret (always true when there is no secret)
  let challenge = null;
  let info = null;
  let nextId = 1;
  const pending = new Map();
  let port = null;

  function failAll(err) { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); } pending.clear(); }

  function attach(s, head) {
    if (sock) { try { sock.end(frame(8)); } catch { /* old one gone */ } }
    sock = s; info = null;
    authed = !secret;
    challenge = null;
    let authTimer = null;
    if (secret) {
      challenge = crypto.randomBytes(16).toString('hex');
      s.write(frame(1, Buffer.from(JSON.stringify({ type: 'challenge', nonce: challenge }))));
      authTimer = setTimeout(() => { if (sock === s && !authed) { log('ytmusic link: no valid proof, dropped'); s.destroy(); } }, authMs);
    }
    let text = [], textBytes = 0;
    const parse = createParser((fin, op, data) => {
      if (op === 8) { s.end(frame(8)); return; }
      if (op === 9) { s.write(frame(10, data)); return; }
      if (op === 10) return;
      if (op === 1 || op === 0) {
        text.push(data); textBytes += data.length;
        if (textBytes > MAX_FRAME) throw new Error('message too large');   // fragments of one message that never ends
        if (!fin) return;
        const msg = Buffer.concat(text).toString('utf8'); text = []; textBytes = 0;
        onMessage(msg);
      }
    });
    s.on('data', d => { try { parse(d); } catch (err) { log('ytmusic link:', err.message); s.destroy(); } });
    s.on('error', () => {});
    s.on('end', () => s.end());   // HTTP sockets are half-open: finish our side when the extension leaves
    s.on('close', () => {
      clearTimeout(authTimer);
      if (sock !== s) return;
      const was = authed;
      sock = null; info = null; authed = false;
      failAll(new Error('YouTube Music extension disconnected'));
      log('ytmusic link: extension disconnected');
      if (was) onChange(false);
    });
    if (head?.length) parse(head);
    if (!secret) { log('ytmusic link: extension connected'); onChange(true); }
  }

  function onMessage(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (secret && !authed) {
      // nothing but a valid hello is read until the extension has proven the key
      if (m.type !== 'hello' || typeof m.nonce !== 'string' || m.nonce.length > 64 || !same(m.proof, proof(secret, 'ext', port, challenge))) {
        rejected++;
        const legacy = m.type === 'hello' && typeof m.proof !== 'string';   // an extension from before the link key: it sends no proof at all
        if (Date.now() - lastRejectLog > 60000) {
          lastRejectLog = Date.now();
          log(legacy ? `ytmusic link: the extension is an old version (no link key); reload it in chrome://extensions, then paste the key from the tray menu (${rejected} attempts so far)` : `ytmusic link: the extension's link key does not match (${rejected} attempts so far); copy it again from the tray menu`);
          try { onReject({ legacy, count: rejected }); } catch { /* the app logs its own errors */ }
        }
        sock?.destroy(); return;
      }
      sock.write(frame(1, Buffer.from(JSON.stringify({ type: 'auth', proof: proof(secret, 'srv', port, challenge, m.nonce) }))));
      authed = true;
      info = { version: m.version };
      rejected = 0;
      log('ytmusic link: extension connected, version', m.version);
      onChange(true);
      return;
    }
    if (m.type === 'hello') { info = { version: m.version }; log('ytmusic link: extension version', m.version); return; }
    // finished plays from the extension's listening tracker (live, or a batch it kept while JARVIS was closed)
    if (m.type === 'play') { try { onPlay(m.event); } catch (err) { log('ytmusic link: play log:', err.message); } return; }
    if (m.type === 'plays' && Array.isArray(m.events)) { for (const e of m.events.slice(0, 500)) { try { onPlay(e); } catch (err) { log('ytmusic link: play log:', err.message); } } return; }
    if (m.type === 'ping') { sock?.write(frame(1, Buffer.from(JSON.stringify({ type: 'pong' })))); return; }
    if (!m.id || !pending.has(m.id)) return;
    const p = pending.get(m.id);
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'extension error'));
  }

  function request(cmd, args = {}, { timeout = timeoutMs } = {}) {
    if (!sock || !authed) return Promise.reject(Object.assign(new Error('The YouTube Music extension is not connected'), { code: 'NO_LINK' }));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('YouTube Music did not answer in time')); }, timeout);
      pending.set(id, { resolve, reject, timer });
      try { sock.write(frame(1, Buffer.from(JSON.stringify({ id, cmd, args })))); } catch (err) { clearTimeout(timer); pending.delete(id); reject(err); }
    });
  }

  const server = http.createServer((req, res) => { res.writeHead(426); res.end(); });
  server.on('upgrade', (req, s, head) => {
    const okHost = req.headers.host === `${HOST}:${port}` || req.headers.host === `localhost:${port}`;
    const okOrigin = req.headers.origin === `chrome-extension://${extensionId}`;
    const key = req.headers['sec-websocket-key'];
    if (req.url !== '/ytmusic' || !okHost || !okOrigin || !key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      s.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    s.setNoDelay(true);
    attach(s, head);
  });

  const started = (async () => {
    for (const p of ports) {
      try {
        await new Promise((res, rej) => { server.once('error', rej); server.listen(p, HOST, () => { server.off('error', rej); res(); }); });
        port = p;
        log(`ytmusic link: listening on ${HOST}:${p}`);
        return p;
      } catch (err) { if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err; }
    }
    throw new Error(`ytmusic link could not bind ${ports.join(', ')}`);
  })();
  started.catch(err => log('ytmusic link:', err.message));

  function close() {
    failAll(new Error('ytmusic link closed'));
    try { sock?.destroy(); } catch { /* gone */ }
    return new Promise(r => server.close(() => r()));
  }

  return { request, close, started, get connected() { return !!sock && authed; }, get info() { return info; }, get port() { return port; } };
}

module.exports = { startYtMusicLink, frame, createParser, PORTS };
