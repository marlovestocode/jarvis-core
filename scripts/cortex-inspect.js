// Developer view of a cortex file (core spec §9).
//   node scripts/cortex-inspect.js <db> node <id>        a node, its sources and its neighbors (2 hops)
//   node scripts/cortex-inspect.js <db> recall "<query>"  a recall's stages: seeds, spread, packed text
//   node scripts/cortex-inspect.js <db> stats
// Opens the file through the public API (no embedder, so recall is keyword mode). Never writes, except the
// use-count flush the API does on close, which is empty here because nothing is reinforced.
const cortexLib = require('../src/core/cortex');

async function main() {
  const [file, cmd, arg] = process.argv.slice(2);
  if (!file || !cmd) { console.error('usage: cortex-inspect.js <db> node <id> | recall "<query>" | stats'); process.exit(2); }
  const c = cortexLib.open({ file, log: m => console.error(m) });
  try {
    if (cmd === 'stats') console.log(JSON.stringify({ stats: c.stats(), health: c.health() }, null, 2));
    else if (cmd === 'node') {
      const n = c.node.get(Number(arg));
      if (!n) { console.log('no node ' + arg); return; }
      console.log(JSON.stringify(n, null, 2));
      for (const x of c.neighbors(n.id, { depth: 2, limit: 50 })) {
        const o = c.node.get(x.id);
        console.log(`${'  '.repeat(x.hop)}${x.type} ${x.weight.toFixed(3)} → #${x.id} [${o?.kind}] ${o?.text.slice(0, 80)}${x.hop > 1 ? ` (via #${x.via})` : ''}`);
      }
    } else if (cmd === 'recall') {
      const r = await c.recall(arg || '', { debug: true });
      console.log(`mode ${r.mode}, ${r.ms.toFixed(2)} ms`);
      const show = list => list.slice(0, 20).map(x => `  #${x.id} ${(x.a ?? x.score).toFixed(3)} ${c.node.get(x.id)?.text.slice(0, 70) ?? '(gone)'}`).join('\n');
      console.log(`seeds (${r.stages.seeds.length}):\n${show(r.stages.seeds)}`);
      console.log(`spread (${r.stages.spread.length} touched):\n${show([...r.stages.spread].sort((a, b) => b.a - a.a))}`);
      console.log(`packed:\n${r.text}`);
    } else { console.error('unknown command ' + cmd); process.exit(2); }
  } finally { c.close(); }
}

main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
