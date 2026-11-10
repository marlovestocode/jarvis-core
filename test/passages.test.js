const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/fakenet');
const { toPassages, rank, formatPassages, tokens } = require('../src/core/knowledge/passages');

const MID = () => toPassages(fixture('article-middlemarch.html'), 'Middlemarch');
const WES = () => toPassages(fixture('article-westphalia.html'), 'Peace of Westphalia');
const OUA = () => toPassages(fixture('article-ouagadougou.html'), 'Ouagadougou');

test('passages: sections found; infobox, references and nav removed', () => {
  const p = MID();
  assert.ok(p.length > 10);
  assert.equal(p[0].section, 'Introduction');
  assert.ok(p.some(x => x.section === 'Plot'));
  assert.ok(p.some(x => /Themes › Marriage|^Marriage$/.test(x.section)));
  assert.ok(!p.some(x => /^(References|External links|Notes|Further reading|Sources|See also|Bibliography)/.test(x.section)), 'reference sections dropped');
  const all = p.map(x => x.text).join(' ');
  assert.ok(!/\[\d+\]/.test(all), 'no citation markers');
  assert.ok(!/<[a-z]/i.test(all), 'no html left');
  assert.ok(!/Genre\s+Novel/.test(all), 'infobox dropped');
  assert.ok(!/\.mw-parser-output|\{display/.test(all), 'no css');
});

test('passages: ~120–200 words each, never huge', () => {
  for (const p of [...MID(), ...WES(), ...OUA()]) {
    const w = p.text.split(/\s+/).length;
    assert.ok(w <= 260, `${p.section}: ${w} words`);
    assert.equal(typeof p.title, 'string');
  }
  const words = MID().map(p => p.text.split(/\s+/).length);
  const mid = words.sort((a, b) => a - b)[Math.floor(words.length / 2)];
  assert.ok(mid >= 80 && mid <= 220, `median ${mid}`);
});

test('passages: tokens drop stop words and fold plurals', () => {
  assert.deepEqual(tokens('Who wrote the novels of Middlemarch?'), ['wrote', 'novel', 'middlemarch']);
});

const QUESTIONS = [
  ['Who wrote Middlemarch?', MID, /George Eliot/],
  ['When was Middlemarch first published in installments?', MID, /187[12]/],
  ['In which cities was the Peace of Westphalia signed?', WES, /Osnabrück/],
  ['What year were the Westphalia treaties signed?', WES, /1648/],
  ['What is the population of Ouagadougou?', OUA, /population/i],
];
for (const [q, src, want] of QUESTIONS) {
  test(`rank: BM25 finds the answer — ${q}`, () => {
    const top = rank(src(), q, 3);
    assert.equal(top.length, 3);
    assert.ok(top.some(p => want.test(p.text)), top.map(p => p.section + ': ' + p.text.slice(0, 120)).join('\n'));
  });
}

test('rank: title boost prefers passages from the matching article', () => {
  const pool = [...MID(), ...WES()];
  const top = rank(pool, 'Middlemarch themes marriage', 3);
  assert.ok(top.every(p => p.title === 'Middlemarch'));
});

test('format: [Title › Section] citations, capped at 2,500 chars', () => {
  const t = formatPassages(rank([...MID(), ...WES(), ...OUA()], 'Peace of Westphalia 1648 treaty', 5));
  assert.ok(t.length <= 2500, String(t.length));
  assert.match(t, /\[Peace of Westphalia › [^\]]+\]/);
});
