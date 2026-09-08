import { getCachedConfig } from './config.js';
import { bridges, toolToBridge } from './bridgeState.js';
import { getAdapterTools, isDangerAdapterTool } from './mcpAdapter.js';
import { getBlenderTemplateTools } from './blenderTemplateTools.js';
// ── Server-side tools (bridge management) ──

const SERVER_TOOLS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: 'bridge.list',
    description: 'List all connected bridge clients with IP, port, tools count, and tool names',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bridge.call',
    description: 'Direct a tool call to a specific bridge by its bridgeId (use bridge.list to get IDs)',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Bridge ID (full GUID from bridge.list)' },
        method: { type: 'string', description: 'Tool name to call on that bridge' },
        params: { type: 'object', description: 'Tool parameters (key-value pairs)' },
      },
      required: ['target', 'method'],
    },
  },
  {
    name: 'web.search',
    description: 'Search the web (DuckDuckGo, no API key required) and return titles, URLs and snippets',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { type: 'number', description: 'Max results to return (1-10, default 5)', minimum: 1, maximum: 10 },
      },
      required: ['query'],
    },
  },
];

export function getMergedTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const cfg = getCachedConfig();
  const seen = new Set<string>();
  const merged: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
  // Server-side tools first
  for (const tool of SERVER_TOOLS) {
    seen.add(tool.name);
    merged.push({ ...tool, inputSchema: tool.inputSchema ?? { type: 'object' } });
  }
  // External MCP adapter tools (e.g. blender.*) — before bridge tools so the
  // prefix namespace wins over any bridge tool with a colliding name.
  for (const tool of getAdapterTools()) {
    // Code-execution tools hide from listings while evalEnabled=false
    if (!cfg.evalEnabled && isDangerAdapterTool(tool.name)) continue;
    if (!seen.has(tool.name)) {
      seen.add(tool.name);
      merged.push({ ...tool, inputSchema: tool.inputSchema ?? { type: 'object' } });
    }
  }
  // Curated Blender template tools (blender.rig.*, blender.anim.*, ...).
  // They execute code inside Blender, so they follow the same evalEnabled gate
  // as other code-execution tools.
  if (cfg.evalEnabled) {
    for (const tool of getBlenderTemplateTools()) {
      if (!seen.has(tool.name)) {
        seen.add(tool.name);
        merged.push({ ...tool, inputSchema: tool.inputSchema ?? { type: 'object' } });
      }
    }
  }
  // Merge bridge tools (last-registration-wins) — annotate the current routing target
  for (const [_id, info] of [...bridges.entries()].reverse()) {
    for (const tool of info.tools) {
      if (!cfg.evalEnabled && tool.name === 'editor.eval') continue;
      if (!seen.has(tool.name)) {
        seen.add(tool.name);
        // Determine which bridge this tool currently routes to (toolToBridge holds the
        // last-registration-wins target — the bridge an actual call would hit).
        const targetId = toolToBridge.get(tool.name);
        const targetInfo = targetId ? bridges.get(targetId) : undefined;
        const sourceTag = targetInfo && targetId
          ? `[bridge: ${targetInfo.clientIp}:${targetInfo.clientPort} (${targetId.slice(0, 8)})] `
          : '';
        merged.push({ ...tool, description: sourceTag + tool.description, inputSchema: tool.inputSchema ?? { type: 'object' } });
      }
    }
  }
  return merged;
}