const { createPcTools } = require('../../tools/pc');
const { own } = require('../util');

const ALIASES = {
  open_app: ['launch_app', 'start_app', 'open_application', 'open_program'],
  close_app: ['close_application', 'quit_app', 'kill_app'],
  focus_window: ['switch_to', 'switch_window'],
  find_files: ['search_files', 'find_file'],
  open_path: ['open_file', 'open_folder'],
  move_files: ['move_file'],
  delete_to_recycle_bin: ['delete_file', 'delete_files', 'remove_file', 'trash'],
  undo_last: ['undo'],
  set_system_volume: ['volume'],
  lock_screen: ['lock'],
  power: ['shutdown', 'restart', 'sleep'],
};
const UNTRUSTED = new Set(['find_files', 'list_windows']);

function createGroup({ pc, media } = {}) {
  const tools = pc ? createPcTools({ ...pc, media }) : [];
  return { id: 'pc', label: 'PC control: apps, windows, files, volume, lock, power', triggers: [], tools: tools.map(t => own(t, ALIASES[t.name] || [], UNTRUSTED.has(t.name) ? { untrusted: true } : {})) };
}

module.exports = { createGroup };
