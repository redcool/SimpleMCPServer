import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { log } from './logger.js';
import { getCachedConfig, isIpAllowed } from './config.js';
import { callLLM } from './llm.js';
// ── ai-brain plugin host (SimpleAIBrain M01) ──
// 进程内插件加载器:读 config.aiBrain.path → import <path>/dist/index.js →
// 校验 contractVersion → init(ctx) → 暴露单例。加载失败 = 优雅降级(M01 §4):
// hub 照常启动,只是没有 memory.* 工具。结构类型,不与 brain 仓库编译期耦合。

export interface BrainPluginLike {
  contractVersion: number;
  name: string;
  init(ctx: BrainCtxLike): Promise<void>;
  getTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  callTool(name: string, args: Record<string, unknown>, identity: unknown): Promise<{ content: unknown; isError?: boolean }>;
  onToolEvent(evt: BrainToolEvent): void;
  registerRoutes?(app: { addRoute(method: string, path: string, handler: (req: unknown) => unknown): void }): void;
  shutdown(): Promise<void>;
  /** v1 扩展:token → 身份;缺失时 hub 一律按 null(访客)处理 */
  resolveIdentity?(token: string): unknown;
}

export interface BrainCtxLike {
  brainConfig: Record<string, unknown>;
  dataDir: string;
  logger: (msg: string) => void;
  callLLM: (msgs: unknown, opts?: unknown) => Promise<string>;
  httpApp: { addRoute(method: string, path: string, handler: (req: unknown) => unknown): void };
  serverVersion: string;
}

export interface BrainToolEvent {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  ms: number;
  transport: 'mcp' | 'rpc';
  identity: unknown;
}

let brain: BrainPluginLike | null = null;
const brainRoutes: Array<{ method: string; path: string; handler: (req: unknown) => unknown }> = [];

export function getBrain(): BrainPluginLike | null { return brain; }

export function isBrainTool(name: string): boolean { return name.startsWith('memory.'); }

/** 加载 brain 插件。任何失败只记警告,绝不抛出(M01 §4 优雅降级)。 */
export async function initBrain(serverVersion: string, configOverride?: Record<string, unknown>): Promise<void> {
  const src = configOverride ?? (getCachedConfig() as unknown as Record<string, unknown>);
  const aiBrain = src.aiBrain as Record<string, unknown> | undefined;
  if (!aiBrain || typeof aiBrain.path !== 'string' || !aiBrain.path) {
    log('[aiBrain] no aiBrain.path in config — plugin not loaded (hub continues)');
    return;
  }
  try {
    const entry = join(aiBrain.path, 'dist', 'index.js');
    if (!existsSync(entry)) {
      log('[aiBrain] WARNING: ' + entry + ' not found (npm run build in the brain repo) — hub continues without it');
      return;
    }
    const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
    if (typeof mod.createBrainPlugin !== 'function') throw new Error('dist/index.js does not export createBrainPlugin()');
    const plugin = (mod.createBrainPlugin as () => BrainPluginLike)();
    if (!plugin || plugin.contractVersion !== 1) {
      log('[aiBrain] WARNING: contractVersion=' + String(plugin?.contractVersion) + ', expected 1 — plugin not loaded');
      return;
    }
    const ctx: BrainCtxLike = {
      brainConfig: aiBrain,
      dataDir: typeof aiBrain.dataDir === 'string' && aiBrain.dataDir ? aiBrain.dataDir : join(aiBrain.path, 'data'),
      logger: (m) => log(m),
      callLLM: (msgs, _opts) => callLLM(msgs as never),
      httpApp: { addRoute: (method, path, handler) => { brainRoutes.push({ method, path, handler }); } },
      serverVersion,
    };
    await plugin.init(ctx);
    plugin.registerRoutes?.(ctx.httpApp);
    brain = plugin;
    log('[aiBrain] loaded v' + String(plugin.contractVersion) + ' from ' + aiBrain.path + ' (' + plugin.getTools().length + ' tools)');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('[aiBrain] WARNING: load failed (' + msg + ') — hub continues without brain');
    brain = null;
  }
}

/** token → 身份;无 brain/无解析器/坏 token 一律 null(访客) */
export function resolveBrainIdentity(token: string | undefined): unknown {
  if (!token || !brain || typeof brain.resolveIdentity !== 'function') return null;
  try { return brain.resolveIdentity(token); } catch { return null; }
}

const BRAIN_TOKEN_KEY = '_brainToken';

/** 从工具参数里摘除 _brainToken(统一覆盖 MCP 与 /rpc 两条路径的认证) */
export function popBrainToken(args: Record<string, unknown>): { token?: string; args: Record<string, unknown> } {
  if (args && typeof args[BRAIN_TOKEN_KEY] === 'string') {
    const rest = { ...args };
    const token = String(rest[BRAIN_TOKEN_KEY]);
    delete rest[BRAIN_TOKEN_KEY];
    return { token, args: rest };
  }
  return { args };
}

/** onToolEvent 永不阻塞主流程(M01 §4):同步吞异常 */
export function fireToolEvent(evt: BrainToolEvent): void {
  try { brain?.onToolEvent(evt); } catch { /* ignore */ }
}

/** 包一层计时 + 成败都触发 onToolEvent(transport 标记来源路径) */
export async function withBrainEvent<T>(toolName: string, args: Record<string, unknown>, identity: unknown, transport: 'mcp' | 'rpc', fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  let ok = true;
  try {
    const r = await fn();
    ok = !(r as { isError?: boolean } | null | undefined)?.isError;
    return r;
  } catch (e) {
    ok = false;
    throw e;
  } finally {
    fireToolEvent({ tool: toolName, args, ok, ms: Date.now() - t0, transport, identity });
  }
}

/** 分发 brain 插件注册的 HTTP 路由(/brain/*);未命中返回 handled:false;与其它 AI 端点同一 IP 白名单 */
export function handleBrainRoute(method: string | undefined, pathname: string, req: unknown): { handled: true; promise: Promise<{ status: number; body: string }> } | { handled: false } {
  const route = brainRoutes.find((r) => r.method === method && r.path === pathname);
  if (!route) return { handled: false };
  const remote = (req as { socket?: { remoteAddress?: string } } | null | undefined)?.socket?.remoteAddress;
  if (!isIpAllowed(remote)) {
    return { handled: true, promise: Promise.resolve({ status: 403, body: JSON.stringify({ error: 'Forbidden' }) }) };
  }
  const cap = getCachedConfig().limits.maxBodyBytes;
  const promise = (async () => {
    try {
      let arg: unknown = req;
      if (method === 'POST' && req && typeof (req as { on?: unknown }).on === 'function') {
        const chunks: Buffer[] = [];
        let total = 0;
        arg = await new Promise<unknown>((resolve, reject) => {
          (req as { on: (ev: string, cb: (c?: unknown) => void) => void }).on('data', (c?: unknown) => {
            const buf = c as Buffer;
            total += buf ? buf.length : 0;
            if (total > cap) { reject(new Error('body too large')); return; }
            chunks.push(buf);
          });
          (req as { on: (ev: string, cb: (c?: unknown) => void) => void }).on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw.trim()) { resolve(undefined); return; }
            try { resolve(JSON.parse(raw)); } catch { resolve(undefined); }
          });
          (req as { on: (ev: string, cb: (e?: unknown) => void) => void }).on('error', (e?: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
        });
      }
      const out = await route.handler(arg);
      const body = typeof out === 'string' ? out : JSON.stringify(out);
      return { status: 200, body };
    } catch (e) {
      return { status: 500, body: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) };
    }
  })();
  return { handled: true, promise };
}

/** 停服/退出:flush 强化批、关存储;绝不抛出 */
export async function shutdownBrain(): Promise<void> {
  const b = brain;
  brain = null;
  if (!b) return;
  try { await b.shutdown(); } catch (e) {
    log('[aiBrain] shutdown error: ' + (e instanceof Error ? e.message : String(e)));
  }
}
