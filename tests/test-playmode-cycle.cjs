/**
 * Play Mode 循环测试 — 进出 Play Mode 验证 bridge 自动重连。
 *
 * 流程:
 *   1. 进入 Play Mode
 *   2. 等待 5s
 *   3. 退出 Play Mode
 *   4. 等待 3s
 *   5. 进入 Play Mode
 *   6. 等待 4s
 *   7. 退出 Play Mode
 *
 * 用法: node tests/test-playmode-cycle.cjs
 * 前置条件: node dist/index.js 已在运行, Unity bridge 已连接
 */
const http = require('http');
const { readFileSync, existsSync } = require('fs');
const { join } = require('path');

const config = JSON.parse(
  existsSync(join(__dirname, '..', 'config.json'))
    ? readFileSync(join(__dirname, '..', 'config.json'), 'utf-8')
    : '{"ip":"127.0.0.1","port":45678}'
);

const BASE_URL = `http://${config.ip}:${config.port}`;

let callId = 0;
function nextId() { return ++callId; }

function httpPost(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      method: 'POST', hostname: config.ip, port: config.port, path: '/rpc',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callTool(name, args = {}) {
  const id = nextId();
  const resp = await httpPost({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name, arguments: args }
  });
  return resp;
}

async function waitForBridgeConnected(maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const health = await new Promise((resolve, reject) => {
        http.get(`${BASE_URL}/health`, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => resolve(JSON.parse(body)));
        }).on('error', reject);
      });
      if (health.bridgeConnected) {
        return health;
      }
    } catch {}
    await sleep(300);
  }
  throw new Error(`Bridge not connected after ${maxWaitMs}ms`);
}

async function toolReady(name, maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const resp = await callTool(name);
    if (resp.result && !resp.error) return resp;
    if (resp.error) {
      // Tool might not be registered yet — wait for reconnect
      await sleep(500);
      continue;
    }
    await sleep(300);
  }
  throw new Error(`Tool ${name} not ready after ${maxWaitMs}ms`);
}

async function main() {
  console.log('=== Play Mode Cycle Test ===\n');

  // ── Health check ──
  const health = await waitForBridgeConnected();
  console.log(`Server: ${BASE_URL}`);
  console.log(`Bridge: connected, ${health.totalTools} tools, state=${health.playModeState}\n`);
  await sleep(500);

  // ── MCP initialize ──
  const initResp = await httpPost({
    jsonrpc: '2.0', id: nextId(), method: 'initialize',
    params: { protocolVersion: '0.1.0', capabilities: {}, clientInfo: { name: 'playmode-test', version: '1.0.0' } }
  });
  if (initResp.error) { console.log(`Init: ❌ ${initResp.error.message}`); process.exit(1); }
  console.log('MCP initialized ✅');

  await httpPost({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await sleep(300);

  // ── Step 1: Enter Play Mode ──
  console.log('\n▶ Step 1: Enter Play Mode');
  let resp = await callTool('scene.enter_play_mode');
  console.log(`   Result: ${resp.error ? '❌ ' + resp.error.message : '✅'}`);
  if (resp.error) process.exit(1);

  // Wait 5s in play mode
  console.log('   Waiting 5s...');
  for (let i = 5; i > 0; i--) { await sleep(1000); console.log(`   ${i}...`); }

  // ── Step 2: Exit Play Mode ──
  console.log('\n▶ Step 2: Exit Play Mode');
  // Bridge may be reconnecting — wait for it
  console.log('   Waiting for bridge reconnection...');
  await waitForBridgeConnected();
  resp = await toolReady('scene.exit_play_mode');
  console.log(`   Result: ${resp.error ? '❌ ' + resp.error.message : '✅'}`);

  // Wait 3s
  console.log('   Waiting 3s...');
  for (let i = 3; i > 0; i--) { await sleep(1000); console.log(`   ${i}...`); }

  // ── Step 3: Enter Play Mode again ──
  console.log('\n▶ Step 3: Enter Play Mode (2nd)');
  await waitForBridgeConnected();
  resp = await toolReady('scene.enter_play_mode');
  console.log(`   Result: ${resp.error ? '❌ ' + resp.error.message : '✅'}`);

  // Wait 4s
  console.log('   Waiting 4s...');
  for (let i = 4; i > 0; i--) { await sleep(1000); console.log(`   ${i}...`); }

  // ── Step 4: Exit Play Mode ──
  console.log('\n▶ Step 4: Exit Play Mode (2nd)');
  await waitForBridgeConnected();
  resp = await toolReady('scene.exit_play_mode');
  console.log(`   Result: ${resp.error ? '❌ ' + resp.error.message : '✅'}`);

  // ── Final check ──
  await sleep(1000);
  const finalHealth = await waitForBridgeConnected();
  const pmResp = await callTool('scene.get_play_mode');
  const pmText = pmResp.result?.content?.[0]?.text || 'unknown';
  console.log(`\n=== TEST COMPLETE ===`);
  console.log(`Bridge: ${finalHealth.bridgeConnected ? '✅ connected' : '❌ disconnected'}`);
  console.log(`Play mode: ${pmText}`);
  console.log(`Tool count: ${finalHealth.totalTools}`);
  console.log('\n*** TEST PASSED ***');
}

main().catch(err => { console.error('Test failed:', err); process.exit(1); });
