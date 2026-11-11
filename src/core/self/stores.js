// Where each kind of JARVIS's data lives (cortex wave 3 §5): in the cortex (<data>/cortex.db), in its own file, or in a
// file mirrored from the cortex. self_diagnostics prints it so the user and the model can see it. Waves add their rows.
const STORES = Object.freeze({
  'memory facts': 'cortex', 'chat summaries': 'cortex', 'people and things': 'cortex', knowledge: 'cortex', timers: 'cortex',
  'chat history': 'file', config: 'file', 'lookup cache': 'file', 'listening log': 'file', 'action log': 'file', 'web audit log': 'file',
});
const WHERE = [['cortex', 'in cortex'], ['file', 'file'], ['mirror', 'mirror']];

function storesLine(stores = STORES) {
  return WHERE.map(([k, label]) => [label, Object.keys(stores).filter(n => stores[n] === k)])
    .filter(([, names]) => names.length).map(([label, names]) => `${label}: ${names.join(', ')}`).join('; ');
}

module.exports = { STORES, storesLine };
