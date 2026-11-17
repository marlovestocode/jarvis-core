'use strict';
// Morning brief: one spoken text built from the read-only tools' own result text (no model prose).
// Every part is optional: a tool that fails, times out or has nothing to say is left out.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const greeting = d => {
  const h = d.getHours();
  const hello = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return `${hello}. It is ${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}.`;
};

const one = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// "Battery: 80%, charging" out of connectivity_status; nothing for a desktop or an unreadable battery
function batteryPart(text) {
  const m = /Battery: ([^.]*(?:\.\d+[^.]*)?)(?:\.|$)/.exec(one(text));
  if (!m || /unavailable|no battery/i.test(m[1])) return '';
  return `Battery: ${m[1].trim()}.`;
}

// "Open windows: chrome: Title; code: Title." → "Open apps: chrome, code." (titles are untrusted text and never read out)
function appsPart(text) {
  const m = /^Open windows: (.*?)\.?$/.exec(one(text));
  if (!m) return '';
  const apps = [...new Set(m[1].split(';').map(x => x.split(':')[0].trim()).filter(Boolean))].slice(0, 5);
  return apps.length ? `Open apps: ${apps.join(', ')}.` : '';
}

function createBrief({ tools, getConfig, now = () => new Date(), timeoutMs = 4000 }) {
  const ctx = () => ({ turn: { source: 'brief', tainted: false } });
  async function part(name, args, shape) {
    let timer;
    try {
      const r = await Promise.race([
        Promise.resolve().then(() => tools.run(name, args, ctx())),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out')), timeoutMs); }),
      ]);
      if (!r?.ok) return '';
      const text = shape(r.text);
      return one(text) ? text.trim() : '';
    } catch { return ''; } finally { clearTimeout(timer); }
  }
  async function build() {
    const count = getConfig().brief?.newsCount ?? 3;
    const parts = await Promise.all([
      part('get_weather', {}, t => t),
      part('list_timers', {}, t => (/^No timers/i.test(one(t)) ? '' : t)),
      part('news_headlines', { count }, t => t),
      part('connectivity_status', {}, batteryPart),
      part('list_windows', {}, appsPart),
    ]);
    return [greeting(now()), ...parts].filter(Boolean).join(' ');
  }
  return { build };
}

module.exports = { createBrief };
