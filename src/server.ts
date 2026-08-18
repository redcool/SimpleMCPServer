// ── Main ──

import http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, WebSocket } from 'ws';
import { log } from './logger.js';
import { getCachedConfig, loadAppConfig, isIpAllowed, reloadConfig } from './config.js';
import { isEncryptionEnabled, encryptPayload, decryptPayload } from './crypto.js';
import { callLLM, AIRequestMessage } from './llm.js';
import {
  MAX_BRIDGES,
  bridges,
  toolToBridge,
  pending,
  pendingAI,
  isUnityCompiling,
  playModeState,
  rejectPendingForBridge,
  callBridgeById,
  callBridge,
  setUnityCompiling,
  setPlayModeState,
} from './bridgeState.js';
import { getMergedTools } from './tools.js';
import { handleABRequest } from './ab.js';

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

// ── WebSocket liveness tracking (half-open connection reaping) ──
type AliveWebSocket = WebSocket & { isAlive?: boolean; clientIp?: string };

/**
 * Retry queue for tool calls that were in-flight when ALL bridges disconnected.
 * On reconnect (register_tools from any bridge), these are re-sent.
 */
const retryQueue: Array<{
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  method: string;
  params: Record<string, unknown>;
  bridgeId: string;
}> = [];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
export async function main(): Promise<void> {
  const appCfg = reloadConfig();

  // ── MCP Server (protocol handlers: tools/list, tools/call) ──
  const server = new Server(
    { name: 'unity-mcp-server', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // ── Tool listing: merge all bridges' tools (dedup by name, last-wins) ──
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getMergedTools() };
  });

  // ── Tool call: route to the bridge that registered the tool ──
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // ── Server-side tools (bridge management) ──
    if (toolName === 'bridge.list') {
      const bridgeList = [...bridges.entries()].map(([id, info]) => ({
        id,
        clientIp: info.clientIp,
        clientPort: info.clientPort,
        displayName: `${info.clientIp}:${info.clientPort} (${id.slice(0, 8)})`,
        tools: info.tools.length,
        toolNames: info.tools.map(t => t.name),
        connectedForMs: Date.now() - info.connectedAt,
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(bridgeList, null, 2) }] };
    }

    if (toolName === 'bridge.call') {
      const target = String(args.target || '');
      const method = String(args.method || '');
      const params = (args.params || {}) as Record<string, unknown>;
      if (!target) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Missing required argument: target (bridgeId)' }) }], isError: true };
      if (!method) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Missing required argument: method (tool name)' }) }], isError: true };
      try {
        const result = await callBridgeById(target, method, params);
        return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }

    // ── Bridge-registered tools ──
    const bridgeId = toolToBridge.get(toolName);
    if (!bridgeId) {
      if (bridges.size === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No bridge connected' }) }],
          isError: true,
        };
      }
      const errMsg = `No bridge registered for tool '${toolName}' (${bridges.size} bridge(s) connected - use bridge.list to see all)`;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: errMsg }) }],
        isError: true,
      };
    }
    try {
      const result = await callBridge(toolName, args);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  });

  // ── SSE transport sessions (one per connected agent) ──
  const sessions = new Map<string, SSEServerTransport>();

  // ── HTTP + WebSocket Server (single port, plain ws://) ──
  // Encryption is done at the payload level (see encryptPayload/decryptPayload)
  // rather than at the transport layer (TLS/wss://), so both Editor (Mono)
  // and Android (IL2CPP) can connect without platform-specific TLS issues.
  let httpServer: http.Server = http.createServer();

  // ── WebSocket — Bridge/Game connections ──
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 4 * 1024 * 1024 });

  // Pong tracking: a bridge that stops responding to pings is half-open (dead socket
  // that never fires 'close'). Reap it with terminate() so its bridge slot frees up
  // and it doesn't linger against MAX_BRIDGES. terminate() triggers 'close' → the
  // normal connection cleanup path removes it from the bridges map / routing.
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const aliveWs = ws as AliveWebSocket;
      if (aliveWs.isAlive === false) {
        log(`[Server] Bridge unresponsive (no pong) — terminating ${aliveWs.clientIp || 'unknown'}`);
        ws.terminate();
        return;
      }
      aliveWs.isAlive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    });
  }, 30_000);

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const aliveWs = ws as AliveWebSocket;
    aliveWs.isAlive = true;
    aliveWs.clientIp = req.socket.remoteAddress || 'unknown';
    ws.on('pong', () => { aliveWs.isAlive = true; });
    // Log client IP and port — keep reference for disconnect/error logs
    const clientIp = req.socket.remoteAddress || 'unknown';
    const clientPort = req.socket.remotePort || 0;
    log(`[Server] New bridge connection from ${clientIp}:${clientPort} (${bridges.size} existing bridge(s))`);

    // Enforce max bridges limit
    if (bridges.size >= MAX_BRIDGES) {
      log(`[Server] Max bridges (${MAX_BRIDGES}) reached — rejecting new connection from ${clientIp}:${clientPort}`);
      ws.close(1013, 'Server busy: too many bridges');
      return;
    }

    // NOTE: We do NOT close existing bridges here.
    // Multiple bridges can coexist — each identifies itself via bridgeId in register_tools.
    // This is essential for domain reload: old bridge disconnects → new bridge
    // is already connected, so tool calls are never dropped during the transition.
    let bridgeId: string | null = null;

    let requestToolsTimer: ReturnType<typeof setTimeout> | null = null;

    function requestTools(): void {
      if (ws.readyState !== WebSocket.OPEN) return;
      // Notify bridge of encryption status before requesting tools
      const encryptionOn = isEncryptionEnabled();
      ws.send(JSON.stringify({ type: 'server_info', encryption: encryptionOn }), (err) => { if (err) log('[Server] ws.send failed:', err.message); });
      log(`[Server] Sent server_info (encryption=${encryptionOn}) to bridge`);
      ws.send(encryptPayload(JSON.stringify({ type: 'request_tools' })), (err) => { if (err) log('[Server] ws.send failed:', err.message); });
      log('[Server] Sent request_tools to bridge');
      let attempts = 0;
      function scheduleRetry(): void {
        if (attempts >= 3 || ws.readyState !== WebSocket.OPEN) return;
        requestToolsTimer = setTimeout(() => {
          attempts++;
          log(`[Server] Re-requesting tools (attempt ${attempts + 1})...`);
          ws.send(encryptPayload(JSON.stringify({ type: 'request_tools' })), (err) => { if (err) log('[Server] ws.send failed:', err.message); });
          scheduleRetry();
        }, 8000);
      }
      scheduleRetry();
    }

    ws.on('message', (raw: Buffer) => {
      let msg: any;
      const rawStr = raw.toString();

      // Decrypt payload if encryption is enabled
      const decrypted = decryptPayload(rawStr);
      if (decrypted === null) {
        log('[Server] Failed to decrypt bridge message — key mismatch?');
        // Send error as plaintext (peer clearly can't decrypt encrypted frames)
        try { ws.send(JSON.stringify({ type: 'error', code: 'decrypt_failed', message: 'Payload decryption failed — check encryptionKey' })); } catch {}
        return;
      }

      try {
        msg = JSON.parse(decrypted);
      } catch {
        log('[Server] Invalid JSON from bridge:', decrypted.slice(0, 200));
        return;
      }

      // Debug: log every incoming message type + payload size (NOT the body — may contain
      // scene data / prompts / tool args)
      const idStr = String(msg.id ?? '');
      const payloadSize = raw.byteLength;
      if (msg.type) {
        log(`[Server] Received message type="${msg.type}" from bridge [id=${idStr.slice(0,20) || 'none'}] (${payloadSize} bytes)`);
      } else if (msg.id) {
        // Tool response — look up tool name from pending map
        const pendingEntry = pending.get(msg.id);
        const toolLabel = pendingEntry ? ` tool='${pendingEntry.method}'` : '';
        log(`[Server] Received tool response${toolLabel} id="${idStr.slice(0,24)}" (${payloadSize} bytes)`);
      }

      // ── Tool registration (bridge identifies itself) ──
      if (msg.type === 'register_tools' && Array.isArray(msg.tools)) {
        const id: string = msg.bridgeId || `anon_${Date.now()}`;
        bridgeId = id;
        if (requestToolsTimer) clearTimeout(requestToolsTimer);
        setUnityCompiling(false);

        // Add/update this bridge in the bridges map
        bridges.set(id, { ws, id, tools: msg.tools, connectedAt: Date.now(), clientIp, clientPort });
        // Update tool→bridge routing (later bridges overwrite earlier for same-named tools)
        for (const tool of msg.tools) {
          toolToBridge.set(tool.name, id);
        }
        log(`[Server] Registered ${msg.tools.length} tool(s) from bridge [ID: ${id.slice(0, 8)} IP: ${clientIp}:${clientPort}] (${bridges.size} bridge(s) total)`);

        // Retry queued tool calls now that a bridge is available
        if (retryQueue.length > 0) {
          log(`[Server] Retrying ${retryQueue.length} queued tool calls via bridge [${bridgeId}]...`);
          if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
          const queue = [...retryQueue];
          retryQueue.length = 0;
          for (const entry of queue) {
            callBridge(entry.method, entry.params)
              .then(entry.resolve)
              .catch(entry.reject);
          }
        }

        return;
      }

      // ── AI Request from Bridge ──
      if (msg.type === 'ai_request') {
        const requestId = msg.requestId || `ai_${Date.now()}`;
        log(`[Server] AI request: ${requestId}, prompt: ${String(msg.prompt || '').slice(0, 80)}`);

        const llmCfg = getCachedConfig().llm;
        if (!llmCfg.enabled) {
          ws.send(encryptPayload(JSON.stringify({ type: 'ai_response', requestId, text: null, error: 'LLM is disabled on server (set llm.enabled=true in config.json)' })), (err) => { if (err) log('[Server] ws.send failed:', err.message); });
          return;
        }
        if (!llmCfg.apiKey) {
          ws.send(encryptPayload(JSON.stringify({ type: 'ai_response', requestId, text: null, error: 'LLM API key not configured (set llm.apiKey in config.json or LLM_API_KEY env var)' })), (err) => { if (err) log('[Server] ws.send failed:', err.message); });
          return;
        }

        const llmReq: AIRequestMessage = {
          prompt: msg.prompt || '',
          context: msg.context || {},
          system: msg.system || undefined,
          messages: msg.messages || undefined,
        };

        const aiTimeout = setTimeout(() => {
          if (pendingAI.has(requestId)) {
            pendingAI.delete(requestId);
            ws.send(encryptPayload(JSON.stringify({ type: 'ai_response', requestId, text: null, error: 'LLM request timed out (90s)' })), (err) => { if (err) log('[Server] ws.send failed:', err.message); });
          }
        }, 90_000);

        pendingAI.set(requestId, {
          resolve: (text: string) => {
            clearTimeout(aiTimeout);
            ws.send(encryptPayload(JSON.stringify({ type: 'ai_response', requestId, text, error: null })), (err) => { if (err) log('[Server] ws.send failed:', err.message); });
            pendingAI.delete(requestId);
          },
          reject: (err: Error) => {
            clearTimeout(aiTimeout);
            ws.send(encryptPayload(JSON.stringify({ type: 'ai_response', requestId, text: null, error: err.message })), (err2) => { if (err2) log('[Server] ws.send failed:', err2.message); });
            pendingAI.delete(requestId);
          },
          timer: aiTimeout,
        });

        callLLM(llmReq)
          .then((text) => {
            const entry = pendingAI.get(requestId);
            if (entry) {
              clearTimeout(entry.timer);
              entry.resolve(text);
            }
          })
          .catch((err: Error) => {
            const entry = pendingAI.get(requestId);
            if (entry) {
              clearTimeout(entry.timer);
              entry.reject(err);
            }
          });

        return;
      }

      // ── Compilation status from bridge ──
      if (msg.type === 'compilation') {
        setUnityCompiling(msg.status === 'started');
        log(`[Server] Unity compilation ${msg.status}`);
        return;
      }

      // ── Play mode state from bridge ──
      if (msg.type === 'playmode') {
        setPlayModeState(msg.status);
        log(`[Server] Unity play mode: ${msg.status}`);
        return;
      }

      // ── Tool call response (resolve pending promise) ──
      if (typeof msg.id === 'string' && pending.has(msg.id)) {
        const entry = pending.get(msg.id)!;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          const errMsg = typeof msg.error === 'string' ? msg.error : (msg.error.message || JSON.stringify(msg.error));
          entry.reject(new Error(errMsg));
        } else {
          entry.resolve(msg.result ?? 'null');
        }
        return;
      }

      log('[Server] Unknown message:', raw.toString().slice(0, 200));
    });

    requestTools();

    ws.on('close', () => {
      // Clear the request-tools timer (Bug fix: timer leak on early disconnect)
      if (requestToolsTimer) {
        clearTimeout(requestToolsTimer);
        requestToolsTimer = null;
      }

      // If this bridge had registered, clean up its state
      if (bridgeId && bridges.has(bridgeId)) {
        log(`[Server] Bridge disconnected  [ID: ${bridgeId.slice(0, 8)} IP: ${clientIp}:${clientPort}] (${bridges.size - 1} remaining)`);
        const info = bridges.get(bridgeId)!;

        // Remove this bridge's tools from the routing table,
        // and fall back to another bridge that also registered the same tool
        for (const tool of info.tools) {
          if (toolToBridge.get(tool.name) === bridgeId) {
            let fallback = false;
            for (const [otherId, otherInfo] of bridges) {
              if (otherId !== bridgeId && otherInfo.tools.some(t => t.name === tool.name)) {
                toolToBridge.set(tool.name, otherId);
                log(`[Server] Fallback routing '${tool.name}' → bridge [${otherId.slice(0, 8)}]`);
                fallback = true;
                break;
              }
            }
            if (!fallback) {
              toolToBridge.delete(tool.name);
            }
          }
        }

        // Reject pending tool calls for THIS specific bridge (Bug fix: was hanging 30s)
        const lostCount = rejectPendingForBridge(bridgeId, 'Bridge disconnected');
        if (lostCount > 0) {
          log(`[Server] Rejected ${lostCount} pending tool call(s) for disconnected bridge [${bridgeId.slice(0, 8)}]`);
        }

        bridges.delete(bridgeId);
        bridgeId = null;
      } else {
        log(`[Server] Bridge disconnected (no bridgeId, IP: ${clientIp}:${clientPort}) (${bridges.size} remaining)`);
      }

      // If ALL bridges are now gone, handle remaining pending calls (if any)
      if (bridges.size === 0) {
        if (pending.size > 0) {
          log(`[Server] No bridges remaining — moving ${pending.size} pending tool call(s) to retry queue`);
          for (const [_id, entry] of pending) {
            clearTimeout(entry.timer);
            retryQueue.push({
              resolve: entry.resolve,
              reject: entry.reject,
              method: entry.method,
              params: entry.params,
              bridgeId: entry.bridgeId,
            });
          }
          pending.clear();
        }

        // Grace period: reject retry queue if no bridge reconnects
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          if (retryQueue.length > 0) {
            log(`[Server] Retry grace period expired — rejecting ${retryQueue.length} pending calls`);
            for (const entry of retryQueue) {
              entry.reject(new Error('All bridges disconnected and none reconnected in time'));
            }
            retryQueue.length = 0;
          }
        }, 30_000);

        // AI pending requests complete independently via LLM — don't reject
        if (pendingAI.size > 0) {
          log(`[Server] Bridge disconnected — ${pendingAI.size} AI requests still in-flight (will complete independently)`);
        }
      }
    });

    ws.on('error', (err: Error) => {
      log(`[Server] Bridge error [IP: ${clientIp}:${clientPort}]`, err.message);
      // Force-close on error to trigger the close handler cleanup (Bug fix)
      try { ws.close(); } catch { /* already closing */ }
    });
  });

  wss.on('error', (err: Error) => log('[Server] WebSocket error:', err.message));

  // ── HTTP request routing ──
  httpServer.on('request', async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // ── MCP SSE endpoint (GET) — agent establishes SSE stream ──
    if (req.method === 'GET' && url.pathname === '/sse') {
      // IP whitelist (AI-facing endpoint — local-only by default)
      if (!isIpAllowed(req.socket.remoteAddress)) {
        log(`[Server] Rejected /sse from ${req.socket.remoteAddress || 'unknown'} (not in allowedIps)`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      const transport = new SSEServerTransport('/mcp', res);
      sessions.set(transport.sessionId, transport);
      log(`[Server] SSE session started: ${transport.sessionId}`);

      transport.onclose = () => {
        sessions.delete(transport.sessionId);
        log(`[Server] SSE session closed: ${transport.sessionId}`);
      };

      try {
        await server.connect(transport);
      } catch (err: any) {
        log('[Server] SSE connect error:', err.message);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal error');
        }
      }
      return;
    }

    // ── MCP POST endpoint — agent sends JSON-RPC messages ──
    if (req.method === 'POST' && url.pathname === '/mcp') {
      // IP whitelist (AI-facing endpoint — local-only by default)
      if (!isIpAllowed(req.socket.remoteAddress)) {
        log(`[Server] Rejected /mcp from ${req.socket.remoteAddress || 'unknown'} (not in allowedIps)`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      const sessionId = url.searchParams.get('sessionId');
      const transport = sessionId ? sessions.get(sessionId) : null;

      if (!transport) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'SSE session not found. Open GET /sse first.' }));
        return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk;
        if (body.length > MAX_BODY_SIZE) {
          req.destroy(new Error('Request body too large'));
          return;
        }
      });
      req.on('end', async () => {
        try {
          const parsedBody = body ? JSON.parse(body) : undefined;
          await transport.handlePostMessage(req, res, parsedBody);
        } catch (err: any) {
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message || 'Invalid request' }));
          }
        }
      });
      return;
    }

    // ── Direct JSON-RPC endpoint (no SSE needed — for tests & scripts) ──
    if (req.method === 'POST' && url.pathname === '/rpc') {
      // IP whitelist (AI-facing endpoint — local-only by default)
      if (!isIpAllowed(req.socket.remoteAddress)) {
        log(`[Server] Rejected /rpc from ${req.socket.remoteAddress || 'unknown'} (not in allowedIps)`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      const rpcTimeout = setTimeout(() => {
        if (!res.headersSent) {
          res.writeHead(408, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request timed out' }));
        }
      }, 60_000);

      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk;
        if (body.length > MAX_BODY_SIZE) {
          req.destroy(new Error('Request body too large'));
          return;
        }
      });
      req.on('end', async () => {
        clearTimeout(rpcTimeout);
        try {
          const msg = body ? JSON.parse(body) : undefined;
          const response = await handleDirectRPC(msg);
          if (response === null && !msg?.id) {
            if (!res.headersSent) { res.writeHead(202); res.end(); }
            return;
          }
          if (!res.headersSent) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          }
        } catch (err: any) {
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        }
      });
      return;
    }

    // ── AssetBundle transfer — stream binary AB files (binary-safe, NOT string concat) ──
    //   POST /ab?name=<file>   body = raw AB bytes → streamed to <abCacheDir>/<file>
    //   GET  /ab/<file>        streams the file back. Used by shader.hot_replace (runtime bridge).
    if (url.pathname === '/ab' || url.pathname.startsWith('/ab/')) {
      await handleABRequest(req, res, url);
      return;
    }

    // ── Health check ──
    if (req.method === 'GET' && url.pathname === '/health') {
      const llmCfg = loadAppConfig().llm;
      const bridgeList = [...bridges.entries()].map(([id, info]) => ({
        id,
        clientIp: info.clientIp,
        clientPort: info.clientPort,
        displayName: `${info.clientIp}:${info.clientPort} (${id.slice(0, 8)})`,
        tools: info.tools.length,
        connectedFor: Date.now() - info.connectedAt,
        toolNames: info.tools.map(t => t.name),
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        totalTools: toolToBridge.size,
        bridges: bridgeList,
        bridgeConnected: bridges.size > 0,
        isCompiling: isUnityCompiling,
        playModeState,
        sessions: sessions.size,
        uptime: process.uptime(),
            llmEnabled: llmCfg.enabled,
        llmConfigured: !!llmCfg.apiKey,
        llmProvider: llmCfg.provider,
        llmModel: llmCfg.model,
      }));
      return;
    }

    res.writeHead(404);
    res.end('Not found — use GET /sse for MCP, POST /rpc for direct JSON-RPC, GET /health for status');
  });

  // ── Direct JSON-RPC handler (bypasses SSE, for tests) ──
  let isInitialized = false;

  async function handleDirectRPC(msg: any): Promise<any> {
    if (!msg || typeof msg !== 'object') {
      return { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null };
    }
    if (msg.method === 'initialize') {
      isInitialized = true;
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '0.1.0',
          capabilities: { tools: {} },
          serverInfo: { name: 'unity-mcp-server', version: '0.1.0' },
        },
      };
    }

    if (msg.method === 'notifications/initialized') {
      return null;
    }

    // /rpc endpoint is direct JSON-RPC — no MCP initialize handshake required.
    // (The isInitialized flag is only for the SSE-based /mcp session.)
    if (msg.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: getMergedTools() },
      };
    }

    if (msg.method === 'tools/call') {
      const toolName = String(msg.params?.name || '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;

      // ── Server-side tools ──
      if (toolName === 'bridge.list') {
        const bridgeList = [...bridges.entries()].map(([id, info]) => ({
          id,
          clientIp: info.clientIp,
          clientPort: info.clientPort,
          displayName: `${info.clientIp}:${info.clientPort} (${id.slice(0, 8)})`,
          tools: info.tools.length,
          toolNames: info.tools.map(t => t.name),
          connectedForMs: Date.now() - info.connectedAt,
        }));
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify(bridgeList, null, 2) }] },
        };
      }

      if (toolName === 'bridge.call') {
        const target = String(args.target || '');
        const method = String(args.method || '');
        const params = (args.params || {}) as Record<string, unknown>;
        if (!target) return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Missing required argument: target (bridgeId)' } };
        if (!method) return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Missing required argument: method (tool name)' } };
        try {
          const result = await callBridgeById(target, method, params);
          const text = typeof result === 'string' ? result : JSON.stringify(result);
          return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } };
        } catch (err: any) {
          return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } };
        }
      }

      // ── Bridge-registered tools ──
      const bridgeId = toolToBridge.get(toolName);
      if (!bridgeId) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: `No bridge registered for tool '${toolName}'` },
        };
      }
      try {
        const result = await callBridge(toolName, args);
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text }] },
        };
      } catch (err: any) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: err.message },
        };
      }
    }

    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }

  // ── Start listening ──
  httpServer.listen(appCfg.port, appCfg.ip, () => {
    log(`[Server] Ready at http://${appCfg.ip}:${appCfg.port}/`);
    log(`[Server] Agent SSE  → GET  /sse  (SSE stream for MCP)`);
    log(`[Server] Agent POST → POST /mcp  (send JSON-RPC messages)`);
    log(`[Server] Scripts    → POST /rpc  (direct JSON-RPC, no SSE needed)`);
    log(`[Server] Health     → GET  /health`);
    log(`[Server] AssetBundle→ POST /ab?name=<file> (upload) | GET /ab/<file> (download)`);
    log(`[Server] Payload encryption: ${appCfg.encryption && appCfg.encryptionKey ? 'enabled (AES-256-CBC)' : 'disabled'} (config.encryption=${appCfg.encryption})`);
    log(`[Server] eval tools: ${appCfg.evalEnabled ? 'enabled' : 'disabled'}`);
    log(`[Server] Bridge     → ws://${appCfg.ip}:${appCfg.port}/ (WebSocket)`);
    const llmCfg = appCfg.llm;
    if (!llmCfg.enabled) {
      log(`[Server] LLM: disabled (set llm.enabled=true in config.json)`);
    } else if (llmCfg.apiKey) {
      log(`[Server] LLM enabled: ${llmCfg.provider} / ${llmCfg.model}`);
    } else {
      log(`[Server] LLM enabled but not configured (set llm.apiKey in config.json or LLM_API_KEY env var)`);
    }
  });

  // ── Cleanup ──
  const cleanup = (): void => {
    log('[Server] Shutting down...');
    clearInterval(pingInterval);
    wss.close();
    for (const [_id, info] of bridges) {
      info.ws.close();
    }
    httpServer.close();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
