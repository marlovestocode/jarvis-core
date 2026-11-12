// Proactive speech: JARVIS speaks without being asked (timers today; later sysmon thresholds, builds).
// Rules (config.proactive): never talks over the user (held while listening/thinking/speaking, delivered
// on idle), quiet hours and Do-not-disturb give a notification only, at most one spoken item per
// minGapSec, alarm > timer > reminder > info, duplicates collapse. Each item: one notification, one
// history entry tagged proactive:true, and when allowed a chime plus speech. A cut or failed speech
// is not repeated. Monitor items (push({ monitor: true })) also drop the same key within cooldownMin (or the
// item's cooldownMs) and fall back to notification only past maxPerHour spoken; timers are never capped.
// isBusy() (e.g. a pending confirmation) holds speech like the state flag does and is re-polled every 2 s.
// speak(text) → Promise<boolean> (false: TTS missing, busy or cut by barge-in); notify(title, body); chime();
// appendHistory({ role, content, proactive }).
const PRIORITY = { alarm: 4, timer: 3, reminder: 2, info: 1 };
const BUSY = new Set(['listening', 'thinking', 'speaking']);
const TITLES = { alarm: 'Alarm', timer: 'Timer done', reminder: 'Reminder', info: 'JARVIS' };

function clock(t) {
  const d = new Date(t);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}

// the words for a fired timer event
function timerText({ kind, label = '', due, missed }) {
  if (missed) {
    if (kind === 'alarm') return `While I was off, your ${clock(due)} ${label ? label + ' ' : ''}alarm went off.`;
    if (kind === 'reminder') return `While I was off, a reminder came due: ${label}.`;
    return `While I was off, your ${label ? label + ' ' : ''}timer finished.`;
  }
  if (kind === 'alarm') return `It's ${clock(due)}. Your ${label ? label + ' ' : ''}alarm.`;
  if (kind === 'reminder') return `Reminder: ${label}.`;
  return `Your ${label ? label + ' ' : ''}timer is done.`;
}

const minutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
function inQuiet(cfg, t) {
  const s = minutes(cfg.quietStart), e = minutes(cfg.quietEnd);
  if (s === e) return false;
  const d = new Date(t), n = d.getHours() * 60 + d.getMinutes();
  return s < e ? n >= s && n < e : n >= s || n < e;
}

function createProactiveEngine({ bus, getConfig, speak, chime = () => {}, notify = () => {}, appendHistory = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {}, isBusy = () => false }) {
  const queue = [];   // { kind, text, key, at }
  let busy = false;
  let delivering = false;
  let lastSpoke = -Infinity;
  let wait = null;
  const delivered = new Map();   // monitor key -> last delivery time
  let spokenAt = [];             // monitor items spoken in the last hour
  let briefingFn = null;
  const offs = [];

  const cfg = () => getConfig().proactive;
  const safeIsBusy = () => { try { return !!isBusy(); } catch { return false; } };
  const held = () => busy || safeIsBusy();
  const record = item => {
    try { notify(item.monitor ? 'JARVIS' : TITLES[item.kind] || 'JARVIS', item.text); } catch (err) { log(`notification failed: ${err.message}`); }
    try { appendHistory({ role: 'assistant', content: item.text, proactive: true }); } catch (err) { log(`proactive history failed: ${err.message}`); }
  };

  function push({ kind = 'info', text, key, monitor = false, cooldownMs } = {}) {
    if (!text) return;
    const item = { kind: PRIORITY[kind] ? kind : 'info', text: String(text), key: key || `${kind}:${text}`, at: now(), monitor: !!monitor };
    const c = cfg();
    if (!c.enabled || c.dnd || inQuiet(c, item.at)) { record(item); return; }   // silent: notification only
    if (queue.some(q => q.key === item.key)) return;
    if (item.monitor) {
      for (const [k, d] of delivered) if (item.at - d.at >= d.ms) delivered.delete(k);
      const last = delivered.get(item.key);
      if (last) return;
      item.cooldownMs = cooldownMs ?? (c.cooldownMin ?? 15) * 60000;
    }
    queue.push(item);
    queue.sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind] || a.at - b.at);
    pump();
  }

  function pump() {
    if (delivering) return;
    // the cap is checked here, not at push: items queued while held must not slip past it
    while (queue.length && queue[0].monitor) {
      spokenAt = spokenAt.filter(t => now() - t < 3.6e6);
      if (spokenAt.length < (cfg().maxPerHour ?? 6)) break;
      record(queue.shift());   // over the cap: notification only
    }
    if (!queue.length) return;
    if (held()) {
      if (!busy && wait === null) wait = setTimer(() => { wait = null; pump(); }, 2000);   // no idle event follows a cleared confirm
      return;
    }
    const gap = cfg().minGapSec * 1000 - (now() - lastSpoke);
    if (gap > 0) {
      if (wait === null) wait = setTimer(() => { wait = null; pump(); }, gap);
      return;
    }
    deliver(queue.shift());
  }

  async function deliver(item) {
    delivering = true;
    lastSpoke = now();
    if (item.monitor) delivered.set(item.key, { at: lastSpoke, ms: item.cooldownMs });
    try {
      if (cfg().chime) chime();
      // false or a throw: TTS missing, the user got busy, or barge-in cut it. The notification below
      // is then the only delivery; the item is never re-queued.
      if ((await speak(item.text)) === true) { if (item.monitor) spokenAt.push(now()); }
      else log('proactive item not spoken, notification only');
    } catch (err) { log(`proactive speech failed: ${err.message}`); }
    record(item);
    delivering = false;
    pump();
  }

  offs.push(bus.on('timer', ev => push({ kind: ev.kind, text: timerText(ev), key: `timer:${ev.id}` })));
  offs.push(bus.on('state', ev => {
    busy = BUSY.has(ev.state);
    if (!busy) pump();
  }));

  // morning briefing hook: a later feature sets the content provider; run() speaks what it returns
  const briefing = {
    set(fn) { briefingFn = typeof fn === 'function' ? fn : null; },
    async run() {
      if (!briefingFn) return;
      const text = await briefingFn();
      if (text) push({ kind: 'info', text, key: 'briefing' });
    },
  };

  function stop() {
    offs.forEach(off => off());
    if (wait !== null) clearTimer(wait);
    wait = null;
    queue.length = 0;
  }

  return { push, briefing, stop, get pending() { return queue.length; } };
}

module.exports = { createProactiveEngine, timerText, inQuiet };
