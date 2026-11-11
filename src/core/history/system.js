// Wave 2 as main.js wires it (W2 §5–§7, plan E17, E18): the listening log, the PC-action log, the YouTube Music undo
// journal and playlist mirror, the tool history and taste, all on the cortex. getCortex() is read on every use, so this
// can be built before the cortex opens (main.js keeps its construction order) and follows a reopen. start() runs the
// one-time imports: actions and the journal at once (small), the music log in time slices that yield to the event
// loop between them, then retention (now and every 6 h). Nothing here downloads anything or touches the network.
const fs = require('node:fs');
const path = require('node:path');
const { createPlayLog } = require('../music/log');
const { createMusicImport } = require('../music/import');
const { createTaste } = require('../music/taste');
const { createActionLog, importActionsLog } = require('../pc/actions-log');
const { createJournalStore, importYtmUndo } = require('../media/ytjournal');
const { createPlaylistMirror } = require('../media/mirror');
const { createToolHistory } = require('../self/tool-history');

const RETAIN_MS = 6 * 3600e3;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function createHistorySystem({ getCortex, dataDir, getConfig = () => ({}), log = () => {}, now = Date.now, sliceMs = 50, chunkLines = 2000 }) {
  // every property read goes to the cortex open right now
  const cortex = new Proxy({}, { get: (_, k) => { const c = getCortex(); const v = c[k]; return typeof v === 'function' ? v.bind(c) : v; } });

  const playLog = createPlayLog({ cortex, getConfig, now, log });
  const actionLog = createActionLog({ cortex, now, log });
  const journal = createJournalStore({ cortex });
  const mirror = createPlaylistMirror({ cortex, now });
  const toolHistory = createToolHistory({ cortex, now });
  const taste = createTaste({ cortex, playLog, now });

  const file = name => path.join(dataDir, name);
  const result = { plays: null, actions: null, edits: null };
  let stopped = false, timer = null, importer = null, done;
  const imported = new Promise(r => { done = r; });

  function retain() {
    try {
      const a = actionLog.prune(), t = toolHistory.prune();
      if (a || t) log(`history: retention dropped ${plural(a, 'old action')} and ${plural(t, 'old tool event')}`);
    } catch (err) { log('history retention failed: ' + err.message); }
  }

  function slice() {
    if (stopped) return;
    const r = importer.step({ deadlineMs: sliceMs });
    if (!r.done) { setImmediate(slice); return; }
    result.plays = r.imported;
    retain();
    timer = setInterval(retain, RETAIN_MS);
    timer.unref?.();
    done();
  }

  function start() {
    stopped = false;
    try { result.actions = importActionsLog({ cortex, file: file('actions.log'), log, now }).imported; } catch (err) { log('actions import failed: ' + err.message); }
    try { result.edits = importYtmUndo({ cortex, file: file('ytm-undo.json'), log, now }).imported; } catch (err) { log('ytm undo import failed: ' + err.message); }
    try {
      importer = createMusicImport({ cortex, file: file('music-plays.jsonl'), playLog, log, now, chunkLines });
      if (!cortex.meta.get('import_music') && fs.existsSync(file('music-plays.jsonl'))) { playLog.importing.active = true; playLog.importing.pct = 0; }
      setImmediate(slice);
    } catch (err) { log('music import failed to start: ' + err.message); done(); }
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  // self-check (checks.js): import state and what is logged
  function check() {
    try {
      const plays = playLog.count(), actions = cortex.event.count({ kind: 'action' }), tools = cortex.event.count({ kind: 'tool' });
      const parts = [];
      if (playLog.importing.active) parts.push(`importing music ${playLog.importing.pct || 0}%`);
      const did = [result.plays && plural(result.plays, 'play'), result.actions && plural(result.actions, 'action'), result.edits && plural(result.edits, 'playlist edit')].filter(Boolean);
      if (did.length) parts.push(`imported ${did.join(', ')} this start`);
      parts.push(`${plural(plays, 'play')}, ${plural(actions, 'action')}, ${plural(tools, 'tool call')} logged`);
      return { level: 'ok', detail: parts.join('; ') };
    } catch (err) {
      return { level: 'bad', detail: 'history unavailable: ' + err.message };
    }
  }

  return {
    playLog, actionLog, journal, mirror, toolHistory, taste, imported, start, stop, check,
    stats: () => playLog.stats(),
    trim: () => playLog.trim(),
  };
}

module.exports = { createHistorySystem };
