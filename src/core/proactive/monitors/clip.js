// Monitors speak text that came from outside (alert names, team names, task titles): printable ASCII only, one line, capped.
const clip = (s, n = 60) => String(s ?? '').replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n).trim();
module.exports = { clip };
