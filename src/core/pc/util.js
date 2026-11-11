// Small formatting helpers shared by the PC and file tools.
const pad = n => String(n).padStart(2, '0');

// 1536 → "1.5 KB"
function humanSize(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${u[i]}`;
}

// local "2026-01-05 10:20"
function dateTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const listWords = a => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);

module.exports = { humanSize, dateTime, plural, listWords };
