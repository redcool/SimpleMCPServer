#!/usr/bin/env node

/**
 * SimpleMcpServer — MCP Server that bridges AI agents and Unity/Game.
 *
 * Architecture (HTTP SSE + WS):
 *   AI Agent ──SSE (GET /sse) + POST (/mcp)──→ Server ←──WebSocket──→ Unity Bridge / Game
 *
 * - Agent connects via MCP SSE transport (GET /sse → SSE stream, POST /mcp → messages)
 * - Bridge/Game connects via WebSocket at same port (WS upgrade)
 * - Server requests tools on WS connect; stores them; forwards tool calls
 *
 * LLM Integration:
 * - Bridge can send {"type":"ai_request","prompt":"...","context":{...},"requestId":"..."}
 * - Server calls external LLM (OpenAI-compatible) and returns {"type":"ai_response","text":"...","requestId":"..."}
 *
 * Config file: config.json (ip, port, llm)
 *   Local dev:  { "ip": "127.0.0.1", "port": 45678 }
 *   Cloud:      { "ip": "0.0.0.0",   "port": 45678 }
 *   LLM:        { "provider": "openai", "baseUrl": "...", "apiKey": "...", "model": "gpt-4o" }
 *
 * Start:   node dist/index.js
 * Test:    curl http://127.0.0.1:45678/health
 */

import http from 'http';
import https from 'https';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

// ── Logging utility ──
// All server log output goes through this function.
// It writes to BOTH the console (via stderr, which the cmd window shows)
// AND the server.log file (for persistence).
// Format: [Beijing-time] [TAG] message
// Change this single function to redirect logs or add log levels.
import { appendFileSync } from 'fs';

const _consoleError = console.error.bind(console);

function log(message: string, ...extra: any[]) {
  const beijing = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const tagMatch = message.match(/^\[(\w+)\]\s*/);
  let formatted: string;
  if (tagMatch) {
    const tag = tagMatch[1];
    const cleanMsg = message.slice(tagMatch[0].length);
    formatted = `[${beijing}] [${tag}] ${cleanMsg}`;
    _consoleError(formatted, ...extra);
  } else {
    formatted = `[${beijing}] ${message}`;
    _consoleError(formatted, ...extra);
  }

  // Also append to server.log (flush immediately)
  try {
    const extraStr = extra.length > 0 ? ' ' + extra.map(e => String(e)).join(' ') : '';
    const logFile = join(__dirname, '..', 'server.log');
    appendFileSync(logFile, formatted + extraStr + '\n', 'utf-8');
  } catch { /* best-effort */ }
}

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

// ── Config ──

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.json');

interface LLMConfig {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

interface AppConfig {
  ip: string;
  port: number;
  llm: LLMConfig;
}

let appConfigCache: AppConfig | null = null;

function getCachedConfig(): AppConfig {
  if (!appConfigCache) appConfigCache = loadAppConfig();
  return appConfigCache;
}

function loadAppConfig(): AppConfig {
  const defaults: AppConfig = {
    ip: '127.0.0.1',
    port: 45678,
    llm: {
      enabled: false,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o',
      temperature: 0.7,
      maxTokens: 1024,
    },
  };
  if (!existsSync(CONFIG_PATH)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) };
  } catch {
    return defaults;
  }
}

function getMergedTools(): Array<{ name: string; description: string; inputSchema: { type: string } }> {
  const seen = new Set<string>();
  const merged: Array<{ name: string; description: string; inputSchema: { type: string } }> = [];
  for (const [_id, info] of [...bridges.entries()].reverse()) {
    for (const tool of info.tools) {
      if (!seen.has(tool.name)) {
        seen.add(tool.name);
        merged.push({ ...tool, inputSchema: { type: 'object' } });
      }
    }
  }
  return merged;
}

// ── Multi-Bridge State ──

/** Information about a connected bridge client. */
interface BridgeInfo {
  ws: WebSocket;
  id: string;
  tools: Array<{ name: string; description: string }>;
  connectedAt: number;
}

/**
 * All connected bridges, keyed by bridgeId.
 * Multiple bridges can coexist — each has a unique ID (set by the Unity client via GUID).
 * During domain reload, the old bridge disconnects while the new one is already connected,
 * so they overlap briefly without conflict.
 */
const bridges = new Map<string, BridgeInfo>();
/** Maps tool name → bridgeId for routing tool calls to the correct bridge. */
const toolToBridge = new Map<string, string>();

/** Pending tool-call responses awaiting bridge reply, keyed by request ID. */
const pending = new Map<string, {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  params: Record<string, unknown>;
}>();

/**
 * Retry queue for tool calls that were in-flight when ALL bridges disconnected.
 * On reconnect (register_tools from any bridge), these are re-sent.
 */
const retryQueue: Array<{
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  method: string;
  params: Record<string, unknown>;
}> = [];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Pending AI request responses awaiting LLM reply, keyed by requestId. */
const pendingAI = new Map<string, {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
/** Whether Unity is currently compiling scripts. Bridge reports via {"type":"compilation","status":"started|finished"}. */
let isUnityCompiling = false;
/** Current Unity play mode state. Bridge reports via {"type":"playmode","status":"entered|exiting|entered_edit|exiting_edit"}. */
let playModeState: string | null = null;

/**
 * Route a tool call to the bridge that registered the tool.
 * This allows multiple bridges to coexist: each registers its own tool set,
 * and calls are dispatched to the correct bridge by tool name.
 */
function callBridge(method: string, params: Record<string, unknown>): Promise<string> {
  if (isUnityCompiling) {
    return Promise.reject(new Error('Unity is compiling — tools unavailable until compilation finishes'));
  }

  // Find which bridge registered this tool
  const bridgeId = toolToBridge.get(method);
  if (!bridgeId) {
    if (bridges.size === 0) {
      return Promise.reject(new Error('No bridge connected'));
    }
    return Promise.reject(new Error(`No bridge registered for tool '${method}' (${bridges.size} bridge(s) connected but none has this tool)`));
  }
  const info = bridges.get(bridgeId);
  if (!info || info.ws.readyState !== WebSocket.OPEN) {
    // Bridge disconnected — clean up mapping
    toolToBridge.delete(method);
    bridges.delete(bridgeId);
    return Promise.reject(new Error(`Bridge '${bridgeId}' disconnected while handling tool '${method}'`));
  }

  const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const message = JSON.stringify({ id, method, paramsJson: JSON.stringify(params) });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Tool call '${method}' timed out`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer, method, params });
    info.ws.send(message, (err) => {
      if (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`WebSocket send failed: ${err.message}`));
      }
    });
  });
}

// ── LLM Integration ──

interface AIRequestMessage {
  prompt: string;
  context?: Record<string, unknown>;
  system?: string;
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

function buildLLMMessages(req: AIRequestMessage): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

  if (req.system) {
    messages.push({ role: 'system', content: req.system });
  }

  if (req.messages && req.messages.length > 0) {
    messages.push(...req.messages);
  }

  let userContent = req.prompt;
  if (req.context && Object.keys(req.context).length > 0) {
    const contextStr = Object.entries(req.context)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join('\n');
    userContent = `Context:\n${contextStr}\n\nUser: ${req.prompt}`;
  }

  messages.push({ role: 'user', content: userContent });
  return messages;
}

function callLLM(req: AIRequestMessage): Promise<string> {
  const serverCfg = getCachedConfig();
  const llmCfg = serverCfg.llm;

  const apiKey = process.env.LLM_API_KEY || llmCfg.apiKey;
  if (!apiKey) {
    return Promise.reject(new Error('LLM API key not configured. Set LLM_API_KEY env var or llm.apiKey in config.json'));
  }

  const messages = buildLLMMessages(req);

  // Build OpenAI-compatible request body
  const isOllama = llmCfg.provider === 'ollama' || llmCfg.baseUrl.includes('ollama');

  let bodyStr: string;
  if (isOllama) {
    bodyStr = JSON.stringify({
      model: llmCfg.model,
      prompt: req.prompt,
      context: req.context || {},
      options: {
        temperature: llmCfg.temperature,
        num_predict: llmCfg.maxTokens,
      },
      stream: false,
    });
  } else {
    bodyStr = JSON.stringify({
      model: llmCfg.model,
      messages,
      temperature: llmCfg.temperature,
      max_tokens: llmCfg.maxTokens,
    });
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (!isOllama) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('LLM request timed out after 60s'));
    }, 60_000);

    const url = new URL(`${llmCfg.baseUrl}/chat/completions`);
    const httpModule = url.protocol === 'https:' ? https : http;

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers,
    };

    const httpreq = httpModule.request(options, (res: http.IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`LLM API error ${res.statusCode}: ${parsed.error?.message || data}`));
            return;
          }

          if (isOllama) {
            resolve(String(parsed.response || parsed.message?.content || ''));
            return;
          }

          const content = parsed.choices?.[0]?.message?.content;
          if (content) {
            resolve(content);
          } else {
            reject(new Error(`Invalid LLM response: ${data}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse LLM response: ${data}`));
        }
      });
    });

    httpreq.on('error', (e: Error) => {
      clearTimeout(timeout);
      reject(new Error(`LLM request failed: ${e.message}`));
    });

    httpreq.write(bodyStr);
    httpreq.end();
  });
}

// ── Main ──

async function main(): Promise<void> {
  appConfigCache = loadAppConfig();
  const appCfg = appConfigCache;

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
    const bridgeId = toolToBridge.get(toolName);
    if (!bridgeId) {
      if (bridges.size === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No bridge connected' }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `No bridge registered for tool '${toolName}' (${bridges.size} bridge(s) connected)` }) }],
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

  // ── HTTP + WebSocket Server (single port) ──
  const httpServer = http.createServer();

  // ── WebSocket — Bridge/Game connections ──
  const wss = new WebSocketServer({ server: httpServer });

  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    });
  }, 30_000);

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    // Log client IP and port — keep reference for disconnect/error logs
    const clientIp = req.socket.remoteAddress || 'unknown';
    const clientPort = req.socket.remotePort || 0;
    log(`[Server] New bridge connection from ${clientIp}:${clientPort} (${bridges.size} existing bridge(s))`);

    // NOTE: We do NOT close existing bridges here.
    // Multiple bridges can coexist — each identifies itself via bridgeId in register_tools.
    // This is essential for domain reload: old bridge disconnects → new bridge
    // is already connected, so tool calls are never dropped during the transition.
    let bridgeId: string | null = null;

    let requestToolsTimer: ReturnType<typeof setTimeout> | null = null;

    function requestTools(): void {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'request_tools' }));
      log('[Server] Sent request_tools to bridge');
      let attempts = 0;
      requestToolsTimer = setTimeout(() => {
        if (attempts < 3 && ws.readyState === WebSocket.OPEN) {
          attempts++;
          log(`[Server] Re-requesting tools (attempt ${attempts + 1})...`);
          ws.send(JSON.stringify({ type: 'request_tools' }));
        }
      }, 8000);
    }

    ws.on('message', (raw: Buffer) => {
      let msg: any;
      const rawStr = raw.toString();
      try {
        msg = JSON.parse(rawStr);
      } catch {
        log('[Server] Invalid JSON from bridge:', rawStr.slice(0, 200));
        return;
      }

      // Debug: log every incoming message type
      const idStr = String(msg.id ?? '');
      if (msg.type) {
        log(`[Server] Received message type="${msg.type}" from bridge [id=${idStr.slice(0,20) || 'none'}]`);
      } else if (msg.id) {
        // Tool response
        log(`[Server] Received tool response id="${idStr.slice(0,24)}"`);
      }

      // ── Tool registration (bridge identifies itself) ──
      if (msg.type === 'register_tools' && Array.isArray(msg.tools)) {
        const id: string = msg.bridgeId || `anon_${Date.now()}`;
        bridgeId = id;
        if (requestToolsTimer) clearTimeout(requestToolsTimer);
        isUnityCompiling = false;

        // Add/update this bridge in the bridges map
        bridges.set(id, { ws, id, tools: msg.tools, connectedAt: Date.now() });
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
        if (!llmCfg.apiKey) {
          ws.send(JSON.stringify({ type: 'ai_response', requestId, text: null, error: 'LLM not configured on server' }));
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
            ws.send(JSON.stringify({ type: 'ai_response', requestId, text: null, error: 'LLM request timed out (90s)' }));
          }
        }, 90_000);

        pendingAI.set(requestId, {
          resolve: (text: string) => {
            clearTimeout(aiTimeout);
            ws.send(JSON.stringify({ type: 'ai_response', requestId, text, error: null }));
            pendingAI.delete(requestId);
          },
          reject: (err: Error) => {
            clearTimeout(aiTimeout);
            ws.send(JSON.stringify({ type: 'ai_response', requestId, text: null, error: err.message }));
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
        isUnityCompiling = msg.status === 'started';
        log(`[Server] Unity compilation ${msg.status}`);
        return;
      }

      // ── Play mode state from bridge ──
      if (msg.type === 'playmode') {
        playModeState = msg.status;
        log(`[Server] Unity play mode: ${msg.status}`);
        return;
      }

      // ── Tool call response (resolve pending promise) ──
      if (typeof msg.id === 'string' && pending.has(msg.id)) {
        const entry = pending.get(msg.id)!;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error));
        else entry.resolve(msg.result ?? 'null');
        return;
      }

      log('[Server] Unknown message:', raw.toString().slice(0, 200));
    });

    requestTools();

    ws.on('close', () => {
      // Remove this bridge from the map
      if (bridgeId && bridges.has(bridgeId)) {
        log(`[Server] Bridge disconnected  [ID: ${bridgeId.slice(0, 8)} IP: ${clientIp}:${clientPort}] (${bridges.size - 1} remaining)`);
        // Remove this bridge's tools from the routing table,
        // and fall back to another bridge that also registered the same tool
        const info = bridges.get(bridgeId)!;
        for (const tool of info.tools) {
          if (toolToBridge.get(tool.name) === bridgeId) {
            // Check if any other bridge still has this tool
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
        bridges.delete(bridgeId);
        bridgeId = null;
      } else {
        log(`[Server] Bridge disconnected (no bridgeId, IP: ${clientIp}:${clientPort}) (${bridges.size} remaining)`);
      }

      // If ALL bridges are gone, move in-flight tool calls to retry queue
      if (bridges.size === 0) {
        if (pending.size > 0) {
          log(`[Server] No bridges remaining — moving ${pending.size} pending tool calls to retry queue`);
          for (const [_id, entry] of pending) {
            clearTimeout(entry.timer);
            retryQueue.push({
              resolve: entry.resolve,
              reject: entry.reject,
              method: entry.method,
              params: entry.params,
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

        // AI pending requests don't need bridge — reject immediately
        for (const [_id, entry] of pendingAI) { clearTimeout(entry.timer); entry.reject(new Error('All bridges disconnected')); }
        pendingAI.clear();
      }
    });

    ws.on('error', (err: Error) => log(`[Server] Bridge error [IP: ${clientIp}:${clientPort}]`, err.message));
  });

  wss.on('error', (err: Error) => log('[Server] WebSocket error:', err.message));

  // ── HTTP request routing ──
  httpServer.on('request', async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // ── MCP SSE endpoint (GET) — agent establishes SSE stream ──
    if (req.method === 'GET' && url.pathname === '/sse') {
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

    // ── Health check ──
    if (req.method === 'GET' && url.pathname === '/health') {
      const llmCfg = loadAppConfig().llm;
      const bridgeList = [...bridges.entries()].map(([id, info]) => ({
        id,
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

    if (!isInitialized) {
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Not initialized. Send initialize first.' } };
    }

    if (msg.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: getMergedTools() },
      };
    }

    if (msg.method === 'tools/call') {
      const toolName = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      // Find which bridge registered this tool
      const bridgeId = toolToBridge.get(String(toolName));
      if (!bridgeId) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: `No bridge registered for tool '${toolName}'` },
        };
      }
      try {
        const result = await callBridge(String(toolName), args);
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
    log(`[Server] Bridge     → ws://${appCfg.ip}:${appCfg.port}/ (WebSocket)`);
    const llmCfg = appCfg.llm;
    if (llmCfg.apiKey) {
      log(`[Server] LLM configured: ${llmCfg.provider} / ${llmCfg.model}`);
    } else {
      log(`[Server] LLM: not configured (set llm.apiKey in config.json to enable AI features)`);
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

main().catch((err) => {
  log('[Server] Fatal:', err);
  process.exit(1);
});
