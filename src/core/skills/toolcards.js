'use strict';
// Tool cards: one short, descriptive card per tool, plus its contract (what running it does and how to check it).
// DESCRIPTIVE ONLY, like capability cards: a card never grants permission. risk:'confirm', taint and exec() still decide.
// The tool author declares the contract on the tool; the defaults below are chosen to fail closed.
const { toolSideEffects } = require('./capability');
const { firstSentence } = require('../tools/constrain');

const EFFECTS = ['read', 'write', 'external'];
const CARD_FIELDS = ['name', 'groupId', 'summary', 'params', 'effect', 'idempotent', 'reversible', 'volatile', 'verify', 'requires', 'available', 'missingReason'];

function toolContract(tool) {
  // toolSideEffects fails closed (unknown => write); its 'none' has no tool-level meaning beyond "reads".
  const e = toolSideEffects(tool);
  const effect = e === 'none' ? 'read' : e;
  return {
    effect,
    idempotent: typeof tool.idempotent === 'boolean' ? tool.idempotent : effect === 'read',
    reversible: tool.reversible === true,
    volatile: tool.volatile === true,
    verify: tool.verify && typeof tool.verify === 'object' ? tool.verify : null,
    requires: Array.isArray(tool.requires) ? tool.requires.slice() : [],
  };
}

// "query:string*, limit:number": the one-line shape of the arguments (* = required).
function paramsDigest(schema) {
  const props = schema?.properties || {};
  const req = new Set(schema?.required || []);
  return Object.entries(props).map(([k, p]) => `${k}:${typeof p?.type === 'string' ? p.type : 'any'}${req.has(k) ? '*' : ''}`).join(', ');
}

function buildToolCard(tool, groupId, groupCard) {
  const c = toolContract(tool);
  return {
    name: tool.name,
    groupId,
    summary: tool.summary || firstSentence(tool.description, 140),
    params: paramsDigest(tool.params),
    effect: c.effect, idempotent: c.idempotent, reversible: c.reversible, volatile: c.volatile,
    // verify.args is a function: it stays on the tool, the card is plain data.
    verify: c.verify ? { tool: c.verify.tool, expect: typeof c.verify.expect === 'function' ? null : c.verify.expect } : null,   // null: derived per call
    requires: c.requires,
    available: groupCard ? groupCard.available : true,
    missingReason: groupCard ? groupCard.missingReason : null,
  };
}

// The one string that feeds both BM25 and embeddings, so the two rankers see the same words.
function cardText(card, tool = {}) {
  return [card.name.replace(/_/g, ' '), card.summary, card.params, ...(tool.examples || []), ...(tool.aliases || [])].filter(Boolean).join('. ');
}

function validateToolCard(c) {
  const errs = [];
  if (!c || typeof c !== 'object') return ['card is not an object'];
  for (const k of Object.keys(c)) if (!CARD_FIELDS.includes(k)) errs.push(`unknown field ${k}`);
  for (const k of CARD_FIELDS) if (!(k in c)) errs.push(`missing field ${k}`);
  for (const k of ['name', 'groupId', 'summary']) if (typeof c[k] !== 'string' || !c[k]) errs.push(`${k} must be a non-empty string`);
  if (typeof c.params !== 'string') errs.push('params must be a string');
  if (!EFFECTS.includes(c.effect)) errs.push(`effect must be one of ${EFFECTS.join('|')}`);
  for (const k of ['idempotent', 'reversible', 'volatile']) if (typeof c[k] !== 'boolean') errs.push(`${k} must be boolean`);
  if (c.verify !== null && (!c.verify || typeof c.verify.tool !== 'string' || (c.verify.expect !== null && typeof c.verify.expect !== 'object'))) errs.push('verify must be null or { tool, expect }');
  if (!Array.isArray(c.requires) || c.requires.some(r => typeof r !== 'string')) errs.push('requires must be a string[]');
  if (c.available !== null && typeof c.available !== 'boolean') errs.push('available must be boolean or null');
  if (c.available === false && !c.missingReason) errs.push('an unavailable card needs missingReason');
  return errs;
}

// Safe to run beside other calls in one step: it only reads, needs no confirmation and no clean turn.
function parallelSafe(tool) {
  return toolContract(tool).effect === 'read' && tool.risk !== 'confirm' && tool.needsClean !== true;
}

module.exports = { EFFECTS, CARD_FIELDS, toolContract, paramsDigest, buildToolCard, cardText, validateToolCard, parallelSafe };
