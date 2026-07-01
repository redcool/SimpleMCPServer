const ws = new WebSocket('ws://127.0.0.1:45678');
ws.binaryType = 'arraybuffer';

ws.onopen = () => {
  console.log('open');
  ws.send(JSON.stringify({id:'t1',method:'scene.get_hierarchy',paramsJson:'{}'}));
};

ws.onmessage = (ev) => {
  const d = ev.data;
  console.log('TYPE:', typeof d);
  console.log('CONS:', d?.constructor?.name);
  console.log('REPR:', d?.toString?.()?.slice?.(0,100));
  if (typeof d === 'string') {
    console.log('OK:', d.slice(0,120));
  }
  ws.close();
};

ws.onerror = (e) => console.log('ERR', e?.message || e?.type || e);
ws.onclose = (e) => console.log('CLOSE', e.code, e.reason);
