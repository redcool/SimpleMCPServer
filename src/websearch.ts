// websearch.ts — server-side web search tool (no API key).
// Provider rotation: DuckDuckGo HTML → Bing RSS → DuckDuckGo lite.
// - DDG intermittently serves anomaly/captcha challenge pages (HTTP 202) to this
//   network, so a blocked/unhealthy provider is skipped and the next is tried.
// - Responses are force-decoded as UTF-8 (Bing sometimes labels its XML with a
//   different charset, which would otherwise garble CJK text).
import { log } from './logger.js';

const DDG_HTML = 'https://html.duckduckgo.com/html/';
const DDG_LITE = 'https://lite.duckduckgo.com/lite/';
const BING_RSS = 'https://www.bing.com/search';
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

async function fetchBody(url: string, method = 'GET', formBody?: URLSearchParams): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    body: formBody,
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
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

async function searchDdgHtml(q: string): Promise<WebSearchResult[]> {
  const { status, body } = await fetchBody(DDG_HTML, 'POST', new URLSearchParams({ q }));
  if (looksBlocked(body)) throw new Error(`DuckDuckGo html blocked the request (HTTP ${status})`);
  return parseAnchors(
    body,
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
  );
}

async function searchDdgLite(q: string): Promise<WebSearchResult[]> {
  const { status, body } = await fetchBody(DDG_LITE, 'POST', new URLSearchParams({ q }));
  if (looksBlocked(body)) throw new Error(`DuckDuckGo lite blocked the request (HTTP ${status})`);
  return parseAnchors(
    body,
    /<a[^>]+class="[^"]*result-link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
    /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi,
  );
}

async function searchBingRss(q: string): Promise<WebSearchResult[]> {
  const url = `${BING_RSS}?q=${encodeURIComponent(q)}&format=rss&count=10&mkt=en-US&setlang=en`;
  const { status, body } = await fetchBody(url);
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

export async function searchWeb(query: string, maxResults = 5): Promise<WebSearchResult[]> {
  const q = query.trim();
  if (!q) throw new Error('query is required');

  const providers: Array<{ name: string; run: () => Promise<WebSearchResult[]> }> = [
    { name: 'ddg-html', run: () => searchDdgHtml(q) },
    { name: 'bing-rss', run: () => searchBingRss(q) },
    { name: 'ddg-lite', run: () => searchDdgLite(q) },
  ];

  const errors: string[] = [];
  for (const p of providers) {
    try {
      const results = dedupe(await p.run());
      if (results.length > 0) {
        log(`[Server] web.search: query="${q.slice(0, 80)}" → ${results.length} result(s) via ${p.name}`);
        return results.slice(0, maxResults);
      }
      errors.push(`${p.name}: 0 results`);
    } catch (err: unknown) {
      errors.push(`${p.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(400);
  }
  throw new Error(`web search failed (${errors.join(' | ')})`);
}