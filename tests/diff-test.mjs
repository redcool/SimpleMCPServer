// BISECT: what makes test-bridge.mjs different from working tests?

const PORT = process.env.UNITY_MCP_PORT || 45678;
let reqId = 0;
const pending = new Map();
let ws;

function call(method, params = {}) {
  const id = `test_${++reqId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout: ${method}`));
    }, 8000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, paramsJson: JSON.stringify(params) }));
  });
}

async function main() {
  console.log(`Connecting to ws://127.0.0.1:${PORT}...`);
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

  ws.onmessage = (ev) => {
    console.log('onmessage fired');
    let raw;
    try {
      raw = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
      console.log('raw type:', typeof raw, 'raw length:', raw.length);
      console.log('raw preview:', raw.slice(0, 80));
    } catch (decodeErr) {
      console.error('DECODE ERROR:', decodeErr.message);
      raw = String(ev.data);
    }
    try {
      const resp = JSON.parse(raw);
      console.log('parsed OK, id:', resp.id);
      const entry = resp.id && pending.get(resp.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(resp.id);
        if (resp.error) entry.reject(new Error(resp.error));
        else entry.resolve(resp.result ?? 'null');
      }
    } catch (parseErr) {
      console.error('PARSE ERROR:', parseErr.message);
      // Reject all pending
      for (const [id, e] of pending) {
        clearTimeout(e.timer);
        e.reject(parseErr);
        pending.delete(id);
      }
    }
  };

  ws.onclose = () => {
    console.log('onclose fired');
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Connection closed'));
      pending.delete(id);
    }
  };

  // Wait for open
  await new Promise((resolve, reject) => {
    ws.onopen = () => {
      console.log('onopen fired');
      resolve();
    };
    ws.onerror = (e) => {
      console.error('onerror:', e?.message || e?.type);
      reject(new Error('Connection failed'));
    };
  });

  console.log('✅ Connected!\n');

  try {
    console.log('📋 Test 1: scene.get_hierarchy');
    const raw = await call('scene.get_hierarchy');
    console.log('call() returned, type:', typeof raw, 'val:', raw?.slice?.(0, 60) || raw);
    const hierarchy = JSON.parse(raw);
    console.log(`   → ${hierarchy.length} root objects`);
    hierarchy.forEach((o, i) => console.log(`     [${i}] "${o.name}"`));
    console.log('✅ OK');
  } catch (err) {
    console.error(`\n❌ Test failed: ${err.message}`);
  } finally {
    ws.close();
  }
}

main().catch((err) => {
  console.error(`\n❌ Fatal: ${err.message}`);
  process.exit(1);
});
