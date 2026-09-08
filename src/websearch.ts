// websearch.ts — server-side web search tool (no API key required).
//
// Provider rotation (priority order from config.webSearch.order):
//   serper   (Serper.dev Google Search API — needs webSearch.serper.apiKey; auto-probed)
//   google   (Programmable Search JSON API — *closed to new customers*; needs apiKey+cx; auto-probed)
//   bing     (Bing RSS)
//   ddg-html (DuckDuckGo HTML)
//   ddg-lite (DuckDuckGo lite)
//
// Behavior:
// - Providers are tried in configured order; a blocked/unhealthy/empty provider is
//   skipped with a 400ms pause and the next one is tried.
// - CJK queries force a Chinese locale (serper gl/hl, google hl/gl, bing mkt/setlang, ddg kl)
//   so Chinese search quality is much better than the plain defaults.
// - serper/google are only used when credentials are configured AND the endpoint passes a
//   short connectivity probe (so China-mainland networks fall back to bing/ddg
//   automatically instead of timing out on every request).
// - Providers that fail repeatedly get a cooldown (config.webSearch.cooldownMs),
//   so one broken provider can't slow every search.
// - Responses are force-decoded as UTF-8 (Bing sometimes labels its XML with a
//   different charset, which would otherwise garble CJK text).
import { log } from './logger.js';
import { getCachedConfig } from './config.js';

const DDG_HTML = 'https://html.duckduckgo.com/html/';
const DDG_LITE = 'https://lite.duckduckgo.com/lite/';
const BING_RSS = 'https://www.bing.com/search';
const GOOGLE_API = 'https://www.googleapis.com/customsearch/v1';
const SERPER_API = 'https://google.serper.dev/search';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const utf8Decoder = new TextDecoder('utf-8');

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number.parseInt(n, 10)));
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function toRealUrl(href: string): string {
  // DDG HTML results wrap external links as //duckduckgo.com/l/?uddg=<encoded>&rut=...
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    if (u.hostname === 'duckduckgo.com' && u.pathname === '/l/') {
      const uddg = u.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
    }
    return u.href;
  } catch {
    return href;
  }
}

async function fetchBody(url: string, method = 'GET', formBody?: URLSearchParams, timeoutMs = 15_000): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    body: formBody,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = utf8Decoder.decode(await res.arrayBuffer());
  return { status: res.status, body };
}

function looksBlocked(body: string): boolean {
  return /anomaly|captcha|unusual traffic|challenge/i.test(body);
}

function parseAnchors(html: string, anchorRe: RegExp, snippetRe: RegExp): WebSearchResult[] {
  const anchors = [...html.matchAll(anchorRe)];
  if (anchors.length === 0) return [];
  const snippets = [...html.matchAll(snippetRe)].map((m) => stripTags(decodeEntities(m[1])));
  const out: WebSearchResult[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const m = anchors[i];
    const href = /href="([^"]+)"/i.exec(m[0])?.[1] ?? '';
    const title = stripTags(decodeEntities(m[1] ?? ''));
    if (!title || !href) continue;
    out.push({ title, url: toRealUrl(href), snippet: snippets[i] ?? '' });
  }
  return out;
}

// ── Locale helpers ──
function isCjk(q: string): boolean {
  return /[\u4e00-\u9fff]/.test(q);
}

/** Locale for a query: configured region for CJK, en-US otherwise. */
function localeFor(q: string): string {
  return isCjk(q) ? getCachedConfig().webSearch.region : 'en-US';
}

// ── Providers ──

async function searchDdgHtml(q: string, timeoutMs: number): Promise<WebSearchResult[]> {
  const form = new URLSearchParams({ q });
  // kl=cn-zh / kl=us-en — language-specific result set (huge for CJK quality)
  form.set('kl', isCjk(q) ? 'cn-zh' : 'us-en');
  const { status, body } = await fetchBody(DDG_HTML, 'POST', form, timeoutMs);
  if (looksBlocked(body)) throw new Error(`DuckDuckGo html blocked the request (HTTP ${status})`);
  return parseAnchors(
    body,
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
  );
}

async function searchDdgLite(q: string, timeoutMs: number): Promise<WebSearchResult[]> {
  const form = new URLSearchParams({ q });
  form.set('kl', isCjk(q) ? 'cn-zh' : 'us-en');
  const { status, body } = await fetchBody(DDG_LITE, 'POST', form, timeoutMs);
  if (looksBlocked(body)) throw new Error(`DuckDuckGo lite blocked the request (HTTP ${status})`);
  return parseAnchors(
    body,
    /<a[^>]+class="[^"]*result-link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
    /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi,
  );
}

async function searchBingRss(q: string, timeoutMs: number): Promise<WebSearchResult[]> {
  const cjk = isCjk(q);
  const mkt = cjk ? (getCachedConfig().webSearch.region || 'zh-CN') : 'en-US';
  const setlang = cjk ? 'zh-hans' : 'en';
  const cc = cjk ? 'CN' : '';
  const url = `${BING_RSS}?q=${encodeURIComponent(q)}&format=rss&count=10&mkt=${mkt}&setlang=${setlang}${cc ? `&cc=${cc}` : ''}`;
  const { status, body } = await fetchBody(url, 'GET', undefined, timeoutMs);
  if (status >= 400) throw new Error(`Bing HTTP ${status}`);
  if (!/<item>/i.test(body)) return [];
  const items = [...body.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const out: WebSearchResult[] = [];
  for (const m of items) {
    const block = m[1];
    const title = stripTags(decodeEntities(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(block)?.[1] ?? ''));
    const link = (/<link>\s*([\s\S]*?)\s*<\/link>/i.exec(block)?.[1] ?? '').trim();
    const desc = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i.exec(block)?.[1] ?? '';
    if (!title || !link) continue;
    out.push({ title, url: decodeEntities(link), snippet: decodeEntities(stripTags(desc)).slice(0, 300) });
  }
  return out;
}

/** Google Programmable Search JSON API — only used when apiKey+cx configured and reachable. */
async function searchGoogle(q: string, timeoutMs: number): Promise<WebSearchResult[]> {
  const g = getCachedConfig().webSearch.google;
  if (!g.apiKey || !g.cx) throw new Error('Google search not configured (webSearch.google.apiKey/cx empty)');
  const cjk = isCjk(q);
  const params = new URLSearchParams({
    key: g.apiKey,
    cx: g.cx,
    q,
    num: '10',
    hl: cjk ? (getCachedConfig().webSearch.region || 'zh-CN') : 'en',
  });
  if (cjk) params.set('gl', 'cn'); // geolocation for CJK results
  const url = `${GOOGLE_API}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google API HTTP ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  if (data.error) throw new Error(`Google API error: ${data.error.message ?? JSON.stringify(data.error)}`);
  const items: any[] = data.items ?? [];
  return items.map((it) => ({
    title: String(it.title ?? ''),
    url: String(it.link ?? ''),
    snippet: String(it.snippet ?? '').slice(0, 300),
  }));
}

/** Serper.dev — a Google-search API (free ~2500 queries/mo, no credit card).
 *  Works from networks where Google itself is reachable (corporate networks);
 *  auto-skipped when unreachable (mainland China). */
async function searchSerper(q: string, timeoutMs: number): Promise<WebSearchResult[]> {
  const key = getCachedConfig().webSearch.serper.apiKey;
  if (!key) throw new Error('Serper not configured (webSearch.serper.apiKey empty)');
  const cjk = isCjk(q);
  const region = getCachedConfig().webSearch.region || 'zh-CN';
  // gl = country code ("cn"), hl = language ("zh-cn"); derive from region zh-CN
  const gl = cjk ? 'cn' : 'us';
  const hl = cjk ? 'zh-cn' : 'en';
  void region;
  const res = await fetch(SERPER_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': key,
    },
    body: JSON.stringify({ q, gl, hl, num: 10 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  if (data.error) throw new Error(`Serper error: ${data.error.code ?? ''} ${data.error.message ?? JSON.stringify(data.error)}`);
  const organic: any[] = data.organic ?? [];
  return organic.map((it) => ({
    title: String(it.title ?? ''),
    url: String(it.link ?? ''),
    snippet: String(it.snippet ?? '').slice(0, 300),
  }));
}

// ── Provider registry (order from config.webSearch.order) ──

interface Provider {
  name: string;
  run: (q: string, timeoutMs: number) => Promise<WebSearchResult[]>;
}

const PROVIDERS: Record<string, Provider> = {
  'ddg-html': { name: 'ddg-html', run: searchDdgHtml },
  'ddg-lite': { name: 'ddg-lite', run: searchDdgLite },
  bing: { name: 'bing', run: searchBingRss },
  google: { name: 'google', run: searchGoogle },
  serper: { name: 'serper', run: searchSerper },
};

// Reachability probes for credentialed providers (serper/google). Cached, short
// timeout. If the API host is not reachable (e.g. mainland network), the provider
// is skipped without stalling searches.
interface Probe {
  ok: boolean | null; // null = unknown/in-flight
  at: number;
}
const probes: Record<string, Probe> = {
  serper: { ok: null, at: 0 },
  google: { ok: null, at: 0 },
};
const PROBE_COOLDOWN_MS = 5 * 60_000; // re-probe at most every 5 min

/** Kick off a HEAD probe for a provider endpoint; optimistic until known false. */
function probeHost(name: string, endpoint: string, timeoutMs: number): void {
  const now = Date.now();
  const p = probes[name];
  if (p.ok !== null && now - p.at < PROBE_COOLDOWN_MS) return;
  p.at = now;
  try {
    fetch(endpoint, { method: 'HEAD', signal: AbortSignal.timeout(Math.min(timeoutMs, 5_000)) })
      .then((r) => { probes[name].ok = r.status < 500; })
      .catch(() => { probes[name].ok = false; });
  } catch {
    probes[name].ok = false;
  }
}

// Per-provider cooldown bookkeeping
const providerFails = new Map<string, number>();
const providerCoolUntil = new Map<string, number>();

function providerList(): Provider[] {
  const cfg = getCachedConfig();
  const seen = new Set<string>();
  const out: Provider[] = [];
  const now = Date.now();
  for (const name of cfg.webSearch.order) {
    if (seen.has(name)) continue;
    seen.add(name);
    const p = PROVIDERS[name];
    if (!p) continue;
    // Credentialed providers: skip when not configured or known unreachable
    if (name === 'serper') {
      if (!cfg.webSearch.serper.apiKey) continue;
      if (probes.serper.ok === false) continue;
      probeHost('serper', SERPER_API, cfg.webSearch.providerTimeoutMs);
    } else if (name === 'google') {
      const g = cfg.webSearch.google;
      if (!g.apiKey || !g.cx) continue;
      if (probes.google.ok === false) continue;
      probeHost('google', GOOGLE_API, cfg.webSearch.providerTimeoutMs);
    }
    const coolUntil = providerCoolUntil.get(name) ?? 0;
    if (now < coolUntil) continue; // cooling down
    out.push(p);
  }
  return out;
}

function recordFailure(name: string): void {
  const fails = (providerFails.get(name) ?? 0) + 1;
  providerFails.set(name, fails);
  const cfg = getCachedConfig();
  if (fails >= 2) {
    providerCoolUntil.set(name, Date.now() + cfg.webSearch.cooldownMs);
    providerFails.set(name, 0);
    log(`[Server] web.search: provider '${name}' cooled down for ${cfg.webSearch.cooldownMs / 1000}s`);
  }
}

function recordSuccess(name: string): void {
  providerFails.delete(name);
  providerCoolUntil.delete(name);
}

/** Human-readable summary of the configured provider chain, for startup logs. */
export function getSearchProviderSummary(): string {
  const cfg = getCachedConfig();
  const names = cfg.webSearch.order.filter((n) => PROVIDERS[n]);
  const serper = cfg.webSearch.serper;
  const google = cfg.webSearch.google;
  // Kick reachability probes for credentialed providers at startup so the result
  // is usually already known by the time the first search runs (avoids one stall).
  if (serper.apiKey && probes.serper.ok === null) probeHost('serper', SERPER_API, cfg.webSearch.providerTimeoutMs);
  if (google.apiKey && google.cx && probes.google.ok === null) probeHost('google', GOOGLE_API, cfg.webSearch.providerTimeoutMs);
  const parts = names.map((n) => {
    if (n === 'serper') return serper.apiKey ? 'serper' : 'serper(no-key)';
    if (n === 'google') return google.apiKey && google.cx ? 'google' : 'google(no-key)';
    return n;
  });
  const region = cfg.webSearch.region || 'en-US';
  const seemsCn = typeof region === 'string' && region.includes('CN');
  const note = seemsCn ? ` (CJK→${region})` : '';
  const status = (p: Probe): string => (p.ok === false ? 'unreachable' : p.ok === true ? 'reachable' : 'probe-pending');
  const credNotes: string[] = [];
  if (serper.apiKey) credNotes.push(`serper:${status(probes.serper)}`);
  if (google.apiKey && google.cx) credNotes.push(`google:${status(probes.google)}`);
  const note2 = credNotes.length ? ` | ${credNotes.join(' ')}` : '';
  return `${parts.join(' → ')}${note}${note2}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function dedupe(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = r.url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Serialize searches: only one outbound search runs at a time (DDG/Bing have
 *  aggressive rate limits; concurrent bursts trigger challenge pages). */
let searchTail: Promise<unknown> = Promise.resolve();

export async function searchWeb(query: string, maxResults = 5): Promise<WebSearchResult[]> {
  const run = () => searchWebSerialized(query, maxResults);
  const prev = searchTail;
  let release!: () => void;
  searchTail = new Promise<void>((r) => { release = r; });
  await prev.catch(() => {});
  try {
    return await run();
  } finally {
    release();
  }
}

async function searchWebSerialized(query: string, maxResults = 5): Promise<WebSearchResult[]> {
  const q = query.trim();
  if (!q) throw new Error('query is required');

  const cfg = getCachedConfig();
  const providers = providerList();
  if (providers.length === 0) {
    throw new Error('web search failed (no usable provider — check config.webSearch.order and serper/google credentials)');
  }

  const errors: string[] = [];
  for (const p of providers) {
    try {
      const results = dedupe(await p.run(q, cfg.webSearch.providerTimeoutMs));
      if (results.length > 0) {
        recordSuccess(p.name);
        log(`[Server] web.search: query="${q.slice(0, 80).replace(/[\r\n"]/g, ' ')}" → ${results.length} result(s) via ${p.name}`);
        return results.slice(0, maxResults);
      }
      errors.push(`${p.name}: 0 results`);
      recordFailure(p.name);
    } catch (err: unknown) {
      errors.push(`${p.name}: ${err instanceof Error ? err.message : String(err)}`);
      recordFailure(p.name);
    }
    await sleep(400);
  }
  const unreachable = ['serper', 'google'].filter((n) => probes[n]?.ok === false);
  const hint = unreachable.length ? ` (${unreachable.join('/')} unreachable — mainland network?)` : '';
  throw new Error(`web search failed${hint} (${errors.join(' | ')})`);
}