/**
 * Full E2E test of Unity SimpleMCPBridge.
 * Uses Node.js native WebSocket (works on Node 24+).
 */
const PORT = process.env.UNITY_MCP_PORT || 45678;

let reqId = 0;
const pending = new Map();

/**
 * Send a JSON-RPC call and return the PARSED result object.
 * The return value is already JSON-decoded — do NOT JSON.parse it again.
 */
function call(ws, method, params = {}) {
  const id = `test_${++reqId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout: ${method}`));
    }, 8000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, paramsJson: JSON.stringify(params) }));
    console.log(`  ▶ ${method}...`);
  });
}

async function main() {
  console.log(`\n🔌 Connecting to ws://127.0.0.1:${PORT}...`);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

  ws.onmessage = (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
    let resp;
    try { resp = JSON.parse(raw); } catch {
      console.error(`  ⚠ Bad message: ${raw?.slice?.(0, 80)}`);
      return;
    }
    const entry = resp.id && pending.get(resp.id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(resp.id);
      if (resp.error) entry.reject(new Error(resp.error));
      else entry.resolve(resp.result); // already parsed — caller gets the object directly
    }
  };

  ws.onclose = () => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Connection closed'));
      pending.delete(id);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('Connection failed'));
  });

  console.log('✅ Connected!\n');

  try {
    // ── Test 1: Get Hierarchy ──
    console.log('📋 Test 1: scene.get_hierarchy');
    const hierarchy = await call(ws, 'scene.get_hierarchy');
    console.log(`   → ${hierarchy.length} root objects`);
    hierarchy.forEach((o, i) => console.log(`     [${i}] "${o.name}"`));
    console.log();

    // ── Test 2: Get Objects ──
    console.log('📋 Test 2: scene.get_objects');
    const objects = await call(ws, 'scene.get_objects', {});
    console.log(`   → ${objects.length} objects total\n`);

    // ── Test 3: Create Object ──
    console.log('📋 Test 3: scene.create_object');
    const created = await call(ws, 'scene.create_object', {
      name: 'MCP_Test_Cube', position: [0, 1, 0], scale: [1, 1, 1],
    });
    console.log(`   → Created: id=${created.instanceId} name="${created.name}"\n`);

    // ── Test 4: Set Transform ──
    console.log('📋 Test 4: scene.set_transform');
    const tfResult = await call(ws, 'scene.set_transform', {
      instanceId: created.instanceId, position: [3, 2, 0],
    });
    console.log(`   → ${JSON.stringify(tfResult)}\n`);

    // ── Test 5: Set Component Property ──
    console.log('📋 Test 5: scene.set_component_property');
    const cpResult = await call(ws, 'scene.set_component_property', {
      instanceId: created.instanceId, componentType: 'Transform', propertyName: 'localPosition', value: [1, 1, 1],
    });
    console.log(`   → ${JSON.stringify(cpResult)}\n`);

    // ── Test 6: Delete Object ──
    console.log('📋 Test 6: scene.delete_object');
    const delResult = await call(ws, 'scene.delete_object', {
      instanceId: created.instanceId,
    });
    console.log(`   → ${JSON.stringify(delResult)}\n`);

    console.log('🎉 All 6 tests passed!');
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
