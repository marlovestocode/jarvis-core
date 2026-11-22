// Lists for the model: add to, show, remove from and clear named lists ("grocery", "todo"). Every change is read back from the
// store before it is reported. Clearing a list asks first.
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });
const items = a => (Array.isArray(a) ? a : a == null ? [] : [a]).map(x => String(x ?? '').trim()).filter(Boolean);
const say = a => a.map(x => `"${x}"`).join(', ');

function createListTools({ lists, confirm = null }) {
  const listAdd = {
    name: 'list_add', risk: 'safe', effect: 'write',
    examples: ['add milk to my grocery list', 'put eggs on the shopping list', 'add a task to my todo list'],
    hint: "list_add / list_show / list_remove / list_clear: the user's own named lists (grocery, todo...). Say what the result says changed.",
    description: 'Add one or more items to a named list ("grocery", "todo"); the list is created if new.',
    params: obj({ list: { description: 'list name, e.g. "grocery"', type: 'string' }, items: { description: 'what to add, one entry per item', type: 'array', items: { type: 'string' } } }, ['list', 'items']),
    async run({ list, items: raw } = {}) {
      const want = items(raw);
      if (!String(list || '').trim()) throw new Error('Which list?');
      if (!want.length) throw new Error('What should I add?');
      const r = lists.add(list, want);
      const now = lists.get(list);
      const missing = r.added.filter(a => !now?.items.some(x => x.toLowerCase() === a.toLowerCase()));
      if (missing.length) throw new Error(`${say(missing)} did not end up on the ${r.name} list`);
      const parts = [];
      if (r.added.length) parts.push(`Added ${say(r.added)} to your ${r.name} list (${r.total} item${r.total === 1 ? '' : 's'} now).`);
      if (r.dupes.length) parts.push(`${say(r.dupes)} ${r.dupes.length === 1 ? 'was' : 'were'} already on it.`);
      return parts.join(' ');
    },
  };

  const listShow = {
    name: 'list_show', risk: 'safe', effect: 'read',
    hint: 'list_show: see list_add.',
    description: 'Show the items on a named list, or the names of all lists when no list is given.',
    params: obj({ list: { description: 'list name; omit to see all lists', type: 'string' } }),
    async run({ list } = {}) {
      if (!String(list || '').trim()) {
        const all = lists.names();
        return all.length ? `Lists: ${all.map(l => `${l.name} (${l.count})`).join('; ')}.` : 'You have no lists yet.';
      }
      const l = lists.get(list);
      if (!l) throw new Error(`There is no list called "${list}". Lists: ${lists.names().map(x => x.name).join(', ') || 'none'}.`);
      return l.items.length ? `${l.name} list (${l.items.length}): ${l.items.map((x, i) => `${i + 1}. ${x}`).join('; ')}.` : `The ${l.name} list is empty.`;
    },
  };

  const listRemove = {
    name: 'list_remove', risk: 'safe', effect: 'write',
    hint: 'list_remove: see list_add.',
    description: 'Remove one item from a named list (exact words, or words from it).',
    params: obj({ list: { description: 'list name', type: 'string' }, item: { description: 'the item to remove', type: 'string' } }, ['list', 'item']),
    async run({ list, item } = {}) {
      if (!String(item || '').trim()) throw new Error('Which item?');
      const r = lists.remove(list, item);
      if (!r.found) throw new Error(`There is no list called "${list}"`);
      if (r.ambiguous) throw new Error(`Which one: ${r.ambiguous.join('; ')}?`);
      if (!r.removed.length) throw new Error(`"${item}" is not on the ${list} list`);
      if (lists.get(list)?.items.includes(r.removed[0])) throw new Error(`${r.removed[0]} is still on the list`);
      return `Removed "${r.removed[0]}" from your ${r.name} list (${r.total} left).`;
    },
  };

  const listClear = {
    name: 'list_clear', risk: 'confirm', effect: 'write',
    hint: 'list_clear: see list_add. Empties a whole list, so it asks first.',
    description: 'Empty a named list. Asks the user first.',
    params: obj({ list: { description: 'list name', type: 'string' } }, ['list']),
    async run({ list } = {}) {
      if (!confirm) throw new Error('Clearing lists is not available right now');
      const l = lists.get(list);
      if (!l) throw new Error(`There is no list called "${list}"`);
      if (!l.items.length) return `The ${l.name} list is already empty.`;
      return confirm.propose({
        tool: 'list_clear', summary: `Clear your ${l.name} list (${l.items.length} item${l.items.length === 1 ? '' : 's'})`, args: { list },
        run: async () => {
          const r = lists.clear(list);
          if (lists.get(list)?.items.length) throw new Error('The list is not empty after clearing');
          return `Cleared your ${r.name} list (${r.removed} item${r.removed === 1 ? '' : 's'}).`;
        },
      });
    },
  };

  return [listAdd, listShow, listRemove, listClear];
}

module.exports = { createListTools };
