// New York wall-clock helpers. US markets keep New York time (EST/EDT), so every "trading day" in StockMan is a New York calendar date
// written YYYY-MM-DD. Uses the engine's Intl time zone data, so daylight saving is handled by the runtime and not by hand.
// Not verified: that the Electron runtime ships full ICU (Node 22 does; the tests cover both sides of both DST changes).
const TZ = 'America/New_York';
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function nyParts(ms) {
  const p = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
const nyDate = ms => nyParts(ms).date;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function parseDate(s) {
  const m = DATE.exec(String(s));
  if (!m) throw new TypeError(`not a YYYY-MM-DD date: ${JSON.stringify(s)}`);
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (new Date(ms).toISOString().slice(0, 10) !== s) throw new TypeError(`not a real date: ${s}`);
  return ms;
}
const fmtDate = ms => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => fmtDate(parseDate(d) + n * 86400000);
const dayOfWeek = d => new Date(parseDate(d)).getUTCDay();   // 0 = Sunday
const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);

// the instant (ms epoch) at which New York's clock reads `hhmm` on `date`; the two offsets are EST (5) and EDT (4)
function nyWallToMs(date, hhmm) {
  const [h, mi] = hhmm.split(':').map(Number);
  const [y, mo, d] = date.split('-').map(Number);
  for (const off of [4, 5]) {
    const ms = Date.UTC(y, mo - 1, d, h + off, mi);
    const p = nyParts(ms);
    if (p.date === date && p.hour === h && p.minute === mi) return ms;
  }
  throw new RangeError(`no such New York time: ${date} ${hhmm}`);
}

module.exports = { TZ, nyParts, nyDate, parseDate, fmtDate, addDays, dayOfWeek, daysBetween, nyWallToMs };
