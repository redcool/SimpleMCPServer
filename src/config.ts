import { readFileSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';
// ── Config ──

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.json');
const CONFIG_TEMPLATE_PATH = join(__dirname, '..', 'config.json.template');

export interface LLMConfig {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/** One external MCP server this server connects to as an MCP *client* (plan C).
 *  Its tools are exposed under "<toolsPrefix>.<toolName>" (default prefix = name).
 *  Example (BlenderMCP): {"name":"blender","command":"uvx","args":["blender-mcp"]}
 *  env: merged over the server's own environment (e.g. {"BLENDER_PORT":"9877"} to
 *  point a second blender-mcp instance at a different Blender socket). */
export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  toolsPrefix?: string;
}

/** Web search configuration (web.search tool). */
export interface WebSearchConfig {
  /** Provider priority order. Known names: "serper", "google", "bing", "ddg-html", "ddg-lite".
   *  Unknown names are skipped; providers without credentials are skipped too. */
  order: string[];
  /** Locale for CJK queries: "zh-CN" (serper gl/hl, google hl/gl, bing mkt, ddg kl). Non-CJK queries use the matching en-US locale. */
  region: string;
  /** Serper.dev Google Search API (free ~2500 queries/month, no credit card).
   *  Underlying index is Google — best quality for Chinese. Empty apiKey disables serper. */
  serper: { apiKey: string };
  /** Google Programmable Search Engine (JSON API) — *closed to new customers*
   *  (existing keys work until 2027-01-01). Empty apiKey/cx disables google. */
  google: { apiKey: string; cx: string };
  /** Per-provider fetch/parse timeout (ms). */
  providerTimeoutMs: number;
  /** After this many consecutive failures a provider is skipped for cooldownMs. */
  cooldownMs: number;
}

export interface AppConfig {
  ip: string;
  port: number;
  evalEnabled: boolean;
  encryption: boolean;
  encryptionKey: string;
  abCacheDir: string;
  /** IPs allowed to call the AI-facing HTTP endpoints (/rpc, /sse, /mcp). Default: loopback only. */
  allowedIps: string[];
  llm: LLMConfig;
  /** External MCP servers (e.g. BlenderMCP) to proxy tools from. */
  mcpServers: MCPServerConfig[];
  webSearch: WebSearchConfig;
}

let appConfigCache: AppConfig | null = null;

export function getCachedConfig(): AppConfig {
  if (!appConfigCache) appConfigCache = loadAppConfig();
  return appConfigCache;
}

/** Warm the config cache at startup and return the loaded config. */
export function reloadConfig(): AppConfig {
  appConfigCache = loadAppConfig();
  return appConfigCache;
}

const DEFAULT_ALLOWED_IPS = ['127.0.0.1', '::1'];

export function loadAppConfig(): AppConfig {
  const defaults: AppConfig = {
    ip: '127.0.0.1',
    port: 45678,
    evalEnabled: true,
    encryption: false,
    encryptionKey: '',
    allowedIps: [...DEFAULT_ALLOWED_IPS],
    llm: {
      enabled: false,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o',
      temperature: 0.7,
      maxTokens: 1024,
    },
    abCacheDir: join(process.cwd(), 'ab-cache'),
    mcpServers: [],
    webSearch: {
      order: ['serper', 'google', 'bing', 'ddg-html', 'ddg-lite'],
      region: 'zh-CN',
      serper: { apiKey: '' },
      google: { apiKey: '', cx: '' },
      providerTimeoutMs: 15_000,
      cooldownMs: 60_000,
    },
  };
  // ── Auto-create config.json from config.json.template when missing ──
  // Replaces the manual "rename .template" step. config.json is gitignored,
  // so this never touches tracked files.
  if (!existsSync(CONFIG_PATH) && existsSync(CONFIG_TEMPLATE_PATH)) {
    try {
      copyFileSync(CONFIG_TEMPLATE_PATH, CONFIG_PATH);
      log('[Server] config.json not found — copied from config.json.template');
    } catch (e: any) {
      log('[Server] Failed to copy config.json.template → config.json:', e.message);
    }
  }
  if (!existsSync(CONFIG_PATH)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    const cfg: AppConfig = {
      ...defaults,
      ...raw,
      // Deep-merge webSearch (shallow spread would drop sub-objects like google/serper)
      webSearch: {
        ...defaults.webSearch,
        ...(raw.webSearch ?? {}),
        google: { ...defaults.webSearch.google, ...((raw.webSearch ?? {}).google ?? {}) },
        serper: { ...defaults.webSearch.serper, ...((raw.webSearch ?? {}).serper ?? {}) },
      },
    };
    // Missing/absent/empty allowedIps → loopback-only default
    if (!Array.isArray(cfg.allowedIps) || cfg.allowedIps.length === 0) {
      cfg.allowedIps = [...DEFAULT_ALLOWED_IPS];
    }
    // Sanitize provider order: drop empties, keep only known names (validated in websearch.ts)
    if (!Array.isArray(cfg.webSearch.order)) cfg.webSearch.order = [...defaults.webSearch.order];
    return cfg;
  } catch (e: any) {
    log('[Server] Config parse error, using defaults:', e.message);
    return defaults;
  }
}

/** True if the given remote address may call AI-facing HTTP endpoints.
 *  Normalizes IPv4-mapped IPv6 (::ffff:127.0.0.1 → 127.0.0.1). */
export function isIpAllowed(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  let ip = remoteAddress;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return getCachedConfig().allowedIps.includes(ip);
}