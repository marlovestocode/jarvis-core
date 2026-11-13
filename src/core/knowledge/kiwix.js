// Offline Wikipedia: one kiwix-serve bound to 127.0.0.1 serves the ZIM in the library folder (config library.dir, default C:\JarvisData\library).
// Local only (loopback), so it does not go through the internet gate. Missing library → available() false
// and the app works without it. A crash restarts the server once.
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { decodeEntities, stripHtml } = require('./feed-parser');

const ZIM_RE = /^wikipedia_en_all_nopic_\d{4}-\d{2}\.zim$/;

function pickZim(files) {
  return (files || []).filter(f => ZIM_RE.test(f)).sort().at(-1) || null;
}

function parseSearch(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<li>([\s\S]*?)<\/li>/gi)) {
    const a = m[1].match(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const cite = m[1].match(/<cite>([\s\S]*?)<\/cite>/i);
    out.push({ title: decodeEntities(stripHtml(a[2])), path: decodeEntities(a[1]), snippet: cite ? decodeEntities(stripHtml(cite[1])) : '' });
  }
  return out;
}

function createKiwix({
  exe, zimDir, port = 47820, address = '127.0.0.1',
  spawn = childProcess.spawn, fetch: doFetch = (...a) => globalThis.fetch(...a),
  exists = p => fs.existsSync(p), readdir = d => { try { return fs.readdirSync(d); } catch { return []; } }, stat = p => fs.statSync(p),
  startTimeoutMs = 60000, log = () => {},
}) {
  if (address !== '127.0.0.1') throw new Error('kiwix-serve must bind 127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  let proc = null, starting = null, starts = 0, gaveUp = false;
  const dirOf = () => (typeof zimDir === 'function' ? zimDir() : zimDir);   // a function follows config changes
  const zim = () => pickZim(readdir(dirOf()));
  const book = () => (zim() || '').replace(/\.zim$/, '');
  const available = () => !!exe && exists(exe) && !!zim();

  async function waitUp(kid) {
    const t0 = Date.now();
    while (Date.now() - t0 < startTimeoutMs) {
      if (proc !== kid) break;
      try { const r = await doFetch(base + '/', { signal: AbortSignal.timeout(2000) }); if (r) return; } catch { /* not yet */ }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('offline library server did not start');
  }

  function ensure() {
    if (!available()) return Promise.reject(new Error('The offline library is not installed'));
    if (gaveUp) return Promise.reject(new Error('The offline library server stopped; restart JARVIS to retry'));
    if (proc && !starting) return Promise.resolve();
    if (starting) return starting;
    starts++;
    const kid = spawn(exe, ['--address', '127.0.0.1', '--port', String(port), path.join(dirOf(), zim())], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc = kid;
    kid.stdout?.on?.('data', () => {});
    kid.stderr?.on?.('data', () => {});
    const gone = why => {
      if (proc !== kid) return;
      proc = null;
      log(`kiwix-serve ${why}`);
      if (starts >= 2) gaveUp = true;
    };
    kid.on('exit', code => gone(`exited (${code})`));
    kid.on('error', err => gone('error: ' + err.message));
    starting = waitUp(kid).then(() => { starting = null; }, err => { starting = null; try { kid.kill(); } catch { /* gone */ } throw err; });
    return starting;
  }

  async function get(p) {
    await ensure();
    const r = await doFetch(base + p, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`offline library HTTP ${r.status}`);
    return r.text();
  }

  async function search(q, n = 8) {
    const html = await get(`/search?books.name=${encodeURIComponent(book())}&pattern=${encodeURIComponent(String(q).trim())}&pageLength=${n}`);
    return parseSearch(html).slice(0, n);
  }

  function article(p) {
    if (typeof p !== 'string' || !p.startsWith('/content/') || p.includes('..')) return Promise.reject(new Error('bad article path'));
    return get(p);
  }
  const articleByTitle = title => article(`/content/${book()}/A/${encodeURIComponent(String(title).trim().replace(/ /g, '_'))}`);

  async function info() {
    const file = zim();
    const out = { installed: available(), file, path: file ? path.join(dirOf(), file) : dirOf(), sizeBytes: 0, articles: null, running: !!proc && !starting };
    if (file) { try { out.sizeBytes = stat(path.join(dirOf(), file)).size; } catch { /* gone */ } }
    if (out.installed) {
      try { const x = await get('/catalog/v2/entries'); const m = x.match(/<articleCount>(\d+)<\/articleCount>/); if (m) out.articles = Number(m[1]); } catch { /* not running */ }
      out.running = !!proc && !starting;
    }
    return out;
  }

  return {
    available, search, article, articleByTitle, info,
    warm: () => ensure().then(() => true, () => false),
    close() { if (proc) { const k = proc; proc = null; try { k.kill(); } catch { /* gone */ } } },
  };
}

module.exports = { createKiwix, parseSearch, pickZim };
