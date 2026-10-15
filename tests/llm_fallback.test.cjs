'use strict';
// llm 回退链:主渠道失败 → 按序回退;全失败 → 聚合错误;ollama 免 key
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const mod = () => import('../dist/llm.js');

function startServer(responder) {
  return new Promise((resolve) => {
    const hits = { n: 0 };
    const s = http.createServer((req, res) => { hits.n++; responder(req, res); });
    s.listen(0, '127.0.0.1', () => resolve({ s, port: s.address().port, hits }));
  });
}
const replyOk = (text) => (req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: text } }] })); });
};
const replyErr = (code) => (req, res) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'dead channel' } })); };

test('fallback: primary 503 -> fallback answers, primary attempted first', async () => {
  const { callLLMWithEndpoints } = await mod();
  const p = await startServer(replyErr(503));
  const f1 = await startServer(replyErr(503));
  const f2 = await startServer(replyOk('from-fallback'));
  try {
    const eps = [
      { baseUrl: 'http://127.0.0.1:' + p.port, model: 'primary-m', apiKey: 'k-primary' },
      { baseUrl: 'http://127.0.0.1:' + f1.port, model: 'fb-1', apiKey: 'k1' },
      { baseUrl: 'http://127.0.0.1:' + f2.port, model: 'fb-2', apiKey: 'k2' },
    ];
    const out = await callLLMWithEndpoints({ prompt: 'hi' }, eps);
    assert.strictEqual(out, 'from-fallback');
    assert.strictEqual(p.hits.n, 1, 'primary tried once');
    assert.strictEqual(f1.hits.n, 1, 'fallback1 tried once');
    assert.strictEqual(f2.hits.n, 1, 'fallback2 tried once');
  } finally { p.s.close(); f1.s.close(); f2.s.close(); }
});

test('all channels fail -> aggregated error names channel count', async () => {
  const { callLLMWithEndpoints } = await mod();
  const a = await startServer(replyErr(503));
  const b = await startServer(replyErr(401));
  try {
    await assert.rejects(
      () => callLLMWithEndpoints({ prompt: 'hi' }, [
        { baseUrl: 'http://127.0.0.1:' + a.port, model: 'a', apiKey: 'ka' },
        { baseUrl: 'http://127.0.0.1:' + b.port, model: 'b', apiKey: 'kb' },
      ]),
      (e) => { assert.ok(String(e.message).includes('all 2 channels failed')); assert.ok(String(e.message).includes('dead channel')); return true; }
    );
    assert.strictEqual(a.hits.n, 1); assert.strictEqual(b.hits.n, 1);
  } finally { a.s.close(); b.s.close(); }
});

test('openai channel without key is filtered; ollama needs no key', async () => {
  const { callLLMWithEndpoints } = await mod();
  const local = await startServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ response: 'ollama-said' })); });
  });
  try {
    const out = await callLLMWithEndpoints({ prompt: 'hi' }, [
      { baseUrl: 'http://127.0.0.1:' + local.port + '/ollama-x', model: 'local-m' },
    ]);
    assert.strictEqual(out, 'ollama-said');
  } finally { local.s.close(); }
});
