#!/usr/bin/env node

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { UnityBridge } from './unity-bridge.js';

const UNITY_PORT = parseInt(process.env.UNITY_MCP_PORT || '45678', 10);

async function main(): Promise<void> {
  // ── MCP Server ──
  const server = new McpServer({
    name: 'unity-mcp-server',
    version: '0.1.0',
    description: 'MCP Server for Unity — AI agents can operate Unity scenes via WebSocket',
  });

  // ── Unity Bridge ──
  const unity = new UnityBridge();

  unity.onDisconnected = () => {
    console.error('[MCP-Server] Unity disconnected. Waiting for reconnection...');
  };

  // ── Connect to Unity ──
  console.error(`[MCP-Server] Connecting to Unity at ws://127.0.0.1:${UNITY_PORT}...`);

  try {
    await unity.connect(UNITY_PORT);
    console.error('[MCP-Server] Connected to Unity!');
  } catch (err) {
    console.error('[MCP-Server] Failed to connect to Unity. Make sure SimpleMCPBridge is running:');
    console.error('  1. Open Unity');
    console.error('  2. Go to Tools > SimpleMCPBridge');
    console.error('  3. Click "Start Bridge"');
    console.error(`  4. Port should be ${UNITY_PORT}`);
    process.exit(1);
  }

  // ── Discover tools from Unity ──
  console.error('[MCP-Server] Discovering tools from Unity...');
  try {
    const tools = await unity.listTools();
    console.error(`[MCP-Server] Found ${tools.length} tool(s):`);
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: z.object({}).passthrough(),
        },
        async (params: Record<string, unknown>) => {
          const result = await unity.send(tool.name, params ?? {});
          return { content: [{ type: 'text' as const, text: result }] };
        },
      );
      console.error(`  ✓ ${tool.name}`);
    }
  } catch (err) {
    console.error('[MCP-Server] Failed to discover tools from Unity:', err);
    console.error('[MCP-Server] SimpleMCPBridge may need to be restarted.');
    process.exit(1);
  }

  // ── Start MCP transport (stdio) ──
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[MCP-Server] Ready. Agent can now use Unity tools via MCP.`);

  // ── Cleanup ──
  const cleanup = (): never => {
    console.error('[MCP-Server] Shutting down...');
    unity.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((err) => {
  console.error('[MCP-Server] Fatal error:', err);
  process.exit(1);
});
