// Skill groups: tools regrouped by area. Each group file exports createGroup(deps) → Group | null.
// Group = { id, label, triggers, hint?, tools, status?, summary?, examples?, sideEffects? }   (last three: capability.js)
// status() → { ok, detail } (may be async): whether the group can work right now (extension connected, sysmon up...).
const { buildCardsNow } = require('./capability');
const { buildToolCard } = require('./toolcards');
const ORDER = ['core', 'media', 'ytmusic', 'timers', 'monitors', 'knowledge', 'system', 'pc', 'math', 'memory', 'windows', 'audio-display', 'connectivity', 'clipboard-capture', 'screen-vision', 'files', 'browser', 'self', 'web', 'lyrics', 'lists', 'stockman'];

// The groups that loaded, in ORDER. The array also carries .missing: [{ id, error? }], the groups left out:
// error is set when the group file threw (one broken group must not stop the app), absent when it simply
// has no tools with these dependencies.
function loadGroups(deps = {}) {
  const groups = [];
  groups.missing = [];
  for (const id of ORDER) {
    let g;
    try { g = require(`./${id}`).createGroup(deps); } catch (err) { groups.missing.push({ id, error: err?.message || String(err) }); continue; }
    if (g && g.tools.length) groups.push(g); else groups.missing.push({ id });
  }
  return groups;
}

function buildCatalog(groups) {
  const byName = new Map();
  const tools = [];
  const byGroup = new Map();
  for (const g of groups) {
    for (const tool of g.tools) {
      tools.push(tool);
      byGroup.set(tool.name, g.id);
      byName.set(tool.name, { tool, groupId: g.id });
    }
  }
  // aliases never shadow a real tool name
  for (const g of groups) for (const tool of g.tools) for (const a of tool.aliases || []) if (!byName.has(a)) byName.set(a, { tool, groupId: g.id });
  // cardsNow(): descriptive capability cards for the intent interpreter (capability.js), the one API; it awaits each
  // group's status() once. Cards never grant permission.
  return {
    groups, tools, ids: groups.map(g => g.id), missing: groups.missing || [], byName, groupOf: name => byName.get(name)?.groupId ?? null,
    cardsNow: () => buildCardsNow(groups),
    // toolCardsNow(): one card per tool, awaiting each group's status() once; a tool inherits its group's availability.
    toolCardsNow: async () => {
      const byId = new Map((await buildCardsNow(groups)).map(c => [c.id, c]));
      return new Map(tools.map(t => [t.name, buildToolCard(t, byGroup.get(t.name), byId.get(byGroup.get(t.name)))]));
    },
  };
}

// One line for the prompt's Capabilities: every group, so the model knows what exists when a group is not loaded.
// state.browser: 'off' | 'not connected' | 'connected' (shown on the browser group).
function capsLine(catalog, state = {}) {
  const parts = catalog.groups.filter(g => g.id !== 'core').map(g => {
    const note = g.id === 'browser' && state.browser ? ` [${state.browser}]` : '';
    return `${g.id} = ${g.label}${note}`;
  });
  return `skill areas, NOT tools: never call these names. The tools of the areas this request needs are already loaded; use only tools from your tool list, exactly as named. If you need another area, call more_skills with its id: ${parts.join('; ')}`;
}

module.exports = { loadGroups, buildCatalog, capsLine, ...require('./select') };
