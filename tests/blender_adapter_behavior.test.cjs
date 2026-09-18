'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
let adapter, tools;
test.before(async () => {
  [adapter, tools] = await Promise.all([
    import('../dist/blender/blenderAdapter.js'),
    import('../dist/blender/blenderTools.js'),
  ]);
});
const config = (overrides = {}) => ({
  evalEnabled: true,
  allowedTools: [],
  limits: { maxToolArgsBytes: 1024 * 1024 },
  mcpServers: [
    { name: 'one', toolsPrefix: 'blender', enabled: true },
    { name: 'two', toolsPrefix: 'blender2', enabled: true },
  ],
  ...overrides,
});
function deps(cfg, available, calls) {
  return { getConfig: () => cfg, isAvailable: name => available.includes(name), call: async (name, args) => { calls.push({ name, args }); return { ok: true }; } };
}
test('explicit Blender adapter is selected and routing metadata is stripped', async () => {
  const calls = [];
  const result = await tools.runCuratedBlenderTool('blender.anim.list', { adapter: 'blender2' }, deps(config(), ['blender2.execute_blender_code'], calls));
  assert.equal(result, JSON.stringify({ ok: true }));
  assert.equal(calls[0].name, 'blender2.execute_blender_code');
  assert.deepEqual(Object.keys(calls[0].args), ['code']);
});
test('unavailable explicit adapter fails without fallback', () => {
  assert.throws(() => adapter.resolveBlenderExecutionTool({ adapter: 'blender2' }, config(), () => false), /blender2/);
});
test('omitted adapter uses configured first available adapter', () => {
  assert.equal(adapter.resolveBlenderExecutionTool({}, config(), name => name === 'blender2.execute_blender_code'), 'blender2.execute_blender_code');
});
test('structured adapter results are normalized for MCP and RPC', async () => {
  assert.equal(adapter.blenderResultText({ value: 1 }), JSON.stringify({ value: 1 }));
  const calls = [];
  const mcp = await tools.callCuratedBlenderMcp('blender.anim.list', {}, deps(config(), ['blender.execute_blender_code'], calls));
  assert.equal(mcp.content[0].text, JSON.stringify({ ok: true }));
  const rpc = await tools.callCuratedBlenderRpc(7, 'blender.anim.list', {}, deps(config(), ['blender.execute_blender_code'], calls));
  assert.equal(rpc.id, 7);
  assert.equal(rpc.result.content[0].text, JSON.stringify({ ok: true }));
});
