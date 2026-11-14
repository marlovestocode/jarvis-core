'use strict';
// Capability cards: a short, descriptive card per skill group, built for the intent interpreter to choose from.
// DESCRIPTIVE ONLY. A card never grants permission: risk:'confirm', taint and the guest/owner checks still decide.
// Tools and groups may carry optional metadata: tool { category?, sideEffects?, requires? }, group { summary?, examples?, sideEffects? }.
const { READ_ONLY } = require('../tasks/effects');

const SIDE_EFFECTS = ['none', 'read', 'write', 'external'];
const EFFECT_VALUES = ['read', 'write', 'external'];
const CARD_FIELDS = ['id', 'label', 'summary', 'examples', 'sideEffects', 'available', 'missingReason'];

// Default summary + example requests per group id. A group file may override with its own summary/examples.
// web is 'external': it reaches out to the network, which the read-only list alone does not say.
const GROUP_META = {
  core: { summary: 'Tells the time and reports how JARVIS itself is doing; loads other skill areas.', examples: ['what time is it', 'how are you doing'] },
  media: { summary: 'Controls music and media playback and the system volume.', examples: ['pause the music', 'skip this song', 'volume down'] },
  ytmusic: { summary: 'Plays from the YouTube Music library and playlists, and reports listening stats.', examples: ['play my liked songs', 'what do I listen to most'] },
  timers: { summary: 'Sets, lists and cancels timers, alarms and reminders.', examples: ['set a timer for ten minutes', 'remind me at 5'] },
  monitors: { summary: 'Proactive heads-up warnings about timers, RAM, CPU and disk.', examples: ['warn me if the CPU gets hot'] },
  knowledge: { summary: 'Answers factual questions and gives weather, news headlines and sports scores.', examples: ['will it rain tomorrow', 'latest headlines', 'who won the game'] },
  system: { summary: 'Reads live PC hardware numbers: CPU, GPU, RAM and temperatures.', examples: ['how hot is my GPU', 'how much RAM is free'] },
  pc: { summary: 'Controls the PC: opens and closes apps and windows, locks, sleeps, shuts down.', examples: ['open notepad', 'lock the screen', 'close chrome'] },
  math: { summary: 'Exact math, unit conversion, date arithmetic and science constants.', examples: ['what is 15 percent of 240', 'convert 5 miles to km'] },
  memory: { summary: 'Remembers and forgets facts about the user, and recalls past chats.', examples: ['remember my cat is called Milo', 'what did we talk about yesterday'] },
  windows: { summary: 'Arranges windows, monitors and virtual desktops, and handles hung apps.', examples: ['snap this window left', 'move to desktop 2'] },
  'audio-display': { summary: 'Switches the sound output device and changes brightness, displays and night light.', examples: ['switch to my headphones', 'dim the screen'] },
  connectivity: { summary: 'Reports and changes Wi-Fi, Bluetooth, battery, power plan and focus assist.', examples: ['turn bluetooth off', 'how much battery is left'] },
  'clipboard-capture': { summary: 'Reads and writes the clipboard, keeps its history and takes screenshots.', examples: ['what is on my clipboard', 'take a screenshot'] },
  files: { summary: 'Finds, reads and inspects files and documents; renames, sorts, copies and zips them.', examples: ['find my biggest files', 'summarize this pdf', 'zip the photos folder'] },
  browser: { summary: 'Works with Chrome tabs, page text, downloads, history and bookmarks through the extension.', examples: ['what tabs do I have open', 'read this page', 'search my history'] },
  self: { summary: 'JARVIS self-check: diagnostics, skills list, version, settings and error log.', examples: ['run a self check', 'what can you do'] },
  web: { summary: 'Searches the web and reads the pages it finds.', examples: ['search the web for node 22 release notes', 'read this article'], sideEffects: 'external' },
  lyrics: { summary: 'Fetches song lyrics and finds a song from a line of its lyrics.', examples: ['lyrics for this song', 'which song goes never gonna give you up'] },
};

const RANK = { none: 0, read: 1, write: 2, external: 3 };

// Tool level: declared value, else confirm tools write, else READ_ONLY tools read, else write (it changes something).
function toolSideEffects(tool) {
  if (EFFECT_VALUES.includes(tool.effect)) return tool.effect;   // the tool author's own declaration (tool contract)
  if (SIDE_EFFECTS.includes(tool.sideEffects)) return tool.sideEffects;
  if (tool.risk === 'confirm') return 'write';
  return READ_ONLY.has(tool.name) ? 'read' : 'write';
}

// Group level: declared value, else the strongest effect among its tools.
function groupSideEffects(group, meta = GROUP_META[group.id] || {}) {
  const own = group.sideEffects || meta.sideEffects;
  if (SIDE_EFFECTS.includes(own)) return own;
  let top = 'none';
  for (const t of group.tools) { const e = toolSideEffects(t); if (RANK[e] > RANK[top]) top = e; }
  return top;
}

// Never calls status(): buildCardsNow awaits it once and passes the result in. No status means always available;
// a status that has not been resolved (undefined/null) means unknown (null), never a guess.
function availability(group, resolved) {
  if (typeof group.status !== 'function') return { available: true, missingReason: null };
  if (!resolved || typeof resolved !== 'object') return { available: null, missingReason: null };
  return resolved.ok ? { available: true, missingReason: null } : { available: false, missingReason: String(resolved.detail || 'unavailable') };
}

function buildCard(group, resolved) {
  const meta = GROUP_META[group.id] || {};
  return {
    id: group.id,
    label: group.label,
    summary: group.summary || meta.summary || group.label,
    examples: (group.examples || meta.examples || []).slice(),
    sideEffects: groupSideEffects(group, meta),
    ...availability(group, resolved),
  };
}

// Statuses may be sync, async or throwing: await each once, never throw, never leave a floating promise.
// A rejected or throwing status stays unknown (available:null). The single interpreter-facing API.
async function buildCardsNow(groups) {
  return Promise.all(groups.map(async g => {
    let r = null;
    if (typeof g.status === 'function') { try { r = await g.status(); } catch { /* unknown */ } }
    return buildCard(g, r);
  }));
}

function validateCard(c) {
  const errs = [];
  if (!c || typeof c !== 'object') return ['card is not an object'];
  for (const k of Object.keys(c)) if (!CARD_FIELDS.includes(k)) errs.push(`unknown field ${k}`);
  for (const k of CARD_FIELDS) if (!(k in c)) errs.push(`missing field ${k}`);
  for (const k of ['id', 'label', 'summary']) if (typeof c[k] !== 'string' || !c[k]) errs.push(`${k} must be a non-empty string`);
  if (!Array.isArray(c.examples) || c.examples.some(e => typeof e !== 'string' || !e)) errs.push('examples must be a string[]');
  if (!SIDE_EFFECTS.includes(c.sideEffects)) errs.push(`sideEffects must be one of ${SIDE_EFFECTS.join('|')}`);
  if (c.available !== null && typeof c.available !== 'boolean') errs.push('available must be boolean or null');
  if (c.missingReason !== null && typeof c.missingReason !== 'string') errs.push('missingReason must be string or null');
  if (c.available === false && !c.missingReason) errs.push('an unavailable card needs missingReason');
  return errs;
}

// Optional tool metadata: category (string), sideEffects (enum), requires (string[]).
function validateToolMeta(t) {
  const errs = [];
  if (t.category !== undefined && (typeof t.category !== 'string' || !t.category)) errs.push('category must be a string');
  if (t.sideEffects !== undefined && !SIDE_EFFECTS.includes(t.sideEffects)) errs.push(`sideEffects must be one of ${SIDE_EFFECTS.join('|')}`);
  if (t.requires !== undefined && (!Array.isArray(t.requires) || t.requires.some(r => typeof r !== 'string' || !r))) errs.push('requires must be a string[]');
  // tool contract (toolcards.js): effect, idempotent, reversible, volatile, verify
  if (t.effect !== undefined && !EFFECT_VALUES.includes(t.effect)) errs.push(`effect must be one of ${EFFECT_VALUES.join('|')}`);
  if (t.effect === 'read' && t.risk === 'confirm') errs.push('a confirm tool cannot be effect read');
  for (const k of ['idempotent', 'reversible', 'volatile']) if (t[k] !== undefined && typeof t[k] !== 'boolean') errs.push(`${k} must be a boolean`);
  if (t.verify !== undefined) {
    const v = t.verify;
    if (!v || typeof v.tool !== 'string' || !v.tool || typeof v.args !== 'function' || !v.expect || typeof v.expect !== 'object') errs.push('verify must be { tool: string, args: function, expect: object }');
  }
  return errs;
}

module.exports = { SIDE_EFFECTS, CARD_FIELDS, GROUP_META, toolSideEffects, groupSideEffects, buildCard, buildCardsNow, validateCard, validateToolMeta };
