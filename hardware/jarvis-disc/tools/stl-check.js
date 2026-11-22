// Prints bounding box, volume and edge-manifold check for ASCII STL files.
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const t = fs.readFileSync(f, 'utf8');
  const v = [...t.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map(m => [+m[1], +m[2], +m[3]]);
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  let vol = 0;
  const edges = new Map();
  const key = p => p.map(n => n.toFixed(4)).join(',');
  for (let i = 0; i < v.length; i += 3) {
    const [a, b, c] = [v[i], v[i + 1], v[i + 2]];
    for (const p of [a, b, c]) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k1 = key(p), k2 = key(q), e = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
      edges.set(e, (edges.get(e) || 0) + 1);
    }
  }
  let open = 0, over = 0;
  for (const c of edges.values()) { if (c === 1) open++; else if (c > 2) over++; }
  const s = mx.map((m, i) => (m - mn[i]).toFixed(1));
  console.log(`${f}: ${v.length / 3} tris, size ${s.join(' x ')} mm, z ${mn[2].toFixed(1)}..${mx[2].toFixed(1)}, volume ${(vol / 1000).toFixed(1)} cm3, open edges ${open}, non-manifold edges ${over}`);
}
