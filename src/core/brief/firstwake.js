'use strict';
// Offers the brief on the first wake of the local day. The day is marked used before the brief runs, so a crash or a
// second wake cannot repeat it; quiet hours leave the day unused so the first wake after them gets it.
const { inQuiet } = require('../proactive/engine');

const dayOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function createFirstWake({ bus, getConfig, saveBriefDate, run, now = () => new Date(), isQuiet = (c, d) => inQuiet(c.proactive || {}, d.getTime()), log = () => {} }) {
  const off = bus.on('wake', () => {
    try {
      const c = getConfig();
      const b = c.brief || {};
      const t = now();
      if (!b.auto || !b.onFirstWake || b.lastDate === dayOf(t) || isQuiet(c, t)) return;
      saveBriefDate(dayOf(t));
      Promise.resolve().then(run).catch(err => log(`morning brief failed: ${err?.message || err}`));
    } catch (err) { log(`morning brief trigger failed: ${err?.message || err}`); }
  });
  return { stop: off };
}

module.exports = { createFirstWake, dayOf };
