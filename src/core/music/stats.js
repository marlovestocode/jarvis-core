// Listening statistics from the play log. Pure functions over an array of plays (see log.js);
// every report returns { text } for the model plus the numbers in `data`, so a UI can reuse them.
const DAY = 86400000;
const SESSION_GAP = 30 * 60 * 1000;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : 0);
const hrs = sec => Math.round((sec / 3600) * 10) / 10;
const mins = sec => Math.round(sec / 60);
const r1 = n => Math.round(n * 10) / 10;
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const monthKey = t => dayKey(t).slice(0, 7);
const fmtDate = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtHour = h => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
const key = p => p.videoId;
const label = p => `${p.title}${p.artist ? ` - ${p.artist}` : ''}`;

// "today" | "yesterday" | "week" | "month" | "year" | "all" | a number of days | "last_30_days" → { from, to, label }
function periodRange(period = 'month', now = Date.now()) {
  const p = String(period).toLowerCase().replace(/[\s-]+/g, '_');
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const start = d0.getTime();
  if (p === 'today') return { from: start, to: now, label: 'today' };
  if (p === 'yesterday') return { from: start - DAY, to: start, label: 'yesterday' };
  if (p === 'week' || p === 'this_week' || p === 'last_week') return { from: now - 7 * DAY, to: now, label: 'the last 7 days' };
  if (p === 'month' || p === 'this_month' || p === 'last_month') return { from: now - 30 * DAY, to: now, label: 'the last 30 days' };
  if (p === 'year' || p === 'this_year') return { from: now - 365 * DAY, to: now, label: 'the last 12 months' };
  if (p === 'all' || p === 'all_time' || p === 'ever') return { from: 0, to: now, label: 'all time' };
  const n = Number(p.replace(/^last_|_days?$/g, ''));
  if (Number.isFinite(n) && n > 0) return { from: now - Math.min(n, 3650) * DAY, to: now, label: `the last ${Math.round(n)} days` };
  return { from: now - 30 * DAY, to: now, label: 'the last 30 days' };
}

const within = (plays, r) => plays.filter(p => p.at >= r.from && p.at <= r.to);

function group(plays, keyFn, make) {
  const m = new Map();
  for (const p of plays) {
    const k = keyFn(p); if (!k) continue;
    let g = m.get(k); if (!g) { g = make(p); g.key = k; m.set(k, g); }
    g.plays++; g.sec += p.listenedSec;
    if (p.outcome === 'finished') g.finished++; else if (p.outcome === 'skipped') g.skipped++;
    if (p.quickSkip) g.quick++;
    g.last = Math.max(g.last, p.at); g.first = Math.min(g.first, p.at);
  }
  return [...m.values()];
}
const newGroup = extra => p => ({ plays: 0, sec: 0, finished: 0, skipped: 0, quick: 0, first: Infinity, last: 0, ...extra(p) });
const byArtist = plays => group(plays.flatMap(p => (p.artists.length ? p.artists : ['Unknown']).map(a => ({ ...p, _a: a }))), p => p._a, newGroup(p => ({ name: p._a })));
const byTrack = plays => group(plays, key, newGroup(p => ({ name: p.title, artist: p.artist })));

// sessions: plays less than 30 minutes apart (end of one to start of the next)
function sessions(plays) {
  const out = [];
  let cur = null;
  for (const p of [...plays].sort((a, b) => a.at - b.at)) {
    const end = p.at + p.listenedSec * 1000;
    if (cur && p.at - cur.end <= SESSION_GAP) { cur.plays.push(p); cur.end = Math.max(cur.end, end); cur.sec += p.listenedSec; }
    else { cur = { start: p.at, end, sec: p.listenedSec, plays: [p] }; out.push(cur); }
  }
  return out;
}

const reports = {
  overview(plays, r) {
    const n = plays.length;
    if (!n) return { text: `No plays logged for ${r.label}.`, data: {} };
    const sec = plays.reduce((a, p) => a + p.listenedSec, 0);
    const days = new Set(plays.map(p => dayKey(p.at)));
    const fin = plays.filter(p => p.outcome === 'finished').length, sk = plays.filter(p => p.outcome === 'skipped').length, qs = plays.filter(p => p.quickSkip).length;
    const known = plays.filter(p => p.outcome !== 'unknown').length;
    const artists = new Set(plays.flatMap(p => p.artists)), tracks = new Set(plays.map(key));
    const hour = new Array(24).fill(0), wd = new Array(7).fill(0);
    for (const p of plays) { const d = new Date(p.at); hour[d.getHours()] += p.listenedSec; wd[d.getDay()] += p.listenedSec; }
    const peakH = hour.indexOf(Math.max(...hour)), peakD = wd.indexOf(Math.max(...wd));
    const night = hour.slice(0, 5).reduce((a, b) => a + b, 0);
    const ss = sessions(plays), longest = ss.reduce((a, s) => (s.sec > (a?.sec || 0) ? s : a), null);
    const liked = new Set(plays.filter(p => p.liked).map(key)).size;
    const topA = byArtist(plays).sort((a, b) => b.sec - a.sec)[0];
    const data = { plays: n, hours: hrs(sec), activeDays: days.size, uniqueTracks: tracks.size, uniqueArtists: artists.size, finishedPct: pct(fin, known), skipPct: pct(sk, known), quickSkipPct: pct(qs, known), sessions: ss.length };
    const text = [
      `Listening, ${r.label}: ${n} plays, ${hrs(sec)} hours over ${days.size} active days (${r1(sec / 3600 / days.size)} h per active day).`,
      `${tracks.size} different tracks by ${artists.size} artists. Finished ${data.finishedPct}%, skipped ${data.skipPct}% (${data.quickSkipPct}% within 30 s), the rest partly heard.`,
      `Most time on ${topA?.name} (${hrs(topA?.sec || 0)} h, ${topA?.plays} plays). Peak hour ${fmtHour(peakH)}, busiest weekday ${DAYS[peakD]}. ${pct(night, sec)}% of listening is between midnight and 5am.`,
      `${ss.length} sessions, average ${mins(ss.reduce((a, s) => a + s.sec, 0) / ss.length)} min; longest ${mins(longest.sec)} min on ${fmtDate(longest.start)} (${longest.plays.length} tracks).`,
      `${liked} tracks liked while playing.`,
    ].join('\n');
    return { text, data };
  },

  top_artists(plays, r, { limit = 10, by = 'time' } = {}) {
    const g = byArtist(plays).sort((a, b) => (by === 'plays' ? b.plays - a.plays : b.sec - a.sec)).slice(0, limit);
    const total = plays.reduce((a, p) => a + p.listenedSec, 0);
    return { text: `Top artists by ${by === 'plays' ? 'plays' : 'listening time'}, ${r.label}:\n` + g.map((a, i) => `${i + 1}. ${a.name}: ${a.plays} plays, ${hrs(a.sec)} h (${pct(a.sec, total)}%), skipped ${pct(a.skipped, a.plays)}%`).join('\n'), data: g };
  },

  top_tracks(plays, r, { limit = 10, by = 'plays' } = {}) {
    const g = byTrack(plays).sort((a, b) => (by === 'time' ? b.sec - a.sec : b.plays - a.plays || b.sec - a.sec)).slice(0, limit);
    return { text: `Top tracks by ${by === 'time' ? 'listening time' : 'plays'}, ${r.label}:\n` + g.map((t, i) => `${i + 1}. ${t.name} - ${t.artist}: ${t.plays} plays, ${mins(t.sec)} min, skipped ${pct(t.skipped, t.plays)}%`).join('\n'), data: g };
  },

  skips(plays, r, { limit = 8, minPlays = 3 } = {}) {
    const rate = g => ({ ...g, rate: pct(g.skipped, g.plays) });
    const arts = byArtist(plays).filter(a => a.plays >= minPlays).map(rate), tr = byTrack(plays).filter(t => t.plays >= minPlays).map(rate);
    const most = arts.sort((a, b) => b.rate - a.rate || b.plays - a.plays).slice(0, limit), never = arts.filter(a => a.skipped === 0).sort((a, b) => b.plays - a.plays).slice(0, limit);
    const worst = tr.sort((a, b) => b.rate - a.rate || b.plays - a.plays).slice(0, limit);
    const total = plays.filter(p => p.outcome !== 'unknown').length;
    return { text: [
      `Skips, ${r.label}: overall ${pct(plays.filter(p => p.outcome === 'skipped').length, total)}% skipped, ${pct(plays.filter(p => p.quickSkip).length, total)}% quick skips (under 30 s).`,
      `Most skipped artists (${minPlays}+ plays): ` + (most.map(a => `${a.name} ${a.rate}% of ${a.plays}`).join('; ') || 'none'),
      `Most skipped tracks: ` + (worst.map(t => `${t.name} - ${t.artist} ${t.rate}% of ${t.plays}`).join('; ') || 'none'),
      `Never skipped: ` + (never.map(a => `${a.name} (${a.plays})`).join('; ') || 'none'),
    ].join('\n'), data: { most, worst, never } };
  },

  time_of_day(plays, r) {
    const hour = new Array(24).fill(0);
    for (const p of plays) hour[new Date(p.at).getHours()] += p.listenedSec;
    const total = hour.reduce((a, b) => a + b, 0);
    const bucket = (a, b) => hour.slice(a, b).reduce((x, y) => x + y, 0);
    const top = hour.map((s, h) => ({ h, s })).sort((a, b) => b.s - a.s).slice(0, 3);
    return { text: `When you listen, ${r.label}: night 12-5am ${pct(bucket(0, 5), total)}%, morning 5-12 ${pct(bucket(5, 12), total)}%, afternoon 12-6pm ${pct(bucket(12, 18), total)}%, evening 6pm-12 ${pct(bucket(18, 24), total)}%. Peak hours: ${top.map(x => `${fmtHour(x.h)} (${hrs(x.s)} h)`).join(', ')}.`, data: { hour } };
  },

  weekday(plays, r) {
    const wd = new Array(7).fill(0), cnt = new Array(7).fill(0);
    for (const p of plays) { const d = new Date(p.at).getDay(); wd[d] += p.listenedSec; cnt[d]++; }
    const total = wd.reduce((a, b) => a + b, 0);
    return { text: `By weekday, ${r.label}: ` + DAYS.map((d, i) => `${d} ${hrs(wd[i])} h (${pct(wd[i], total)}%)`).join(', ') + '.', data: { wd, cnt } };
  },

  sessions(plays, r) {
    const ss = sessions(plays);
    if (!ss.length) return { text: `No sessions for ${r.label}.`, data: {} };
    const longest = [...ss].sort((a, b) => b.sec - a.sec).slice(0, 3);
    const startHour = new Array(24).fill(0); for (const s of ss) startHour[new Date(s.start).getHours()]++;
    const typical = startHour.indexOf(Math.max(...startHour));
    const top = s => byArtist(s.plays).sort((a, b) => b.plays - a.plays)[0]?.name;
    return { text: `Sessions (a break over 30 min starts a new one), ${r.label}: ${ss.length} sessions, average ${mins(ss.reduce((a, s) => a + s.sec, 0) / ss.length)} min and ${r1(ss.reduce((a, s) => a + s.plays.length, 0) / ss.length)} tracks, usually starting around ${fmtHour(typical)}.\nLongest binges: ` + longest.map(s => `${fmtDate(s.start)} ${mins(s.sec)} min, ${s.plays.length} tracks, mostly ${top(s)}`).join('; ') + '.', data: { count: ss.length, longest } };
  },

  repeats(plays, r, { limit = 8 } = {}) {
    const perDay = new Map();
    for (const p of plays) { const k = `${dayKey(p.at)}|${key(p)}`; const g = perDay.get(k) || { n: 0, p }; g.n++; perDay.set(k, g); }
    const days = [...perDay.values()].filter(g => g.n >= 3).sort((a, b) => b.n - a.n);
    const trk = byTrack(plays).filter(t => t.plays >= 5).sort((a, b) => b.plays - a.plays).slice(0, limit);
    return { text: `Repeats, ${r.label}: ` + (days.length ? `most played in a single day: ${days.slice(0, limit).map(g => `${label(g.p)} x${g.n} on ${fmtDate(g.p.at)}`).join('; ')}. ` : 'no track played 3+ times in one day. ') + (trk.length ? `Obsessions (5+ plays): ${trk.map(t => `${t.name} - ${t.artist} x${t.plays}`).join('; ')}.` : ''), data: { days, trk } };
  },

  trends(plays, r) {
    const months = new Map();
    for (const p of plays) { const k = monthKey(p.at); (months.get(k) || months.set(k, []).get(k)).push(p); }
    const keys = [...months.keys()].sort();
    if (keys.length < 2) return { text: `Trends need at least two months of plays; there is ${keys.length || 'no'} month so far (${r.label}).`, data: {} };
    const vec = ps => { const m = new Map(); for (const p of ps) for (const a of p.artists) m.set(a, (m.get(a) || 0) + p.listenedSec); return m; };
    const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (const [k, v] of a) { na += v * v; d += v * (b.get(k) || 0); } for (const v of b.values()) nb += v * v; return na && nb ? d / Math.sqrt(na * nb) : 0; };
    const seen = new Set(); const lines = []; let prev = null;
    for (const k of keys) {
      const ps = months.get(k), v = vec(ps);
      const top = byArtist(ps).sort((a, b) => b.sec - a.sec).slice(0, 3).map(a => a.name);
      const fresh = [...new Set(ps.flatMap(p => p.artists))].filter(a => !seen.has(a)); fresh.forEach(a => seen.add(a));
      lines.push(`${k}: ${hrs(ps.reduce((a, p) => a + p.listenedSec, 0))} h, ${new Set(ps.flatMap(p => p.artists)).size} artist${new Set(ps.flatMap(p => p.artists)).size === 1 ? '' : 's'} (${fresh.length} new), top ${top.join(', ')}${prev ? `, similarity to last month ${Math.round(cos(v, prev) * 100)}%` : ''}`);
      prev = v;
    }
    return { text: `Taste over time (similarity 100% = same artists in the same proportions):\n` + lines.slice(-12).join('\n'), data: { months: keys } };
  },

  discovery(plays, r, all = plays) {
    const first = new Map();
    for (const p of all) for (const a of p.artists) if (!first.has(a) || p.at < first.get(a)) first.set(a, p.at);
    const fresh = [...first].filter(([, t]) => t >= r.from && t <= r.to).map(([a]) => a);
    const counts = new Map(byArtist(plays).map(a => [a.name, a]));
    const best = fresh.map(a => counts.get(a)).filter(Boolean).sort((a, b) => b.plays - a.plays).slice(0, 8);
    const arts = new Set(plays.flatMap(p => p.artists)).size;
    return { text: `Discovery, ${r.label}: ${fresh.length} artists heard for the first time (${pct(fresh.length, arts)}% of the artists you played). New artists you kept playing: ${best.map(a => `${a.name} (${a.plays})`).join(', ') || 'none yet'}.`, data: { fresh } };
  },

  artist(plays, r, { name = '' } = {}) {
    const q = String(name).toLowerCase().trim();
    const mine = plays.filter(p => p.artists.some(a => a.toLowerCase() === q) || p.artist.toLowerCase().includes(q));
    if (!q || !mine.length) return { text: `No plays of "${name}" in ${r.label}.`, data: {} };
    const sec = mine.reduce((a, p) => a + p.listenedSec, 0), hour = new Array(24).fill(0);
    for (const p of mine) hour[new Date(p.at).getHours()] += p.listenedSec;
    const known = mine.filter(p => p.outcome !== 'unknown').length;
    const tr = byTrack(mine).sort((a, b) => b.plays - a.plays).slice(0, 5);
    const skippedMost = byTrack(mine).filter(t => t.plays >= 2).sort((a, b) => pct(b.skipped, b.plays) - pct(a.skipped, a.plays))[0];
    return { text: `${name}, ${r.label}: ${mine.length} plays, ${hrs(sec)} h, ${new Set(mine.map(key)).size} different tracks. First heard ${fmtDate(Math.min(...mine.map(p => p.at)))}, last ${fmtDate(Math.max(...mine.map(p => p.at)))}. Finished ${pct(mine.filter(p => p.outcome === 'finished').length, known)}%, skipped ${pct(mine.filter(p => p.outcome === 'skipped').length, known)}%. Usually around ${fmtHour(hour.indexOf(Math.max(...hour)))}.\nTop tracks: ${tr.map(t => `${t.name} x${t.plays}`).join('; ')}.${skippedMost && skippedMost.skipped ? ` Most skipped: ${skippedMost.name} (${pct(skippedMost.skipped, skippedMost.plays)}%).` : ''}`, data: {} };
  },

  sources(plays, r, { names = () => null } = {}) {
    const g = group(plays.filter(p => p.list), p => p.list, newGroup(p => ({ name: p.list }))).sort((a, b) => b.plays - a.plays).slice(0, 8);
    const direct = plays.filter(p => !p.list).length;
    return { text: `Where plays came from, ${r.label}: ` + (g.map(x => `${names(x.key) || x.key}: ${x.plays} plays, ${hrs(x.sec)} h`).join('; ') || 'no playlist info') + `. ${direct} plays were not from a playlist or radio.`, data: g };
  },

  recent(plays, r, { limit = 10 } = {}) {
    const l = [...plays].sort((a, b) => b.at - a.at).slice(0, limit);
    return { text: 'Recent plays:\n' + l.map(p => `${new Date(p.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} - ${label(p)} (${p.outcome}${p.quickSkip ? ', quick skip' : ''})`).join('\n'), data: l };
  },
};

const REPORTS = Object.keys(reports);

// report(allPlays, { report, period, limit, name, by }) → { text, data }
function report(all, { report: name = 'overview', period = 'month', now = Date.now(), ...opts } = {}) {
  const fn = reports[name];
  if (!fn) return { text: `Unknown report "${name}". Reports: ${REPORTS.join(', ')}.`, data: {} };
  if (!all.length) return { text: 'No listening has been logged yet. Play music in YouTube Music with the JARVIS extension on (version 1.3 or newer) and the log will fill from now on.', data: {} };
  const r = periodRange(period, now);
  const plays = within(all, r);
  if (!plays.length && name !== 'discovery') return { text: `No plays logged for ${r.label}. The log started ${fmtDate(all[0].at)}.`, data: {} };
  return name === 'discovery' ? reports.discovery(plays, r, all) : fn(plays, r, opts);
}

module.exports = { report, periodRange, sessions, REPORTS };
