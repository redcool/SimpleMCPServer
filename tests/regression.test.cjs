const test = require('node:test');
const assert = require('node:assert/strict');

let config, crypto, state, tools;
test.before(async () => {
  [config, crypto, state, tools] = await Promise.all([
    import('../dist/config.js'), import('../dist/crypto.js'),
    import('../dist/bridgeState.js'), import('../dist/tools.js')
  ]);
});
test.after(() => {
  state.bridges.clear();
  state.toolToBridge.clear();
  state.pending.clear();
  state.pendingAI.clear();
});

test('安全默认：未提供来源地址不得访问，IPv4-mapped loopback 正确归一化', () => {
  assert.equal(config.isIpAllowed(undefined), false);
  assert.equal(config.isIpAllowed(''), false);
  assert.equal(config.isIpAllowed('::ffff:127.0.0.1'), true);
});

test('请求限制常量保持在有界值', () => {
  assert.equal(state.MAX_BRIDGES, 50);
  assert.equal(state.MAX_PENDING, 10000);
  assert.ok(state.MAX_BRIDGES > 0 && state.MAX_PENDING > state.MAX_BRIDGES);
});

test('加密协议：关闭时明文，开启时 AES 格式往返且篡改安全失败', () => {
  const cfg = config.getCachedConfig();
  assert.equal(crypto.isEncryptionEnabled(), false);
  assert.equal(crypto.encryptPayload('{"ok":true}'), '{"ok":true}');
  assert.equal(crypto.decryptPayload('{"ok":true}'), '{"ok":true}');
  cfg.encryption = true; cfg.encryptionKey = 'regression-test-key';
  const wire = crypto.encryptPayload('{"ok":true}');
  assert.match(wire, /^#ENC#[A-Za-z0-9+/]+=*$/);
  assert.equal(crypto.decryptPayload(wire), '{"ok":true}');
  assert.equal(crypto.decryptPayload(wire.slice(0, -2) + 'xx'), null);
  cfg.encryption = false; cfg.encryptionKey = '';
});

test('工具注册合并：重复工具名去重，危险 editor.eval 按配置门控', () => {
  state.bridges.set('bridge-a', { ws: {}, id: 'bridge-a', tools: [
    { name: 'editor.eval', description: 'eval', inputSchema: {type:'object'} },
    { name: 'custom.one', description: 'one', inputSchema: {type:'object'} }
  ], connectedAt: Date.now(), clientIp: '127.0.0.1', clientPort: 1 });
  state.toolToBridge.set('editor.eval', 'bridge-a');
  state.toolToBridge.set('custom.one', 'bridge-a');
  const merged = tools.getMergedTools();
  const names = merged.map(x => x.name);
  assert.equal(names.filter(x => x === 'custom.one').length, 1);
  assert.equal(names.filter(x => x === 'editor.eval').length, config.getCachedConfig().evalEnabled ? 1 : 0);
  assert.ok(names.includes('bridge.list'));
  assert.ok(names.includes('bridge.call'));
});

test('重复 requestId：检测到进行中的请求，不允许覆盖 pending 记录', () => {
  state.pendingAI.set('same-id', { resolve(){}, reject(){}, timer: setTimeout(()=>{}, 1000) });
  assert.equal(state.hasPendingAIRequest('same-id'), true);
  assert.equal(state.hasPendingAIRequest('new-id'), false);
  clearTimeout(state.pendingAI.get('same-id').timer);
});
