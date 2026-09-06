// ── External MCP server adapter (plan C) ──
// This server acts as an MCP *client* to external MCP servers (e.g. BlenderMCP
// via `uvx blender-mcp`), exposing their tools under a per-server prefix
// (e.g. blender.get_scene_info). Lifecycle is owned here: spawn → connect →
// list tools → proxy calls; if the child process dies, the adapter is marked
// down so tools disappear from listings and calls fail fast with a clear message.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { log } from './logger.js';
import type { MCPServerConfig } from './config.js';

export interface AdapterTool {
  /** Prefixed name as seen by clients, e.g. blender.get_scene_info. */
  name: string;
  serverName: string;
  /** Original tool name on the external server. */
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface AdapterState {
  cfg: MCPServerConfig;
  client: Client;
  transport: StdioClientTransport;
  pid: number | null;
  tools: AdapterTool[];
  enabled: boolean;
  down: string | null; // reason if the underlying process died
}

const adapters = new Map<string, AdapterState>(); // key: server name
const CONNECT_TIMEOUT_MS = 20_000;

// Auto-reconnect bookkeeping: when an adapter's child process dies (e.g. Blender
// was closed and restarted), schedule a re-spawn with exponential backoff so the
// server itself never needs a restart.
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const reconnectAttempts = new Map<string, number>();
const RECONNECT_DELAYS_MS = [10_000, 30_000, 60_000, 120_000];

function scheduleReconnect(cfg: MCPServerConfig): void {
  const attempt = reconnectAttempts.get(cfg.name) ?? 0;
  const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempts.set(cfg.name, attempt + 1);
  if (reconnectTimers.has(cfg.name)) clearTimeout(reconnectTimers.get(cfg.name)!);
  reconnectTimers.set(
    cfg.name,
    setTimeout(() => {
      reconnectTimers.delete(cfg.name);
      log(`[Adapter:${cfg.name}] reconnecting (attempt ${attempt + 1}, delay ${delay / 1000}s)...`);
      void startOne(cfg);
    }, delay),
  );
}

// Tools that execute arbitrary code inside the remote app (editor.eval-like).
// They are surfaced and callable only while evalEnabled=true (same policy as
// the built-in editor.eval gate).
const DANGER_TOOL_SUFFIXES = [
  '.execute_blender_code',
  '.execute_code',
  '.execute_python',
  '.execute_python_code',
];

/** True for adapter tools that execute arbitrary code in the remote app. */
export function isDangerAdapterTool(toolName: string): boolean {
  return DANGER_TOOL_SUFFIXES.some((s) => toolName.toLowerCase().endsWith(s));
}

async function startOne(cfg: MCPServerConfig): Promise<void> {
  const tag = `[Adapter:${cfg.name}]`;
  if (cfg.enabled === false) {
    log(`${tag} disabled in config`);
    return;
  }
  // Healthy instance already present → nothing to do. A dead one (reconnect
  // path) is replaced below.
  const existing = adapters.get(cfg.name);
  if (existing && existing.enabled) {
    log(`${tag} already running`);
    return;
  }
  if (existing) adapters.delete(cfg.name);

  let capturedStderr = '';
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
    stderr: 'pipe' as const,
  });
  // Attach before start() so early stderr output is not lost.
  transport.stderr?.on('data', (d: Buffer) => {
    capturedStderr += String(d);
    if (capturedStderr.length > 600) capturedStderr = capturedStderr.slice(-600);
  });

  const client = new Client({ name: 'simple-mcp-server', version: '0.1.0' }, { capabilities: {} });
  const state: AdapterState = {
    cfg,
    client,
    transport,
    pid: null,
    tools: [],
    enabled: false,
    down: null,
  };
  adapters.set(cfg.name, state);

  transport.onclose = () => {
    if (state.enabled) {
      state.enabled = false;
      state.down = 'transport closed (child process exited?)';
      log(`${tag} transport closed — scheduling reconnect`);
      scheduleReconnect(cfg);
    }
  };

  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`connect timed out (${CONNECT_TIMEOUT_MS / 1000}s)`)), CONNECT_TIMEOUT_MS),
      ),
    ]);
    const listed = await client.listTools();
    const prefix = cfg.toolsPrefix ?? cfg.name;
    state.tools = (listed.tools ?? []).map((t: any) => ({
      name: `${prefix}.${String(t.name)}`,
      serverName: cfg.name,
      originalName: String(t.name),
      description: String(t.description ?? ''),
      inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
    }));
    // Mark enabled only after tools are fetched — a half-connected adapter must
    // not leak into listings.
    state.enabled = true;
    state.down = null;
    state.pid = transport.pid;
    reconnectAttempts.delete(cfg.name);
    log(`${tag} connected (pid=${state.pid}): ${state.tools.length} tool(s) under prefix "${prefix}.*"`);
  } catch (err: any) {
    state.enabled = false;
    state.down = err?.message ?? String(err);
    log(`${tag} connect/listTools failed:`, state.down);
    try { await transport.close(); } catch { /* already closed */ }
    adapters.delete(cfg.name);
    if (capturedStderr) log(`${tag} stderr tail:`, capturedStderr);
    // Never fatal: server keeps running without this adapter.
    return;
  }
}

export async function startAdapters(cfgs: MCPServerConfig[]): Promise<void> {
  for (const cfg of cfgs ?? []) {
    if (!cfg || !cfg.name || !cfg.command) continue;
    await startOne(cfg); // startOne never throws
  }
}

export function getAdapterTools(): AdapterTool[] {
  const out: AdapterTool[] = [];
  for (const st of adapters.values()) {
    if (!st.enabled) continue;
    for (const t of st.tools) out.push(t);
  }
  return out;
}

/** True if toolName is served by an external adapter. */
export function isAdapterTool(toolName: string): boolean {
  for (const st of adapters.values()) {
    if (!st.enabled) continue;
    for (const t of st.tools) {
      if (t.name === toolName) return true;
    }
  }
  return false;
}

const MEDIA_DIR = join(process.cwd(), 'mcp-media');
let mediaSeq = 0;

/** Persist an MCP image block to mcp-media/ and return the absolute path. */
function saveImageBlock(block: any): string {
  const mime = String(block.mimeType ?? 'image/png');
  const data = String(block.data ?? '');
  if (!data) return '[image: no data]';
  const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('gif') ? 'gif' : 'png';
  const file = join(MEDIA_DIR, `${Date.now()}_${++mediaSeq}.${ext}`);
  try {
    mkdirSync(MEDIA_DIR, { recursive: true });
    writeFileSync(file, Buffer.from(data, 'base64'));
    return `[image saved: ${file}]`;
  } catch (err: any) {
    return `[image decode failed: ${err?.message}]`;
  }
}

function formatContent(content: any): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push(saveImageBlock(block));
    else parts.push(JSON.stringify(block));
  }
  return parts.join('\n');
}

/** Call an adapter tool. Throws with a descriptive error when unavailable. */
export async function callAdapterTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  for (const st of adapters.values()) {
    if (!st.enabled) continue;
    const t = st.tools.find((x) => x.name === toolName);
    if (!t) continue;
    try {
      const res = await st.client.callTool({ name: t.originalName, arguments: args });
      if (res.isError) {
        const text = formatContent(res.content);
        throw new Error(text || 'tool returned isError without message');
      }
      return formatContent(res.content);
    } catch (err: any) {
      throw new Error(`[Adapter:${st.cfg.name}] ${err?.message ?? err}`);
    }
  }
  const state = [...adapters.values()].find((st) => st.tools.some((t) => t.name === toolName));
  if (state) {
    throw new Error(`[Adapter:${state.cfg.name}] tool '${toolName}' unavailable: ${state.down ?? 'adapter down'}`);
  }
  throw new Error(`No adapter registered for tool '${toolName}'`);
}

export async function stopAdapters(): Promise<void> {
  for (const [name, timer] of reconnectTimers) {
    clearTimeout(timer);
    reconnectTimers.delete(name);
  }
  for (const [name, st] of adapters) {
    try { await st.client.close(); } catch { /* ignore */ }
    log(`[Adapter:${name}] stopped`);
  }
  adapters.clear();
}