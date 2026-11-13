// The memory system as main.js wires it (W1 §3–§7): opens the cortex at <data>/cortex.db, imports memory.json once,
// and builds facts, the prompt block, chats, the extractor and the capture scheduler on it. Everything holds a live
// handle to the cortex, so when the embedding model appears (found at boot, or installed from Settings) the cortex
// is reopened with it in place and old nodes join the embed queue (E8). No model is ever pulled from here unless
// installEmbedder() is called, which Settings does only after the user's click and a confirm dialog.
const path = require('node:path');
const cortexLib = require('../cortex');
const { createOllamaEmbedder } = require('../cortex/embedder');
const { importMemoryJson } = require('./import');
const { createMemory } = require('./facts');
const { createMemoryBlock } = require('./block');
const { createChats } = require('./chats');
const { createExtractor } = require('./extract');
const { createCaptureScheduler } = require('./scheduler');
const { aboutText } = require('../tools/memory');

const TICK_MS = 5000, SLICE_MS = 8, DAY = 864e5;
const { localOrigin } = require('../net/services');

// POST /api/pull to the local Ollama only; resolves when the model is in (stream off)
async function ollamaPull({ host, model, fetch = globalThis.fetch }) {
  const h = localOrigin(host);
  if (!h) throw new Error('Ollama host must be local');
  const res = await fetch(h + '/api/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: false }), redirect: 'error', signal: AbortSignal.timeout(30 * 60e3) });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  return { ok: true };
}

function createMemorySystem({
  dataDir, log = () => {}, bus = null, sessions, getConfig = () => ({}), isIdle = () => true, notify = () => {}, complete,
  isUntrusted = () => false, now = Date.now,
  makeEmbedder = () => createOllamaEmbedder({ getConfig, model: getConfig()?.cortex?.embedModel || 'nomic-embed-text' }),
  pull = model => ollamaPull({ host: getConfig()?.ollama?.host, model }),
  openCortex = opts => cortexLib.open(opts),
}) {
  const file = path.join(dataDir, 'cortex.db');
  const model = () => getConfig()?.cortex?.embedModel || 'nomic-embed-text';
  const ref = { c: openCortex({ file, log, bus, embedder: null, isIdle, now }), embedder: null };
  // a stable handle: every property read goes to the cortex open right now
  const cortex = new Proxy({}, { get: (_, k) => { const v = ref.c[k]; return typeof v === 'function' ? v.bind(ref.c) : v; } });

  try { importMemoryJson({ cortex, file: path.join(dataDir, 'memory.json'), log }); } catch (err) { log('memory import failed: ' + err.message); }

  const memory = createMemory({ cortex });
  const chats = createChats({ cortex, sessions });
  const block = createMemoryBlock({ cortex, memory, getConfig });
  const extractor = createExtractor({ complete, memory, chats, isUntrusted });
  const scheduler = createCaptureScheduler({ sessions, extractor, chats, isIdle, getConfig, notify, log, now });

  let closed = false;
  // close first, then open: the old handle's close writes clean_close=1, the new open writes 0 and keeps crash detection on
  function reopen(embedder) {
    if (closed) return;
    try { ref.c.close(); } catch (err) { log('cortex close: ' + err.message); }
    ref.c = openCortex({ file, log, bus, embedder, isIdle, now });
    ref.embedder = embedder;
    log(`cortex: ${embedder ? 'embedding with ' + embedder.id : 'keyword recall only'}`);
  }

  // is the model there? then use it (one /api/tags call at boot; nothing is downloaded)
  async function findEmbedder() {
    const e = makeEmbedder();
    if (!e) return false;
    const st = await e.status().catch(() => ({ ok: false }));
    if (st.ok && !ref.embedder) reopen(e);
    return !!st.ok;
  }
  const ready = findEmbedder().catch(err => { log('embedder check failed: ' + err.message); return false; });

  let pulling = false;
  async function embedderStatus() {
    const s = ref.c.stats();
    return { model: model(), installed: !!ref.embedder, mode: s.mode, queue: s.queue, pulling };
  }
  async function installEmbedder() {
    if (ref.embedder) return { installed: true };
    if (pulling) return { installed: false, pulling: true };   // a second click while it downloads
    pulling = true;
    try { await pull(model()); } finally { pulling = false; }
    const ok = await findEmbedder();
    return { installed: ok };
  }

  let ticking = false;
  async function tick() {
    if (ticking || !isIdle()) return;
    ticking = true;
    try {
      await ref.c.consolidate.tick({ deadlineMs: SLICE_MS });
      await scheduler.tick();
    } catch (err) { log('memory tick failed: ' + err.message); } finally { ticking = false; }
  }
  let timer = null;
  function start() {
    scheduler.sweep();
    timer = setInterval(() => { tick(); }, TICK_MS);
    timer.unref?.();
  }

  function onChatRemoved(id) { chats.remove(id); scheduler.forget(id); }

  // self-check (checks.js): ok text, off (no embedding model: keyword recall still works), or a problem
  function check() {
    const h = ref.c.health(), s = ref.c.stats();
    if (!h.ok) return { level: 'bad', detail: h.readOnly ? 'the cortex is read-only (a migration failed)' : `the cortex is running in memory: ${h.quickCheck || 'cannot open ' + file}` };
    const age = h.lastBackupAt ? Math.floor((now() - h.lastBackupAt) / DAY) : null;
    const detail = `${s.nodes} nodes, ${s.edges} links, ${s.vectors} vectors; ${s.queue} waiting to be indexed; last backup ${age === null ? 'not yet' : age === 0 ? 'today' : age + ' days ago'}`;
    if (!ref.embedder) return { level: 'off', detail: `${model()} is not installed, keyword recall only (Settings, Memory, Install). ${detail}` };
    return { level: 'ok', detail: `${h.embedder}; ${detail}` };
  }

  function close() {
    closed = true;
    if (timer) clearInterval(timer);
    scheduler.abort();
    ref.c.close();
  }

  return {
    cortex, memory, chats, block, extractor, scheduler, ready,
    profile: ({ brief = false } = {}) => block.profile({ brief }),
    about: topic => aboutText(cortex, topic),
    embedderStatus, installEmbedder, tick, start, close, check, onChatRemoved,
    stats: () => { const s = ref.c.stats(); return { nodes: s.nodes, edges: s.edges, vectors: s.vectors, bytes: s.bytes, matrixBytes: s.matrixBytes, queue: s.queue }; },
    trim: () => ref.c.trim(),
  };
}

module.exports = { createMemorySystem, ollamaPull };
