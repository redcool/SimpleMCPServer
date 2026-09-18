'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'src', 'server.ts'), 'utf8');
const router = fs.readFileSync(path.join(root, 'src', 'blender', 'blenderAdapter.ts'), 'utf8');
const tools = fs.readFileSync(path.join(root, 'src', 'tools.ts'), 'utf8');
let adapter;
test.before(async () => { adapter = await import('../dist/blender/blenderAdapter.js'); });
test('all Blender execution paths use the shared adapter router', () => {
  assert.match(router, /executeBlenderCode\(args:Record/);
  assert.doesNotMatch(server, /const cfg=getCachedConfig\(\); for \(const prefix of \(cfg\.mcpServers/);
  assert.match(router, /args.adapter/);
  assert.match(router, /execute_blender_code/);
});
test('all curated Blender tools expose adapter selection', () => {
  assert.match(tools, /adapter/);
  assert.match(tools, /getCuratedBlenderTools/);
});