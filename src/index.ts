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
 *   Encryption: set encryption=true + encryptionKey in config.json (same key on Bridge) to enable AES-256-CBC payload encryption
 *
 * Start:   node dist/index.js
 * Test:    curl http://127.0.0.1:45678/health
 */

import { main } from './server.js';
import { log } from './logger.js';

main().catch((err) => {
  log('[Server] Fatal:', err);
  process.exit(1);
});