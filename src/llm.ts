import http from 'http';
import https from 'https';
import { getCachedConfig } from './config.js';
// ── Sanitize API keys in error messages ──
function sanitizeLLMError(text: string): string {
  return text.replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED]');
}

// ── LLM Integration ──

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

export function callLLM(req: AIRequestMessage): Promise<string> {
  const serverCfg = getCachedConfig();
  const llmCfg = serverCfg.llm;

  if (!llmCfg.enabled) {
    return Promise.reject(new Error('LLM is disabled on server (set llm.enabled=true in config.json)'));
  }

  const apiKey = process.env.LLM_API_KEY || llmCfg.apiKey;
  if (!apiKey) {
    return Promise.reject(new Error('LLM API key not configured. Set LLM_API_KEY env var or llm.apiKey in config.json'));
  }

  const messages = buildLLMMessages(req);

  // Build OpenAI-compatible request body
  const isOllama = llmCfg.provider === 'ollama' || llmCfg.baseUrl.includes('ollama');

  let bodyStr: string;
  if (isOllama) {
    bodyStr = JSON.stringify({
      model: llmCfg.model,
      prompt: req.prompt,
      context: req.context || {},
      options: {
        temperature: llmCfg.temperature,
        num_predict: llmCfg.maxTokens,
      },
      stream: false,
    });
  } else {
    bodyStr = JSON.stringify({
      model: llmCfg.model,
      messages,
      temperature: llmCfg.temperature,
      max_tokens: llmCfg.maxTokens,
    });
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (!isOllama) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('LLM request timed out after 60s'));
    }, 60_000);

    const url = new URL(`${llmCfg.baseUrl}/chat/completions`);
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
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timeout);
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

    httpreq.on('error', (e: Error) => {
      clearTimeout(timeout);
      reject(new Error(`LLM request failed: ${e.message}`));
    });

    httpreq.write(bodyStr);
    httpreq.end();
  });
}