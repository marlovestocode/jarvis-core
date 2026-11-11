// Skill groups: tools regrouped by area. Each group file exports createGroup(deps) → Group | null.
// Group = { id, label, triggers, hint?, tools }
const ORDER = ['core', 'media', 'ytmusic', 'timers', 'knowledge', 'system', 'pc', 'math', 'memory'];

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

module.exports = { loadGroups, buildCatalog };
