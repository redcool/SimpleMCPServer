// ── Main ──

import http from 'http';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
import { searchWeb, getSearchProviderSummary } from './websearch.js';
import { isBlenderTemplateTool, runBlenderTemplateTool } from './blenderTemplateTools.js';
import { handleABRequest } from './ab.js';
import { startAdapters, stopAdapters, isAdapterTool, isDangerAdapterTool, callAdapterTool } from './mcpAdapter.js';

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
// Shared server-side web search (used by both the MCP SDK call path and /rpc).
async function webSearchToolText(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('Missing required argument: query');
  const max = Math.min(Math.max(Number.parseInt(String(args.maxResults ?? '5'), 10) || 5, 1), 10);
  // Overall guard on top of the per-provider timeouts (provider chain, see config.webSearch).
  const results = await Promise.race([
    searchWeb(query, max),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('web search timed out (25s)')), 25_000);
    }),
  ]);
  return JSON.stringify(results, null, 2);
}

export async function main(): Promise<void> {
  const appCfg = reloadConfig();

  // ── MCP Server factory: one instance per connected transport ──
  // The MCP SDK allows ONE transport per Protocol instance, so each session
  // (SSE or Streamable HTTP) gets its own Server; shared state stays module-level.
  function createMcpServer(): Server {
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
      // evalEnabled applies on execution too — bridge.call must not bypass the gate
      if (method === 'editor.eval' && !getCachedConfig().evalEnabled) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'editor.eval is disabled (evalEnabled=false)' }) }], isError: true };
      }
      try {
        const result = await callBridgeById(target, method, params);
        return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }

    // ── Server-side web search ──
    if (toolName === 'web.search') {
      try {
        const text = await webSearchToolText(args);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }

    // ── Curated Blender template tools (blender.rig.*, blender.anim.*, ...) ──
    // They run pre-written bpy code through the connected Blender adapter, so
    // they respect the same evalEnabled gate as other code-execution tools.
    if (isBlenderTemplateTool(toolName)) {
      if (!getCachedConfig().evalEnabled) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Blender template tools are disabled (evalEnabled=false)' }) }],
          isError: true,
        };
      }
      try {
        const text = await runBlenderTemplateTool(toolName, args);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: err?.message ?? String(err) }) }],
          isError: true,
        };
      }
    }

    // ── Enforce evalEnabled on execution too (listing filter is not a gate) ──
    if (toolName === 'editor.eval' && !getCachedConfig().evalEnabled) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'editor.eval is disabled (evalEnabled=false)' }) }],
        isError: true,
      };
    }

    // ── External MCP adapter tools (e.g. blender.*) — proxy to the adapter's server ──
    if (isAdapterTool(toolName)) {
      // Code-execution tools respect evalEnabled on execution too
      if (isDangerAdapterTool(toolName) && !getCachedConfig().evalEnabled) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'code-execution tool is disabled (evalEnabled=false)' }) }],
          isError: true,
        };
      }
      try {
        const text = await callAdapterTool(toolName, args);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: err?.message ?? String(err) }) }],
          isError: true,
        };
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

  return server;
  }

  // ── SSE transport sessions (one per connected agent) ──
  // Each entry keeps its own protocol Server instance (SDK: 1 transport/Protocol).
  const sessions = new Map<string, { transport: SSEServerTransport; server: Server }>();
  // Streamable HTTP (MCP 2025-11 recommended transport) sessions — independent
  // session pool, path /mcp-stream.
  const streamSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

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
    // IP whitelist — a rogue WS client could hijack bridge routing or trigger
    // paid LLM calls, so the bridge channel is restricted to allowed IPs too.
    if (!isIpAllowed(req.socket.remoteAddress)) {
      log(`[Server] Rejected bridge WebSocket from ${req.socket.remoteAddress || 'unknown'} (not in allowedIps)`);
      ws.close(1008, 'Forbidden — IP not in allowedIps');
      return;
    }
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
            // Replay to the ORIGINAL bridge, not whatever bridge last took over
            // the tool name — otherwise a call meant for project A can silently
            // be routed to project B's bridge that reconnected first.
            callBridgeById(entry.bridgeId, entry.method, entry.params)
              .then(entry.resolve)
              .catch(entry.reject);
          }
        }

        return;
      }

      // ── AI Request from Bridge ──
      if (msg.type === 'ai_request') {
        const requestId = msg.requestId || `ai_${Date.now()}`;
        const safePrompt = String(msg.prompt || '').slice(0, 80).replace(/[\r\n"]/g, ' ');
        log(`[Server] AI request: ${requestId}, prompt: ${safePrompt}`);

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
  // ── HTTP routing — wrapped so any unexpected throw answers 500 instead of hanging ──
  httpServer.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    handleHttpRequest(req, res).catch((err: unknown) => {
      log('[Server] HTTP handler error:', err instanceof Error ? err.message : String(err));
      if (!res.headersSent) {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Internal error' }));
        } catch { /* socket already gone */ }
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    });
  });

  async function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // ── MCP SSE endpoint (GET) — agent establishes SSE stream ──
    if (req.method === 'GET' && url.pathname === '/sse') {
      // IP whitelist (AI-facing endpoint — local-only by default)
      if (!isIpAllowed(req.socket.remoteAddress)) {
        log(`[Server] Rejected /sse from ${req.socket.remoteAddress || 'unknown'} (not in allowedIps)`);
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      const transport = new SSEServerTransport('/mcp', res);
      const srv = createMcpServer();
      sessions.set(transport.sessionId, { transport, server: srv });
      log(`[Server] SSE session started: ${transport.sessionId}`);

      transport.onclose = () => {
        sessions.delete(transport.sessionId);
        log(`[Server] SSE session closed: ${transport.sessionId}`);
      };

      try {
        await srv.connect(transport);
      } catch (err: any) {
        log('[Server] SSE connect error:', err.message);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal error');
        }
      }
      return;
    }

    // ── MCP Streamable HTTP endpoint (MCP 2025-11 recommended transport) ──
    // GET  = SSE stream (create/re-attach session, waits for initialize)
    // POST = JSON-RPC message (with mcp-session-id header, or stateless initialize)
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/mcp-stream') {
      if (!isIpAllowed(req.socket.remoteAddress)) {
        log(`[Server] Rejected /mcp-stream from ${req.socket.remoteAddress || 'unknown'} (not in allowedIps)`);
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      const sessionHeader = req.headers['mcp-session-id'];
      const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
      const existing = sessionId ? streamSessions.get(sessionId) : undefined;
      if (sessionId && !existing) {
        res.writeHead(404, {
          'Content-Type': 'application/json',
          'mcp-session-id': sessionId,
        });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Session not found' } }));
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
          let t = existing?.transport;
          let srv = existing?.server;
          if (!t) {
            t = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              // Lazy: the real session id is only generated when the first
              // request (initialize) is handled, so register it here.
              onsessioninitialized: (sid) => {
                log(`[Server] Streamable session initialized: ${sid}`);
                if (t && srv) streamSessions.set(sid, { transport: t, server: srv });
              },
            });
            srv = createMcpServer();
            log('[Server] Streamable transport created (session id pending)');
            t.onclose = () => {
              const sid = t!.sessionId;
              if (sid) streamSessions.delete(sid);
              log(`[Server] Streamable transport closed: ${sid ?? '(no session)'}`);
            };
            await srv.connect(t);
          }
          const parsedBody = body ? JSON.parse(body) : undefined;
          await t.handleRequest(req, res, parsedBody);
          // Register under the real session id once known (generated lazily
          // during initialize), so follow-up POSTs with the header resolve.
          const realSid = t.sessionId;
          if (realSid) streamSessions.set(realSid, { transport: t, server: srv! });
        } catch (err: any) {
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: err?.message || 'Invalid request' }));
          }
        }
      });
      return;
    }

    // ── MCP POST endpoint — agent sends JSON-RPC messages ──
    if (req.method === 'POST' && url.pathname === '/mcp') {
      // IP whitelist (AI-facing endpoint — local-only by default)
      if (!isIpAllowed(req.socket.remoteAddress)) {
        log(`[Server] Rejected /mcp from ${req.socket.remoteAddress || 'unknown'} (not in allowedIps)`);
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      const sessionId = url.searchParams.get('sessionId');
      const sess = sessionId ? sessions.get(sessionId) : undefined;

      if (!sess) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
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
          await sess.transport.handlePostMessage(req, res, parsedBody);
        } catch (err: any) {
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
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
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      const rpcTimeout = setTimeout(() => {
        if (!res.headersSent) {
          res.writeHead(408, { 'Content-Type': 'application/json; charset=utf-8' });
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
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(response));
          }
        } catch (err: any) {
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
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
      if (!isIpAllowed(req.socket.remoteAddress)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
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
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
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
  }

  // ── Direct JSON-RPC handler (bypasses SSE, for tests) ──

  async function handleDirectRPC(msg: any): Promise<any> {
    if (!msg || typeof msg !== 'object') {
      return { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null };
    }
    if (msg.method === 'initialize') {
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
        // evalEnabled applies on execution too — bridge.call must not bypass the gate
        if (method === 'editor.eval' && !getCachedConfig().evalEnabled) {
          return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'editor.eval is disabled (evalEnabled=false)' } };
        }
        try {
          const result = await callBridgeById(target, method, params);
          const text = typeof result === 'string' ? result : JSON.stringify(result);
          return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } };
        } catch (err: any) {
          return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } };
        }
      }

      // ── Server-side web search ──
      if (toolName === 'web.search') {
        try {
          const text = await webSearchToolText(args);
          return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } };
        } catch (err: any) {
          const reason = err instanceof Error ? err.message : String(err);
          return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: reason } };
        }
      }

      // ── Curated Blender template tools (blender.rig.*, blender.anim.*, ...) ──
      if (isBlenderTemplateTool(toolName)) {
        if (!getCachedConfig().evalEnabled) {
          return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Blender template tools are disabled (evalEnabled=false)' } };
        }
        try {
          const text = await runBlenderTemplateTool(toolName, args);
          return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } };
        } catch (err: any) {
          const reason = err instanceof Error ? err.message : String(err);
          return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: reason } };
        }
      }

      // ── Enforce evalEnabled on execution too (listing filter is not a gate) ──
      if (toolName === 'editor.eval' && !getCachedConfig().evalEnabled) {
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'editor.eval is disabled (evalEnabled=false)' } };
      }

      // ── External MCP adapter tools (e.g. blender.*) — proxy to the adapter's server ──
      if (isAdapterTool(toolName)) {
        // Code-execution tools respect evalEnabled on execution too
        if (isDangerAdapterTool(toolName) && !getCachedConfig().evalEnabled) {
          return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'code-execution tool is disabled (evalEnabled=false)' } };
        }
        try {
          const text = await callAdapterTool(toolName, args);
          return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } };
        } catch (err: any) {
          return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err?.message ?? String(err) } };
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

  // ── Start external MCP adapters (BlenderMCP etc.) — non-fatal on failure ──
  await startAdapters(appCfg.mcpServers);

  // ── Start listening ──
  httpServer.on('error', (err: Error) => {
    log('[Server] Listen error:', err.message);
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      log(`[Server] Port ${appCfg.port} already in use — is another server instance already running?`);
    }
    process.exit(1);
  });
  httpServer.listen(appCfg.port, appCfg.ip, () => {
    log(`[Server] Ready at http://${appCfg.ip}:${appCfg.port}/`);
    log(`[Server] Agent SSE  → GET  /sse  (SSE stream for MCP, legacy)`);
    log(`[Server] Agent MCP  → GET/POST /mcp-stream  (Streamable HTTP, recommended)`);
    log(`[Server] Agent POST → POST /mcp  (SSE session messages)`);
    log(`[Server] Scripts    → POST /rpc  (direct JSON-RPC, no SSE needed)`);
    log(`[Server] Health     → GET  /health`);
    log(`[Server] AssetBundle→ POST /ab?name=<file> (upload) | GET /ab/<file> (download)`);
    log(`[Server] Payload encryption: ${appCfg.encryption && appCfg.encryptionKey ? 'enabled (AES-256-CBC)' : 'disabled'} (config.encryption=${appCfg.encryption})`);
    log(`[Server] eval tools: ${appCfg.evalEnabled ? 'enabled' : 'disabled'}`);
    log(`[Server] Web search providers: ${getSearchProviderSummary()}`);
    log(`[Server] External MCP adapters: ${appCfg.mcpServers.length ? appCfg.mcpServers.map(s => s.name).join(', ') : 'none'}`);
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
    stopAdapters().then(() => httpServer.close());
    // Close http after adapters stop (avoid dangling child procs); accept tiny delay
    setTimeout(() => httpServer.close(), 200);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
