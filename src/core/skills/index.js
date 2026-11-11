// Skill groups: tools regrouped by area. Each group file exports createGroup(deps) → Group | null.
// Group = { id, label, triggers, hint?, tools }
const ORDER = ['core', 'media', 'ytmusic', 'timers', 'knowledge', 'system', 'pc', 'math', 'memory', 'windows', 'audio-display', 'connectivity', 'clipboard-capture', 'files', 'browser'];

function loadGroups(deps = {}) {
  return ORDER
    .map(id => require(`./${id}`).createGroup(deps))
    .filter(g => g && g.tools.length);
}

function buildCatalog(groups) {
  const byName = new Map();
  const tools = [];
  for (const g of groups) {
    for (const tool of g.tools) {
      tools.push(tool);
      byName.set(tool.name, { tool, groupId: g.id });
    }
  }
  // aliases never shadow a real tool name
  for (const g of groups) for (const tool of g.tools) for (const a of tool.aliases || []) if (!byName.has(a)) byName.set(a, { tool, groupId: g.id });
  return { groups, tools, ids: groups.map(g => g.id), byName, groupOf: name => byName.get(name)?.groupId ?? null };
}

// One line for the prompt's Capabilities: every group, so the model knows what exists when a group is not loaded.
// state.browser: 'off' | 'not connected' | 'connected' (shown on the browser group).
function capsLine(catalog, state = {}) {
  const parts = catalog.groups.filter(g => g.id !== 'core').map(g => {
    const note = g.id === 'browser' && state.browser ? ` [${state.browser}]` : '';
    return `${g.id} = ${g.label}${note}`;
  });
  return `skill groups (the tools of the ones this request needs are loaded; call more_skills with a group id to load another): ${parts.join('; ')}`;
}

module.exports = { loadGroups, buildCatalog, capsLine, ...require('./select') };
