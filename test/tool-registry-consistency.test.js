const test = require('node:test');
const assert = require('node:assert/strict');
const { toolDeps } = require('./helpers/tool-deps');
const { loadGroups, buildCatalog, capsLine } = require('../src/core/skills');
const { systemPrompt } = require('../src/core/brain/prompt');
const { resolveInvented } = require('../src/core/tools/invented');

// The tools are the one source of truth for what Jarvis can do. Their name, description, parameters, the guidance line the
// prompt shows (hint), their known wrong names (aliases, mistakes) and their group all live with them; the prompt, the
// capabilities line and the runner are generated from that. These tests fail if a copy of any of it can drift again.
const groups = loadGroups(toolDeps());
const catalog = buildCatalog(groups);
const tools = catalog.tools;
const names = new Set(tools.map(t => t.name));

test('registry: every group loaded and every tool is complete', () => {
  assert.deepEqual(groups.missing, [], 'a group failed to load');
  assert.ok(tools.length >= 90);
  for (const t of tools) {
    assert.match(t.name, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, `${t.name}: tool names are snake_case`);
    assert.ok(String(t.description || '').length >= 20, `${t.name}: needs a real description`);
    assert.equal(t.params?.type, 'object', `${t.name}: params is a JSON schema object`);
    assert.equal(typeof t.run, 'function', `${t.name}: needs run()`);
  }
  assert.equal(names.size, tools.length, 'tool names are unique across all groups');
  for (const g of groups) assert.ok(g.label && g.label.length > 3, `${g.id}: a group needs a label`);
  assert.equal(new Set(groups.map(g => g.id)).size, groups.length, 'group ids are unique');
});

test('registry: every tool has guidance (its own hint, or one that names it), and the hint is about the tool it sits on', () => {
  const hints = tools.map(t => t.hint).filter(Boolean);
  for (const t of tools) {
    if (t.hint) assert.ok(t.hint.includes(t.name), `${t.name}: its hint should name it`);
    else assert.ok(hints.some(h => h.includes(t.name)), `${t.name}: has no hint, and no other hint covers it`);
    if (t.hint) assert.ok(t.hint.length < 700, `${t.name}: a hint is one short line of guidance (${t.hint.length} chars)`);
  }
});

// every word in a hint that looks like a tool name must be a real tool, or one of the tool's own action values
function enumWords(schema, out = new Set()) {
  if (!schema || typeof schema !== 'object') return out;
  for (const v of schema.enum || []) out.add(String(v));
  for (const v of Object.values(schema.properties || {})) enumWords(v, out);
  if (schema.items) enumWords(schema.items, out);
  return out;
}
test('registry: a hint never mentions a tool that does not exist', () => {
  for (const t of tools) {
    const own = enumWords(t.params);
    for (const m of (t.hint || '').matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) {
      assert.ok(names.has(m[0]) || own.has(m[0]), `${t.name}: its hint mentions "${m[0]}", which is not a tool or one of its actions`);
    }
  }
});

test('registry: aliases and mistakes point at real tools, collide with nothing, and rewrite to arguments the tool accepts', () => {
  const seen = new Map();
  for (const t of tools) {
    for (const a of t.aliases || []) {
      assert.ok(!names.has(a), `alias "${a}" of ${t.name} is a real tool`);
      assert.ok(!seen.has(a), `alias "${a}" belongs to both ${seen.get(a)} and ${t.name}`);
      seen.set(a, t.name);
      assert.match(a, /^[a-z][a-z0-9_]*$/, `alias ${a}`);
    }
    for (const mk of t.mistakes || []) assert.ok(mk.match instanceof RegExp, `${t.name}: a mistake needs a pattern`);
  }
  // every example name the tools list resolves, and what it resolves to is valid for that tool
  const media = tools.find(t => t.name === 'media_control');
  const actions = ['play', 'pause', 'toggle', 'stop', 'next', 'prev', 'seek', 'volume', 'mute', 'unmute', 'shuffle', 'repeat', 'queue', 'playpause'];
  for (const [bad, want] of [['ytm_pause', 'pause'], ['ytm_stop', 'stop'], ['ytm_next', 'next'], ['music_play', 'play'], ['media_prev', 'prev']]) {
    const r = resolveInvented(bad, tools, []);
    assert.equal(r.tool, 'media_control', bad);
    assert.equal(r.args.action, want, bad);
    assert.ok(actions.includes(r.args.action) && media, `${bad} -> an action media_control accepts`);
  }
  assert.equal(resolveInvented('ytmusic_stats', tools, []).tool, 'music_stats');
});

test('registry: the prompt is generated from the tools: every in-scope hint is in it, none for a tool that is not', () => {
  const p = systemPrompt({ tools, now: new Date('2026-01-01T00:00:00') });
  const seeOther = h => { const m = /^\w+: see (\w+)\./.exec(h); return !!m && names.has(m[1]); };
  for (const t of tools) if (t.hint && !seeOther(t.hint)) assert.ok(p.includes(t.hint), `${t.name}: its hint is missing from the prompt`);
  const few = systemPrompt({ tools: tools.filter(t => ['get_time', 'calculate'].includes(t.name)), now: new Date('2026-01-01T00:00:00') });
  assert.ok(few.includes(tools.find(t => t.name === 'calculate').hint));
  assert.ok(!few.includes(tools.find(t => t.name === 'media_control').hint), 'a tool that is not in scope adds nothing');
  assert.ok(!systemPrompt({ tools: ['calculate'], now: new Date() }).includes('every arithmetic step'), 'a bare name has no hint: the hint comes from the tool object');
});

test('registry: the capabilities line is generated from the groups and lists every group but core', () => {
  const line = capsLine(catalog);
  for (const g of groups.filter(x => x.id !== 'core')) assert.ok(line.includes(`${g.id} = ${g.label}`), `${g.id} is in the capabilities line`);
  assert.ok(!line.includes('core = '));
});
