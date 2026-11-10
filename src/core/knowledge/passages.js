// Article HTML → clean sections → ~120–200-word passages → BM25 ranking (+ title boost) →
// short cited extracts "[Title › Section] text" that fit the 8k context (≤ 2,500 chars).
const { decodeEntities } = require('./feed-parser');

const MAX_CHARS = 2500;
const TARGET_WORDS = 160, MAX_WORDS = 220;
const DROP_SECTIONS = /^(references|external links|notes|further reading|sources|see also|bibliography|citations|footnotes|notes and references|works cited|gallery)$/i;
const STOP = new Set(('a an the of in on at to for from by with and or but is are was were be been being it its this that these those ' +
  'who whom whose what which when where why how do does did done has have had i you he she we they me my your his her our their ' +
  'as into than then there here about over after before during first can could would should will shall may might also not no yes ' +
  'tell me please explain describe define much many some any').split(' '));

// remove every <tag …>…</tag> block (handles nesting by depth counting)
function dropBlocks(html, tag, test = () => true) {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  let out = '', i = 0, m;
  while ((m = open.exec(html))) {
    if (m.index < i) continue;
    if (!test(m[0])) continue;
    const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'gi');
    re.lastIndex = m.index;
    let depth = 0, end = html.length, t;
    while ((t = re.exec(html))) {
      depth += t[0][1] === '/' ? -1 : 1;
      if (depth === 0) { end = t.index + t[0].length; break; }
    }
    out += html.slice(i, m.index);
    i = end;
    open.lastIndex = end;
  }
  return out + html.slice(i);
}

function clean(html) {
  let h = String(html || '');
  h = h.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|math|link|meta)\b[\s\S]*?(?:<\/\1>|\/?>)/gi, ' ');
  h = h.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  h = dropBlocks(h, 'table');
  h = dropBlocks(h, 'figure');
  h = dropBlocks(h, 'sup', o => /reference|noprint|Inline-Template/i.test(o));
  h = dropBlocks(h, 'span', o => /mw-editsection|noprint|mw-cite-backlink/i.test(o));
  h = dropBlocks(h, 'div', o => /navbox|reflist|refbegin|hatnote|shortdescription|thumb|metadata|sistersitebox|side-box|mw-references-wrap|portalbox|toc/i.test(o));
  h = dropBlocks(h, 'ol', o => /references/i.test(o));
  return h;
}

const textOf = s => decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\[\s*(?:\d+|[a-z]|note \d+|citation needed)\s*\]/gi, '').replace(/\s+/g, ' ').replace(/\s+([,.;:!?)])/g, '$1').replace(/\(\s+/g, '(').trim();

function sections(html) {
  const h = clean(html);
  const out = [];
  let h2 = 'Introduction', h3 = '', buf = [];
  const flush = () => { if (buf.length) out.push({ section: h3 ? `${h2} › ${h3}` : h2, paras: buf }); buf = []; };
  const re = /<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1>|<(p|li|dd|blockquote)\b[^>]*>([\s\S]*?)<\/\3>/gi;
  let m;
  while ((m = re.exec(h))) {
    if (m[1]) {
      flush();
      const name = textOf(m[2]);
      if (m[1] === '2') { h2 = name; h3 = ''; } else h3 = name;
    } else {
      const t = textOf(m[4]);
      if (t.split(/\s+/).length >= 4) buf.push(t);
    }
  }
  flush();
  return out.filter(s => !DROP_SECTIONS.test(s.section.split(' › ')[0]));
}

function splitSentences(t) { return t.match(/[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g) || [t]; }

function toPassages(html, title) {
  const out = [];
  for (const s of sections(html)) {
    let cur = [];
    const words = () => cur.join(' ').split(/\s+/).filter(Boolean).length;
    const push = () => { if (cur.length) out.push({ title, section: s.section, text: cur.join(' ').trim() }); cur = []; };
    for (const p of s.paras) {
      const n = p.split(/\s+/).length;
      if (n > MAX_WORDS) {                          // long paragraph: cut at sentence ends
        push();
        for (const sen of splitSentences(p)) { cur.push(sen.trim()); if (words() >= TARGET_WORDS) push(); }
        push();
        continue;
      }
      if (words() + n > MAX_WORDS) push();
      cur.push(p);
      if (words() >= TARGET_WORDS) push();
    }
    push();
  }
  // a small tail merges into the previous passage of the same section
  for (let i = out.length - 1; i > 0; i--) {
    const a = out[i - 1], b = out[i];
    if (a.section === b.section && b.text.split(/\s+/).length < 40 && (a.text + ' ' + b.text).split(/\s+/).length <= MAX_WORDS + 40) {
      a.text += ' ' + b.text; out.splice(i, 1);
    }
  }
  return out;
}

const fold = w => w.normalize('NFD').replace(/[̀-ͯ]/g, '');
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}
function tokens(t) {
  return fold(String(t).toLowerCase()).split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w)).map(stem);
}

// question verbs → the words articles use for the answer
const SYNONYMS = {
  wrote: ['author', 'written'], write: ['author', 'written'], written: ['author'], author: ['written'],
  invented: ['inventor', 'invention'], invent: ['inventor'], founded: ['founder', 'established'], found: ['founder'],
  discovered: ['discovery', 'discoverer'], discover: ['discovery'], born: ['birth'], died: ['death'], die: ['death'],
  signed: ['treaty', 'signing'], built: ['construction', 'constructed'], painted: ['painter', 'painting'],
  composed: ['composer'], directed: ['director'], capital: ['capital'], population: ['inhabitant', 'census'],
};

// BM25 over the passages, with the article title and section heading as boosted fields
function rank(passages, query, k = 5) {
  const base = [...new Set(tokens(query))];
  const q = [...new Set([...base, ...base.flatMap(w => SYNONYMS[w] || [])])];
  if (!q.length || !passages.length) return passages.slice(0, k);
  const docs = passages.map(p => ({ p, t: tokens(p.text), head: new Set(tokens(p.title)), sec: new Set(tokens(p.section)) }));
  const N = docs.length, avg = docs.reduce((s, d) => s + d.t.length, 0) / N;
  const df = new Map(q.map(w => [w, docs.filter(d => d.t.includes(w)).length]));
  const k1 = 1.4, b = 0.75;
  const scored = docs.map((d, i) => {
    const tf = new Map();
    for (const w of d.t) if (df.has(w)) tf.set(w, (tf.get(w) || 0) + 1);
    let s = 0;
    for (const w of q) {
      const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
      const f = tf.get(w) || 0;
      if (f) s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.t.length / avg));
      if (d.head.has(w)) s += 0.6 * idf;          // title boost
      if (d.sec.has(w)) s += 0.4 * idf;           // section heading
    }
    if (d.p.section === 'Introduction') {          // the lead summarises the article; more so when the question names it
      const named = d.head.size && [...d.head].every(w => base.includes(w));
      s *= named ? 1.4 : 1.1;
    }
    return { s, i, p: d.p };
  });
  return scored.sort((a, b) => b.s - a.s || a.i - b.i).slice(0, k).map(x => x.p);
}

function formatPassages(passages, max = MAX_CHARS) {
  const out = [];
  let used = 0;
  for (const p of passages) {
    let line = `[${p.title} › ${p.section}] ${p.text}`;
    if (used + line.length + 2 > max) {
      const room = max - used - 2;
      if (room < 200) break;
      line = line.slice(0, room - 1).replace(/\s+\S*$/, '') + '…';
    }
    out.push(line);
    used += line.length + 2;
  }
  return out.join('\n\n');
}

function keyWords(query) {
  return fold(String(query).toLowerCase()).split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w)).join(' ');
}

module.exports = { toPassages, rank, formatPassages, tokens, sections, keyWords };
