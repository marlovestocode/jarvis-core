// Offline accuracy of skill selection against test/fixtures/skill-requests.json (no model, no GPU).
//   node scripts/skill-accuracy.js            prints the scores and every miss
//   node scripts/skill-accuracy.js --json     one JSON line (for diffing before/after)
//   node scripts/skill-accuracy.js --set fresh|heldout2   another fixture set (test/fixtures/skill-requests-<set>.json)
// Per request: "act" rows pass when the expected group is among the groups loaded and the tool belongs to a loaded group;
// "ask" rows pass when JARVIS asks which thing is meant instead of acting; "decline" rows pass when it says it has no tool for
// that; "answer" rows pass when neither happens (a plain question must not be intercepted).
// The tool the model then picks inside the group is NOT measured here: that needs the live model (node eval/run.js).
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { selectGroups } = require('../src/core/skills/select');
const { toolDeps } = require('../test/helpers/tool-deps');

const setArg = process.argv.indexOf('--set');
const rows = require(`../test/fixtures/${setArg > 0 ? 'skill-requests-' + process.argv[setArg + 1] : 'skill-requests'}.json`);   // --set fresh | heldout2: heldout2 is hand-written phrasings nothing was tuned on (do not iterate vocabulary against it)
const catalog = buildCatalog(loadGroups(toolDeps()));
let clarify = null;
try { ({ clarify } = require('../src/core/skills/clarify')); } catch { /* not there before the change */ }
const groupOf = name => catalog.groups.find(g => g.tools.some(t => t.name === name))?.id;

function run() {
  const out = { total: rows.length, byKind: {}, misses: [] };
  const bump = (k, ok, row, got) => {
    const b = (out.byKind[k] ||= { n: 0, ok: 0 }); b.n++; if (ok) b.ok++; else out.misses.push({ kind: k, text: row.text, want: row.group || row.outcome, got });
  };
  for (const row of rows) {
    const picked = selectGroups(row.text, { lastGroups: [], source: 'text' }, catalog);
    const c = clarify ? clarify(row.text, { lastGroups: [], picked, catalog }) : null;
    if (row.outcome === 'ask') bump('ask', c?.kind === 'ask', row, c ? c.kind : picked.join('+'));
    else if (row.outcome === 'decline') bump('decline', c?.kind === 'decline', row, c ? c.kind : picked.join('+'));
    else if (row.outcome === 'answer') bump('answer', !c, row, c ? c.kind : 'ok');
    else {
      const ok = !c && row.group.some(g => picked.includes(g)) && picked.includes(groupOf(row.tool));
      bump('act', ok, row, c ? `intercepted:${c.kind}` : picked.join('+'));
    }
  }
  const n = Object.values(out.byKind).reduce((a, b) => a + b.n, 0), ok = Object.values(out.byKind).reduce((a, b) => a + b.ok, 0);
  out.accuracy = Math.round(ok / n * 1000) / 10;
  return out;
}

const r = run();
if (process.argv.includes('--json')) console.log(JSON.stringify({ accuracy: r.accuracy, byKind: r.byKind }));
else {
  console.log(`skill selection accuracy: ${r.accuracy}% (${r.total} requests)`);
  for (const [k, v] of Object.entries(r.byKind)) console.log(`  ${k.padEnd(8)} ${v.ok}/${v.n}`);
  for (const m of r.misses) console.log(`  miss [${m.kind}] "${m.text}" wanted ${JSON.stringify(m.want)}, got ${m.got}`);
}
