// How old a looked-up answer is, in words the model can repeat ("Open-Meteo, 3 min ago").
function describeAge(ageMs, stale = false) {
  const m = Math.round((ageMs || 0) / 60000);
  let s;
  if (m < 1) s = 'just now';
  else if (m < 60) s = `${m} min ago`;
  else if (m < 48 * 60) s = `${Math.round(m / 60)} h ago`;
  else s = `${Math.round(m / 1440)} days ago`;
  if (!stale) return s;
  return `last known, ${s.replace(/ ago$/, ' old').replace('just now', 'moments old')} (could not refresh)`;
}

module.exports = { describeAge };
