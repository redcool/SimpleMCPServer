'use strict';
// M01 hub-side loader acceptance tests (M01 section 6). Run via hub npm test
const { test } = require('node:test');
const assert = require('node:assert');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const BRAIN_REPO = 'H:/ai_works/SimpleAIBrain';
async function tmpdir(tag) { return fsp.mkdtemp(path.join(os.tmpdir(), 'hub-m01-' + tag + '-')); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 80));

test('no aiBrain config -> graceful skip, hub unaffected', async () => {
  const { initBrain, getBrain } = await import('../dist/pluginHost.js');
  await initBrain('test', {});
  assert.strictEqual(getBrain(), null);
});

test('path to unbuilt dir -> graceful skip, no crash', async () => {
  const { initBrain, getBrain } = await import('../dist/pluginHost.js');
  const dir = await tmpdir('empty');
  await initBrain('test', { aiBrain: { path: dir } });
  assert.strictEqual(getBrain(), null);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('contractVersion=99 -> rejected with clear error', async () => {
  const { initBrain, getBrain } = await import('../dist/pluginHost.js');
  const dir = await tmpdir('cv99');
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'dist', 'index.js'), 'export function createBrainPlugin(){ return { contractVersion: 99, name: \"fake\", init: async()=>{}, getTools: ()=>[], callTool: async()=>({}), onToolEvent: ()=>{}, shutdown: async()=>{} }; }');
  await initBrain('test', { aiBrain: { path: dir } });
  assert.strictEqual(getBrain(), null, 'mismatched contract rejected');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('real brain loads: 8 memory.* tools, routing works, /brain/health, onToolEvent fires (rpc)', async (t) => {
  const mod = await import('../dist/pluginHost.js');
  const dataDir = await tmpdir('braindata');
  t.after(async () => { await mod.shutdownBrain(); await fsp.rm(dataDir, { recursive: true, force: true }); });
  await mod.initBrain('test', { aiBrain: { path: BRAIN_REPO, dataDir } });
  const brain = mod.getBrain();
  assert.ok(brain, 'brain loaded from repo dist');
  assert.strictEqual(brain.contractVersion, 1);
  const tools = brain.getTools();
  assert.strictEqual(tools.length, 8);
  for (const td of tools) assert.ok(td.name.startsWith('memory.'));
  // tools/call routable: whoami as guest (null identity) per M08 section 2
  const r = await brain.callTool('memory.whoami', {}, null);
  assert.strictEqual(r.isError, false);
  assert.strictEqual(r.content.role, 'guest');
  // stats as guest -> denied but routed (isError, readable)
  const denied = await brain.callTool('memory.stats', {}, null);
  assert.strictEqual(denied.isError, true);
  // /brain/health registered via RouteRegistrar
  const route = mod.handleBrainRoute('GET', '/brain/health', { socket: { remoteAddress: '127.0.0.1' } });
  const routeDenied = mod.handleBrainRoute('GET', '/brain/health', { socket: { remoteAddress: '10.9.9.9' } });
  assert.ok(routeDenied.handled);
  assert.strictEqual((await routeDenied.promise).status, 403, 'brain routes behind same IP whitelist');
  assert.ok(route.handled);
  const health = await route.promise;
  assert.strictEqual(health.status, 200);
  assert.ok(health.body.indexOf('ai-brain') !== -1);
  assert.strictEqual(mod.handleBrainRoute('GET', '/brain/nope', {}).handled, false);
  // onToolEvent fires via rpc path (web.search in default passive list)
  const out = await mod.withBrainEvent('web.search', { query: 'probe' }, null, 'rpc', async () => 'ok-text');
  assert.strictEqual(out, 'ok-text');
  await tick();
  const logDir = path.join(dataDir, 'memory', 'L0-log');
  const months = await fsp.readdir(logDir);
  const files = await fsp.readdir(path.join(logDir, months[0]));
  const text = await fsp.readFile(path.join(logDir, months[0], files[0]), 'utf8');
  assert.ok(text.indexOf('web.search') !== -1, 'passive toolflow logged');
  // memory.* never enters passive flow
  await mod.withBrainEvent('memory.save', { content: 'x' }, null, 'rpc', async () => ({ isError: false }));
  await tick();
  const text2 = await fsp.readFile(path.join(logDir, months[0], files[0]), 'utf8');
  assert.strictEqual(text2.trim().split('\n').length, 1, 'memory.* excluded from passive log');
});
