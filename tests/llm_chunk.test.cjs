const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const mod = () => import('../dist/llm.js');

test('llm client decodes multibyte chars across chunk boundaries cleanly', async () => {
  const payload = JSON.stringify({ choices: [{ message: { content: '零补丁摄入机制确定,核心决定包括持续脱敏规范与函数级校验' } }] });
  const buf = Buffer.from(payload, 'utf8');
  // 找一个多字节字符的续字节作为切点,强制腰斩
  let k = 3;
  while (k < buf.length && (buf[k] & 0xC0) === 0x80) k++;
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(buf.subarray(0, k));
    setTimeout(() => { res.write(buf.subarray(k)); res.end(); }, 10);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const { callLLMWithEndpoints } = await mod();
    const text = await callLLMWithEndpoints({ prompt: 'hi' }, [{ baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'mock', apiKey: 'k', provider: 'openai' }]);
    assert.ok(!text.includes('\uFFFD'), 'no replacement chars: ' + JSON.stringify(text));
    assert.ok(text.includes('零补丁') && text.includes('规范'), 'chinese intact');
  } finally { srv.close(); }
});
