'use strict';
// A seeded synthetic tool registry for discovery tests: n tools named verb_noun over n/12 groups. Each description is written
// with the A-synonym of the verb and noun; paraphrase(name) asks with the B-synonyms, so a request shares no word with the
// tool's name or text. `synonyms` maps all three spellings to one word for createFakeEmbedder, so only embeddings can bridge
// the gap. The synonyms are coined words (suffixed) so no real word can collide by accident.
const VERBS = 'open close start stop pause resume delete create rename copy move send read write search list share save print mute scan sync lock record'.split(' ');
const NOUNS = 'door window file folder album song photo video note alarm timer reminder contact message email calendar event tab page bookmark download setting profile account network printer speaker camera screen password backup report invoice ticket recipe playlist podcast channel widget script archive'.split(' ');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function makeSynthRegistry({ n = 300, seed = 1 } = {}) {
  const rnd = mulberry32(seed);
  const pairs = [];
  for (const v of VERBS) for (const o of NOUNS) pairs.push([v, o]);
  for (let i = pairs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }
  const chosen = pairs.slice(0, Math.min(n, pairs.length));
  const synonyms = {}, other = new Map();
  const syn = w => {
    if (!other.has(w)) { other.set(w, [`${w}oid`, `${w}ish`]); synonyms[`${w}oid`] = w; synonyms[`${w}ish`] = w; }
    return other.get(w);
  };
  const gcount = Math.max(1, Math.floor(chosen.length / 12));
  const groups = Array.from({ length: gcount }, (_, i) => ({ id: `g${i}`, label: `Group ${i}`, triggers: [], tools: [] }));
  const tools = chosen.map(([v, o], i) => {
    const tool = { name: `${v}_${o}`, description: `${syn(v)[0]} ${syn(o)[0]}.`, params: { type: 'object', properties: {}, additionalProperties: false }, sideEffects: 'read', async run() { return 'ok'; } };
    groups[i % gcount].tools.push(tool);
    return tool;
  });
  const paraphrase = name => { const [v, o] = name.split('_'); return `${syn(v)[1]} the ${syn(o)[1]}`; };
  return { groups, tools, synonyms, paraphrase };
}

module.exports = { makeSynthRegistry };
