// Voice-mode phrasing for structured data: song lists, durations, and canned-reply variants.
// Pure functions, no I/O. Typed chat keeps its exact, numbered formats; this is only for what is said aloud.
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const words = n => (n < 20 ? ONES[n] : n < 100 ? TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '') : String(n));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// "2:37" → 157, "1:02:03" → 3723, anything else → null
function parseClock(v) {
  const m = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(String(v ?? '').trim());
  if (!m) return null;
  return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
}

// 1986 seconds → "about thirty-five minutes"; a person rounds, so the voice does
function spokenDuration(totalSeconds) {
  const sec = Math.max(0, Number(totalSeconds) || 0);
  if (sec < 45) return 'under a minute';
  if (sec <= 90) return 'about a minute';
  const min = Math.round(sec / 60);
  if (min < 60) {
    const r = min > 10 ? Math.round(min / 5) * 5 : min;
    if (r === 30) return 'about half an hour';
    if (r >= 60) return 'about an hour';
    return `about ${words(r)} minutes`;
  }
  let h = Math.floor(min / 60), rest = Math.round((min % 60) / 15) * 15;
  if (rest === 60) { h += 1; rest = 0; }
  if (h === 1) return rest === 0 ? 'about an hour' : rest === 30 ? 'about an hour and a half' : `about an hour and ${words(rest)} minutes`;
  return rest === 0 ? `about ${words(h)} hours` : rest === 30 ? `about ${words(h)} and a half hours` : `about ${words(h)} hours and ${words(rest)} minutes`;
}

// [{title, artist}] → "Twelve from Scrim: a, b, c, then d. Eight more after that."
// Titles are said exactly as given; only the first `max` are read, and the rest are counted, never dropped silently.
function spokenSongs(items, { max = 4 } = {}) {
  const list = (items || []).filter(x => x && x.title);
  if (!list.length) return '';
  if (list.length === 1) return `${list[0].title}${list[0].artist ? ' by ' + list[0].artist : ''}`;
  const shown = list.slice(0, max);
  const artists = new Set(list.map(x => x.artist || ''));
  const same = artists.size === 1 && list[0].artist;
  const names = shown.map(x => (same || !x.artist ? x.title : `${x.title} by ${x.artist}`));
  const body = names.length === 2 ? `${names[0]} and ${names[1]}`
    : names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]}`
      : `${names.slice(0, -1).join(', ')}, then ${names[names.length - 1]}`;
  const lead = same ? `${cap(words(list.length))} from ${list[0].artist}: ` : '';
  const more = list.length - shown.length;
  return `${lead}${body}.${more > 0 ? ` ${cap(words(more))} more after that.` : ''}`;
}

// a varied line that is never the same one twice in a row for the same key
const lastPick = new Map();
function pick(variants, key) {
  if (variants.length < 2) return variants[0];
  const last = lastPick.get(key);
  let i;
  do { i = Math.floor(Math.random() * variants.length); } while (i === last);
  lastPick.set(key, i);
  return variants[i];
}

module.exports = { parseClock, spokenDuration, spokenSongs, pick, words };
