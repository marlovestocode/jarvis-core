'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrief } = require('../src/core/brief');

const cfg = () => ({ brief: { newsCount: 3 } });
const OK = {
  get_weather: 'Sunny, 20 degrees.',
  list_timers: 'Pasta timer: 5 minutes left, at 8:05 AM.',
  news_headlines: 'Headline one. Headline two.',
  connectivity_status: 'Wi-Fi: on. Bluetooth: off. Battery: 80%, charging. Power plan: Balanced. Focus assist: off.',
  list_windows: 'Open windows: chrome: Secret Bank Tab; code: file.js; chrome: Other.',
};
const make = (over = {}, extra = {}) => {
  const calls = [];
  const tools = { async run(name, args) { calls.push({ name, args }); const v = name in over ? over[name] : { ok: true, text: OK[name] }; if (typeof v === 'function') return v(); return v; } };
  return { calls, brief: createBrief({ tools, getConfig: cfg, now: () => new Date(2026, 10, 16, 8, 0), ...extra }) };
};

test('brief: all parts in order after the greeting', async () => {
  const { brief, calls } = make();
  const t = await brief.build();
  assert.match(t, /^Good morning/);
  const at = s => t.indexOf(s);
  assert.ok(at('Sunny') > 0 && at('Sunny') < at('Pasta') && at('Pasta') < at('Headline one') && at('Headline one') < at('Battery') && at('Battery') < at('chrome'));
  assert.deepEqual(calls.find(c => c.name === 'news_headlines').args, { count: 3 });
});

test('brief: a failing or throwing tool is dropped, the rest still speak', async () => {
  const { brief } = make({ get_weather: () => { throw new Error('boom'); }, news_headlines: { ok: false, text: 'Error: offline' } });
  const t = await brief.build();
  assert.match(t, /^Good morning/);
  assert.match(t, /Pasta/);
  assert.doesNotMatch(t, /undefined|offline|boom/);
});

test('brief: a tool that never answers is dropped after timeoutMs', async () => {
  const { brief } = make({ get_weather: () => new Promise(() => {}) }, { timeoutMs: 20 });
  const t = await brief.build();
  assert.match(t, /Pasta/);
  assert.doesNotMatch(t, /Sunny/);
});

test('brief: open apps are names only, never window titles', async () => {
  const { brief } = make();
  const t = await brief.build();
  assert.match(t, /chrome/);
  assert.match(t, /code/);
  assert.doesNotMatch(t, /Secret Bank Tab|file\.js/);
  assert.equal((t.match(/chrome/g) || []).length, 1);
});

test('brief: battery sentence only, and none on a desktop', async () => {
  const { brief } = make({ connectivity_status: { ok: true, text: 'Wi-Fi: on. Battery: no battery (this is a desktop). Power plan: Balanced.' } });
  const t = await brief.build();
  assert.doesNotMatch(t, /Wi-Fi|Power plan|no battery/i);
});

test('brief: every tool fails → just the greeting', async () => {
  const fail = { ok: false, text: 'x' };
  const { brief } = make({ get_weather: fail, list_timers: fail, news_headlines: fail, connectivity_status: fail, list_windows: fail });
  const t = await brief.build();
  assert.match(t, /^Good morning/);
  assert.ok(t.length < 80);
});

test('brief: greeting follows the hour', async () => {
  const at = h => make({}, { now: () => new Date(2026, 10, 16, h, 0) }).brief.build();
  assert.match(await at(14), /^Good afternoon/);
  assert.match(await at(20), /^Good evening/);
});
