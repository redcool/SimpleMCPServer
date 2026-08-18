import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// ── Logging utility ──
// All server log output goes through this function.
// It writes to BOTH the console (via stderr, which the cmd window shows)
// AND the server.log file (for persistence).
// Format: [Beijing-time] [TAG] message
// Change this single function to redirect logs or add log levels.
import { appendFileSync } from 'fs';

const _consoleError = console.error.bind(console);

export function log(message: string, ...extra: any[]) {
  const beijing = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const tagMatch = message.match(/^\[(\w+)\]\s*/);
  let formatted: string;
  if (tagMatch) {
    const tag = tagMatch[1];
    const cleanMsg = message.slice(tagMatch[0].length);
    formatted = `[${beijing}] [${tag}] ${cleanMsg}`;
    _consoleError(formatted, ...extra);
  } else {
    formatted = `[${beijing}] ${message}`;
    _consoleError(formatted, ...extra);
  }

  // Also append to server.log (flush immediately)
  try {
    const extraStr = extra.length > 0 ? ' ' + extra.map(e => String(e)).join(' ') : '';
    const logFile = join(__dirname, '..', 'server.log');
    appendFileSync(logFile, formatted + extraStr + '\n', 'utf-8');
  } catch { /* best-effort */ }
}