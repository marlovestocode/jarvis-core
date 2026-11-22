// Count real lines of code in jarvis-core (blank and comment-only lines excluded).
// Skips dependencies, native engines, tooling state, and test/eval data dumps.
//   node scripts/loc.js            summary table per language
//   node scripts/loc.js --verbose  also list every file, biggest first
//   node scripts/loc.js --dirs     also break the code down by folder
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.superpowers', '.claude', '.playwright-mcp', 'engines', 'assets', 'o']);
const SKIP_FILES = new Set(['package-lock.json']);
// data, not code: recorded HTTP fixtures and voice-eval baselines
const SKIP_PATHS = [/^test\/fixtures\//, /^eval\/.*\.json$/, /^eval\/voice\//];

// ext -> { label, line: [line-comment starts], block: [[open, close]] }
const LANGS = {
  '.js':   { label: 'JavaScript', line: ['//'], block: [['/*', '*/']] },
  '.cjs':  { label: 'JavaScript', line: ['//'], block: [['/*', '*/']] },
  '.mjs':  { label: 'JavaScript', line: ['//'], block: [['/*', '*/']] },
  '.ps1':  { label: 'PowerShell', line: ['#'],  block: [['<#', '#>']] },
  '.css':  { label: 'CSS',        line: [],     block: [['/*', '*/']] },
  '.html': { label: 'HTML',       line: [],     block: [['<!--', '-->']] },
  '.json': { label: 'JSON',       line: [],     block: [] }
};

const countLines = (text, spec) => {
  const stats = { code: 0, comment: 0, blank: 0 };
  let inBlock = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { stats.blank++; continue; }
    if (inBlock) {
      stats.comment++;
      if (line.includes(inBlock)) inBlock = null;
      continue;
    }
    const block = spec.block.find(([open]) => line.startsWith(open));
    if (block) {
      stats.comment++;
      if (line.indexOf(block[1], block[0].length) >= 0) continue;
      inBlock = block[1];
      continue;
    }
    if (spec.line.some(tok => line.startsWith(tok))) { stats.comment++; continue; }
    stats.code++;
  }
  return stats;
};

const totals = {};
const files = [];
const walk = dir => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full);
      continue;
    }
    const lang = LANGS[path.extname(e.name).toLowerCase()];
    if (!lang || SKIP_FILES.has(e.name) || SKIP_PATHS.some(re => re.test(rel))) continue;
    const s = countLines(fs.readFileSync(full, 'utf8'), lang);
    files.push({ rel, label: lang.label, ...s });
    const t = totals[lang.label] || (totals[lang.label] = { files: 0, code: 0, comment: 0, blank: 0 });
    t.files++; t.code += s.code; t.comment += s.comment; t.blank += s.blank;
  }
};
walk(ROOT);

if (process.argv.includes('--verbose')) {
  files.sort((a, b) => b.code - a.code);
  console.log('file'.padEnd(52) + 'lang'.padEnd(12) + 'code'.padStart(6) + 'cmt'.padStart(6) + 'blank'.padStart(6));
  console.log('-'.repeat(82));
  for (const f of files) {
    console.log(f.rel.padEnd(52) + f.label.padEnd(12) + String(f.code).padStart(6) + String(f.comment).padStart(6) + String(f.blank).padStart(6));
  }
  console.log('-'.repeat(82));
}

if (process.argv.includes('--dirs')) {
  const byDir = {};
  for (const f of files) {
    const parts = f.rel.split('/');
    const key = parts.slice(0, parts.length > 2 ? 2 : 1).join('/');
    const d = byDir[key] || (byDir[key] = { files: 0, code: 0 });
    d.files++; d.code += f.code;
  }
  console.log('\nfolder'.padEnd(32) + 'files'.padStart(6) + 'code'.padStart(8));
  console.log('-'.repeat(46));
  for (const [key, d] of Object.entries(byDir).sort((a, b) => b[1].code - a[1].code)) {
    console.log(key.padEnd(32) + String(d.files).padStart(6) + String(d.code).padStart(8));
  }
  console.log();
}

const rows = Object.entries(totals).sort((a, b) => b[1].code - a[1].code);
const sum = { files: 0, code: 0, comment: 0, blank: 0 };
console.log('language'.padEnd(12) + 'files'.padStart(6) + 'code'.padStart(8) + 'comment'.padStart(9) + 'blank'.padStart(8));
console.log('-'.repeat(43));
for (const [label, t] of rows) {
  for (const k in sum) sum[k] += t[k];
  console.log(label.padEnd(12) + String(t.files).padStart(6) + String(t.code).padStart(8) + String(t.comment).padStart(9) + String(t.blank).padStart(8));
}
console.log('-'.repeat(43));
console.log('total'.padEnd(12) + String(sum.files).padStart(6) + String(sum.code).padStart(8) + String(sum.comment).padStart(9) + String(sum.blank).padStart(8));
