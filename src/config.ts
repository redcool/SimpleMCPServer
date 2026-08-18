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
    const cfg: AppConfig = { ...defaults, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) };
    // Missing/absent/empty allowedIps → loopback-only default
    if (!Array.isArray(cfg.allowedIps) || cfg.allowedIps.length === 0) {
      cfg.allowedIps = [...DEFAULT_ALLOWED_IPS];
    }
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