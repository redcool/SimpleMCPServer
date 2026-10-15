import http from 'http';
import https from 'https';
import { getCachedConfig } from './config.js';
import { log } from './logger.js';
// ── Sanitize API keys in error messages ──
function sanitizeLLMError(text: string): string {
  return text.replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED]');
}

// ── LLM Integration ──

/** 一个可用渠道:OpenAI 兼容(baseUrl+/chat/completions)或 ollama */
export interface LLMEndpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AIRequestMessage {
  prompt: string;
  context?: Record<string, unknown>;
  system?: string;
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

function buildLLMMessages(req: AIRequestMessage): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

  if (req.system) {
    messages.push({ role: 'system', content: req.system });
  }

  if (req.messages && req.messages.length > 0) {
    messages.push(...req.messages);
  }

  let userContent = req.prompt;
  if (req.context && Object.keys(req.context).length > 0) {
    const contextStr = Object.entries(req.context)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join('\n');
    userContent = `Context:\n${contextStr}\n\nUser: ${req.prompt}`;
  }

  messages.push({ role: 'user', content: userContent });
  return messages;
}

/** 渠道链执行:按序尝试,全部失败抛聚合错误(错误已脱敏)。测试直接注入 endpoints。 */
export async function callLLMWithEndpoints(req: AIRequestMessage, endpoints: LLMEndpoint[]): Promise<string> {
  if (endpoints.length === 0) return Promise.reject(new Error('LLM: no channel configured'));
  let lastErr: Error = new Error('LLM: no attempt made');
  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    try {
      return await attemptLLM(ep, req);
    } catch (e: any) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const hasNext = i + 1 < endpoints.length;
      log(`[LLM] channel ${ep.model} failed: ${lastErr.message}${hasNext ? ' — trying next channel' : ''}`);
    }
  }
  throw new Error(`LLM all ${endpoints.length} channels failed; last: ${lastErr.message}`);
}

/** 从 config.json 解析渠道链:主渠道(env 覆盖 key)+ fallbacks(≤3,自带 key) */
export function callLLM(req: AIRequestMessage): Promise<string> {
  const llmCfg = getCachedConfig().llm;

  if (!llmCfg.enabled) {
    return Promise.reject(new Error('LLM is disabled on server (set llm.enabled=true in config.json)'));
  }

  const primary: LLMEndpoint = {
    baseUrl: llmCfg.baseUrl,
    model: llmCfg.model,
    apiKey: process.env.LLM_API_KEY || llmCfg.apiKey,
    provider: llmCfg.provider,
    temperature: llmCfg.temperature,
    maxTokens: llmCfg.maxTokens,
  };
  const isLocal = (ep: LLMEndpoint): boolean => ep.provider === 'ollama' || ep.baseUrl.includes('ollama');
  const fallbacks: LLMEndpoint[] = (llmCfg.fallbacks ?? []).slice(0, 3).map((fb) => ({
    baseUrl: fb.baseUrl,
    model: fb.model,
    apiKey: fb.apiKey,
    provider: fb.provider,
    temperature: fb.temperature,
    maxTokens: fb.maxTokens,
  }));
  const validFallbacks = fallbacks.filter((fb) => isLocal(fb) || (fb.apiKey ?? '').length > 0);
  if (!primary.apiKey && validFallbacks.length === 0) {
    return Promise.reject(new Error('LLM API key not configured. Set LLM_API_KEY env var or llm.apiKey in config.json'));
  }

  // 主渠道缺 key 时仍入链:attemptLLM 会快速失败并落到回退(日志可见)
  return callLLMWithEndpoints(req, [primary, ...validFallbacks]);
}

function attemptLLM(ep: LLMEndpoint, req: AIRequestMessage): Promise<string> {
  const apiKey = ep.apiKey ?? '';
  if (!apiKey && !(ep.provider === 'ollama' || ep.baseUrl.includes('ollama'))) {
    return Promise.reject(new Error('LLM API key not configured. Set LLM_API_KEY env var or llm.apiKey in config.json'));
  }

  const messages = buildLLMMessages(req);

  // Build OpenAI-compatible request body
  const isOllama = ep.provider === 'ollama' || ep.baseUrl.includes('ollama');

  let bodyStr: string;
  if (isOllama) {
    bodyStr = JSON.stringify({
      model: ep.model,
      prompt: req.prompt,
      context: req.context || {},
      options: {
        temperature: ep.temperature ?? 0.7,
        num_predict: ep.maxTokens ?? 1024,
      },
      stream: false,
    });
  } else {
    bodyStr = JSON.stringify({
      model: ep.model,
      messages,
      temperature: ep.temperature ?? 0.7,
      max_tokens: ep.maxTokens ?? 1024,
    });
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (!isOllama) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const MAX_LLM_RESPONSE = 10 * 1024 * 1024; // 10MB guard

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    const timeout = setTimeout(() => {
      settle(() => reject(new Error('LLM request timed out after 60s')));
    }, 60_000);

    const url = new URL(`${ep.baseUrl}/chat/completions`);
    const httpModule = url.protocol === 'https:' ? https : http;

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers,
    };

    const httpreq = httpModule.request(options, (res: http.IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk;
        if (data.length > MAX_LLM_RESPONSE) {
          settle(() => reject(new Error('LLM response too large (limit 10MB)')));
          res.destroy();
        }
      });
      res.on('end', () => {
        settle(() => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`LLM API error ${res.statusCode}: ${sanitizeLLMError(parsed.error?.message || data)}`));
              return;
            }

            if (isOllama) {
              resolve(String(parsed.response || parsed.message?.content || ''));
              return;
            }

            const content = parsed.choices?.[0]?.message?.content;
            if (content) {
              resolve(content);
            } else {
              reject(new Error(`Invalid LLM response: ${sanitizeLLMError(data)}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse LLM response: ${sanitizeLLMError(data)}`));
          }
        });
      });
    });

    httpreq.on('error', (e: Error) => {
      settle(() => reject(new Error(`LLM request failed: ${e.message}`)));
    });

    httpreq.write(bodyStr);
    httpreq.end();
  });
}