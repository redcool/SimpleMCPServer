#!/usr/bin/env node

/**
 * SimpleMcpServer — MCP Server that bridges AI agents and Unity.
 *
 * Architecture:
 *   - Starts WebSocket Server immediately, waiting for SimpleMCPBridge
 *   - Bridge connects → sends `register_tools` with all [MCPTool] methods
 *   - Agent connects via MCP stdio → server forwards tool calls to Bridge
 *   - Tools stay registered across Bridge reconnections
 *
 * Config file: config.json (ip, port)
 *   - Local dev:  { "ip": "127.0.0.1", "port": 45678 }
 *   - Cloud:      { "ip": "0.0.0.0",   "port": 45678 }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

// ── Config ──

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.json');

interface Config {
  ip: string;
  port: number;
}

function loadConfig(): Config {
  const defaults: Config = { ip: '127.0.0.1', port: 45678 };
  if (!existsSync(CONFIG_PATH)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) };
  } catch (err) {
    console.error(`[Server] Failed to parse config.json, using defaults:`, err);
    return defaults;
  }
}

// ── State ──

let bridge: WebSocket | null = null;
let registeredTools: Array<{ name: string; description: string }> = [];
const pending = new Map<
  string,
  {
    resolve: (value: string) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function callBridge(method: string, params: Record<string, unknown>): Promise<string> {
  if (!bridge || bridge.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Unity not connected'));
  }

  const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const message = JSON.stringify({ id, method, paramsJson: JSON.stringify(params) });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Tool call '${method}' timed out`));
    }, 30_000);

    pending.set(id, {
      resolve: (value: string) => resolve(value),
      reject,
      timer,
    });

    bridge!.send(message);
  });
}

// ── Main ──

async function main(): Promise<void> {
  const config = loadConfig();

  // ── MCP Server (low-level API for dynamic tool registration) ──
  const server = new Server(
    {
      name: 'unity-mcp-server',
      version: '0.1.0',
    },
    { capabilities: { tools: {} } },
  );

  // Handle tools/list — returns current registered tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: registeredTools.map((t) => ({ ...t, inputSchema: { type: 'object' as const } })) };
  });

  // Handle tools/call — forward to Bridge
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (!bridge || bridge.readyState !== WebSocket.OPEN) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Unity not connected' }) }],
        isError: true,
      };
    }

    try {
      const result = await callBridge(toolName, args);
      // result may be a JSON object/array/string — MCP SDK requires text to be a string
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  });

  // ── WebSocket Server (accepts Bridge connections) ──
  const wss = new WebSocketServer({ host: config.ip, port: config.port });

  wss.on('connection', (ws) => {
    if (bridge && bridge !== ws) {
      bridge.close();
    }
    bridge = ws;
    console.error(`[Server] Bridge connected`);

    ws.on('message', (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.error('[Server] Invalid JSON from bridge');
        return;
      }

      // ── Tool registration (from Bridge on connect) ──
      if (msg.type === 'register_tools' && Array.isArray(msg.tools)) {
        registeredTools = msg.tools;
        const bridgeId = msg.bridgeId ?? '(unknown)';
        console.error(`[Server] Registered ${registeredTools.length} tool(s) from bridge [ID: ${bridgeId}]`);
        console.error(`[Server] Ready (ws://${config.ip}:${config.port})`);
        return;
      }

      // ── Tool call response (from Bridge) ──
      if (typeof msg.id === 'string' && pending.has(msg.id)) {
        const entry = pending.get(msg.id)!;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error));
        else entry.resolve(msg.result ?? 'null');
        return;
      }

      console.error('[Server] Unknown message:', raw.toString().slice(0, 200));
    });

    ws.on('close', () => {
      if (bridge === ws) bridge = null;
      console.error('[Server] Bridge disconnected');
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Bridge disconnected'));
      }
      pending.clear();
    });

    ws.on('error', (err) => {
      console.error('[Server] Bridge error:', err.message);
    });
  });

  wss.on('error', (err) => {
    console.error('[Server] WebSocket server error:', err.message);
  });

  // ── Connect MCP transport (agent communication) ──
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[Server] Waiting for Bridge at ws://${config.ip}:${config.port}...`);

  // ── Cleanup ──
  const cleanup = (): never => {
    console.error('[Server] Shutting down...');
    wss.close();
    bridge?.close();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((err) => {
  console.error('[Server] Fatal:', err);
  process.exit(1);
});
