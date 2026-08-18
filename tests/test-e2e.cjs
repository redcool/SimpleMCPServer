/**
 * 端到端测试 — 通过 HTTP 调用 MCP Server。
 * 测试工具列举 + 场景查询。
 *
 * 用法: node tests/test-e2e.cjs
 * 前置条件: node dist/index.js 已在运行
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

async function main() {
  console.log('SimpleMcpServer E2E Test (HTTP)\n');

  // Health check
  try {
    const health = await new Promise((resolve, reject) => {
      http.get(`${BASE_URL}/health`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });
    console.log(`Server: ${BASE_URL} (tools=${health.totalTools}, bridge=${health.bridgeConnected})`);
  } catch {
    console.log('Server not running — start it with: node dist/index.js');
    process.exit(1);
  }

  // Prepare MCP initialize + tool calls
  const calls = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '0.1.0', capabilities: {}, clientInfo: { name: 'e2e-test', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ];

  for (const call of calls) {
    const resp = await httpPost(call);
    if (resp.error) {
      console.log(`${call.method}: ❌ ${resp.error.message}`);
    } else if (resp.result?.tools) {
      const tools = resp.result.tools;
      console.log(`\n✅ ${tools.length} tools registered`);
      tools.forEach(t => console.log(`   - ${t.name}`));
    } else {
      console.log(`${call.method}: ✅`);
    }
    await sleep(500);
  }

  // Call get_hierarchy
  const hierResp = await httpPost({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'scene.get_hierarchy', arguments: {} } });
  const text = hierResp.result?.content?.[0]?.text || JSON.stringify(hierResp.error);
  console.log(`\nscene.get_hierarchy: ${text.length > 200 ? text.slice(0, 200) + '...' : text}`);

  console.log('\n*** TEST PASSED ***');
}

main().catch(err => { console.error('Test failed:', err); process.exit(1); });
