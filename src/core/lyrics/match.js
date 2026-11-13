// Matching helpers for the lyrics skill: titles, candidates, and finding a remembered line in a lyric text.
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/\$/g, 's').replace(/[^a-z0-9]+/g, ' ').trim();   // "$uicideboy$" reads as "suicideboys"
const compact = s => norm(s).replace(/ /g, '');   // "Suicide Boys", "SuicideBoys" and "$uicideboy$" are one name
const words = s => norm(s).split(' ').filter(Boolean);

// "Risk (2019 Remastered) [Official Audio]" / "Risk - Remastered 2011" / "Risk feat. X" -> "Risk"
function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*[([][^)\]]*(?:remaster|remix|live|version|edit|mono|stereo|deluxe|explicit|official|video|audio|lyrics?|feat\.?|ft\.?|with)[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|single version|radio edit|mono|stereo|live)\b.*$/i, '')
    .replace(/\s+(?:feat\.?|ft\.?)\s+.*$/i, '')
    .trim();
}

// Dice coefficient on word sets: 1 = same words, 0 = nothing shared
function similarity(a, b) {
  const x = new Set(words(a)), y = new Set(words(b));
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const w of x) if (y.has(w)) hit++;
  return (2 * hit) / (x.size + y.size);
}

function artistScore(want, have) {
  const a = compact(want), b = compact(have);
  if (!a) return 1;
  if (!b) return 0;
  if (a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a)))) return 1;
  return similarity(want, have);
}

// titles a record may carry: itself, and the part after "Artist - " (uploads are often named that way)
const titleForms = t => { const c = cleanTitle(t); const m = c.match(/^.+?\s+[-–—]\s+(.+)$/); return m ? [c, cleanTitle(m[1])] : [c]; };
const titleScore = (a, b) => Math.max(...titleForms(a).flatMap(x => titleForms(b).map(y => (norm(x) === norm(y) ? 1 : similarity(x, y)))));

// req { title, artist?, duration? } vs one LRCLIB record -> 0..1
// LRCLIB sometimes has the title and artist fields swapped, so the better of the two readings counts
function score(req, rec) {
  const one = r => {
    const t = titleScore(req.title, r.title);
    return req.artist ? t * 0.65 + artistScore(req.artist, r.artist) * 0.35 : t;
  };
  let s = Math.max(one(rec), one({ ...rec, title: rec.artist, artist: rec.title }));
  if (req.duration && rec.duration) {
    const d = Math.abs(req.duration - rec.duration);
    s += d <= 3 ? 0.1 : d > 12 ? -0.15 : 0;
  }
  return Math.max(0, Math.min(1.1, s));
}

const MIN_SCORE = 0.75;
// the best record that has lyrics (or is marked instrumental) and matches well enough, else null
function pickBest(req, list, min = MIN_SCORE) {
  let best = null;
  for (const rec of list || []) {
    if (!rec || !(rec.text || rec.instrumental)) continue;
    const s = score(req, rec);
    if (s >= min && (!best || s > best.score)) best = { rec, score: s };
  }
  return best;
}

const lines = text => String(text || '').split(/\r?\n/).map(l => l.trim());

// How much of the phrase's words sit, in a stretch of the lyrics about as long as the phrase (0..1)
function coverage(phrase, text) {
  const p = words(phrase), t = words(text);
  if (!p.length || !t.length) return 0;
  if (` ${t.join(' ')} `.includes(` ${p.join(' ')} `)) return 1;
  const size = Math.ceil(p.length * 1.5);
  let best = 0;
  for (let i = 0; i < t.length; i++) {
    const win = new Set(t.slice(i, i + size));
    let hit = 0;
    for (const w of new Set(p)) if (win.has(w)) hit++;
    best = Math.max(best, hit / new Set(p).size);
    if (best === 1) break;
  }
  return best;
}

const found = (phrase, text, min = 0.85) => coverage(phrase, text) >= min;

// The line after the one containing the phrase (the phrase may run over two lines). -> { line, next } | null
function lineAfter(text, phrase) {
  const p = norm(phrase);
  if (!p) return null;
  const all = lines(text);
  const real = all.map((l, i) => ({ l, i })).filter(x => x.l);
  const after = k => real[k + 1]?.l || null;
  for (let k = 0; k < real.length; k++) if (norm(real[k].l).includes(p)) return { line: real[k].l, next: after(k) };
  for (let k = 0; k < real.length - 1; k++) {
    const two = `${norm(real[k].l)} ${norm(real[k + 1].l)}`;
    if (two.includes(p)) return { line: `${real[k].l} / ${real[k + 1].l}`, next: after(k + 1) };
  }
  // a slightly misheard line: the closest single line, only if it is close
  let top = null;
  for (let k = 0; k < real.length; k++) {
    const s = similarity(real[k].l, phrase);
    if (!top || s > top.s) top = { s, k };
  }
  if (top && top.s >= 0.8) return { line: real[top.k].l, next: after(top.k) };
  return null;
}

module.exports = { norm, cleanTitle, similarity, score, pickBest, coverage, found, lineAfter, MIN_SCORE };
