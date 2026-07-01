const PORT = process.env.UNITY_MCP_PORT || 45678;

// Minimal version: copy test-simple's proven approach, add promise wrapper
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
ws.binaryType = 'arraybuffer';

ws.onopen = () => {
  console.log('Connected!');
  
  // Send request
  const msg = JSON.stringify({id:'call_1',method:'scene.get_hierarchy',paramsJson:'{}'});
  console.log('Sending:', msg);
  ws.send(msg);
};

ws.onmessage = (ev) => {
  const typ = typeof ev.data;
  const cons = ev.data?.constructor?.name || '?';
  const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
  console.log(`Received: type=${typ} constructor=${cons}`);
  console.log('Content:', text.slice(0, 200));
  try {
    const obj = JSON.parse(text);
    console.log(`✅ Valid JSON, id=${obj.id}, result length=${obj.result?.length}`);
  } catch (e) {
    console.log(`❌ JSON parse error: ${e.message}`);
  }
  ws.close();
};

ws.onerror = (e) => console.log('Error:', e?.message || e?.type || '?');
ws.onclose = (e) => console.log('Closed:', e.code, e.reason);
