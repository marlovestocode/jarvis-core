// Feature "calendar" (vault G10 and G17, note 07 S0): the market calendar as data, a check of that calendar against the bars actually
// received, and the record of what a catch-up could not fill. The rules themselves are pure code in calendar-rules.js.
//   market_day    one row per calendar date: open, early close or closed, with the reason and the rules version that said so, plus
//                 what was observed in the bars (how many symbols have a bar that day) once that has been checked.
//   catchup_gap   a trading day a catch-up could not fill, with why. Never silent: runs.js adds it and the data_quality summary counts it.
// The rules were not verified against an official calendar (calendar-rules.js says so); crossCheck() is the safety net.
const { addDays, nyDate, parseDate } = require('./ny-time');
const { dayInfo, RULES_VERSION } = require('./calendar-rules');

const MIGRATION_VERSION = 4;
const migration = {
  version: MIGRATION_VERSION, name: 'calendar',
  up(raw) {
    raw.exec(`
      -- the trading calendar, one row per date (New York date). Written from the rules in code, so it can be rewritten when the rules change.
      CREATE TABLE market_day(
        day TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('open','early','closed')),
        open_local TEXT, close_local TEXT,   -- HH:MM New York time; null when closed
        reason TEXT,                         -- holiday name, weekend, early-close reason
        rules_version INTEGER NOT NULL,
        observed_n INTEGER, universe_n INTEGER, checked_at INTEGER,   -- how many universe symbols had a bar that day, when last checked
        verdict TEXT CHECK(verdict IN ('ok','partial','suspect_closed','suspect_open')));
      -- what a catch-up could not fill. resolved_at is set when later data closes it.
      CREATE TABLE catchup_gap(
        id INTEGER PRIMARY KEY,
        day TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT,
        detected_at INTEGER NOT NULL, resolved_at INTEGER,
        UNIQUE(day, reason));
    `);
  },
};

function createCalendar({ now = Date.now, opts = {} } = {}) {
  const o = { partialBelow: 0.5, ...opts };
  let db = null;

  // write market_day rows for [from, to] (inclusive); rows written by an older rules version are rewritten, observations are kept
  function materialize(from, to) {
    parseDate(from); parseDate(to);
    const have = new Map(db.stmt('SELECT day, rules_version AS v FROM market_day WHERE day >= ? AND day <= ?').all(from, to).map(r => [r.day, r.v]));
    let written = 0;
    db.tx(() => {
      const ins = db.stmt(`INSERT INTO market_day(day, kind, open_local, close_local, reason, rules_version) VALUES (?,?,?,?,?,?)
        ON CONFLICT(day) DO UPDATE SET kind = excluded.kind, open_local = excluded.open_local, close_local = excluded.close_local, reason = excluded.reason, rules_version = excluded.rules_version`);
      for (let d = from; parseDate(d) <= parseDate(to); d = addDays(d, 1)) {
        if (have.get(d) === RULES_VERSION) continue;
        const i = dayInfo(d);
        ins.run(d, i.kind, i.open, i.close, i.reason, RULES_VERSION);
        written++;
      }
    });
    return written;
  }
  const day = d => db.stmt('SELECT * FROM market_day WHERE day = ?').get(d) || null;

  // Compare the calendar with the bars received. `counts` = { 'YYYY-MM-DD': symbols with a bar that day }, universeN = universe size.
  //   open or early day with no bars at all  → suspect_closed (an unscheduled closure, a wrong rule, or the provider has nothing)
  //   closed day with bars                   → suspect_open   (a wrong holiday rule)
  //   open day with under half the universe  → partial
  // Returns the suspects. The verdict is stored on market_day and also logged by the caller, so it reaches data_quality.
  function crossCheck({ counts, universeN }) {
    const suspects = [];
    db.tx(() => {
      const upd = db.stmt('UPDATE market_day SET observed_n = ?, universe_n = ?, checked_at = ?, verdict = ? WHERE day = ?');
      for (const [d, n] of Object.entries(counts)) {
        const i = dayInfo(d);
        let verdict = 'ok';
        if (i.kind === 'closed') { if (n > 0) verdict = 'suspect_open'; }
        else if (n === 0) verdict = 'suspect_closed';
        else if (universeN > 0 && n / universeN < o.partialBelow) verdict = 'partial';
        upd.run(n, universeN, now(), verdict, d);
        if (verdict !== 'ok') suspects.push({ day: d, verdict, observed: n, universe: universeN, calendar: i.kind, reason: i.reason });
      }
    });
    return suspects;
  }
  const suspects = ({ limit = 20 } = {}) => db.stmt("SELECT day, kind, reason, verdict, observed_n AS observed, universe_n AS universe FROM market_day WHERE verdict IS NOT NULL AND verdict != 'ok' ORDER BY day DESC LIMIT ?").all(limit);

  function recordUnfillable(d, reason, detail) {
    db.stmt('INSERT INTO catchup_gap(day, reason, detail, detected_at) VALUES (?,?,?,?) ON CONFLICT(day, reason) DO UPDATE SET detail = excluded.detail WHERE resolved_at IS NULL')
      .run(d, reason, detail === undefined ? null : String(detail).slice(0, 300), now());
  }
  const resolveUnfillable = d => Number(db.stmt('UPDATE catchup_gap SET resolved_at = ? WHERE day = ? AND resolved_at IS NULL').run(now(), d).changes);
  const unfillable = ({ limit = 50 } = {}) => db.stmt('SELECT day, reason, detail, detected_at AS detectedAt FROM catchup_gap WHERE resolved_at IS NULL ORDER BY day DESC LIMIT ?').all(limit);
  const unfillableCount = () => Number(db.stmt('SELECT COUNT(*) AS n FROM catchup_gap WHERE resolved_at IS NULL').get().n);

  const api = { materialize, day, crossCheck, suspects, recordUnfillable, resolveUnfillable, unfillable, unfillableCount, today: () => nyDate(now()) };
  const feature = { id: 'calendar', migrations: [migration], async start(ctx) { db = ctx.db; }, async stop() {} };
  return { feature, api };
}

module.exports = { createCalendar, MIGRATION_VERSION };
