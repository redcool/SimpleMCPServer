import crypto from 'crypto';
import { getCachedConfig } from './config.js';
// ── Payload encryption (shared-key AES-256-CBC) ──
// Requires both encryption=true in config and a non-empty encryptionKey.
// Format: #ENC#<base64(IV + ciphertext)> — matches bridge EncryptionHelper exactly.
// Bridge uses the same key. When encryption is OFF, payloads are sent as plaintext.

export function isEncryptionEnabled(): boolean {
  const cfg = getCachedConfig();
  return cfg.encryption && cfg.encryptionKey.length > 0;
}

export function encryptPayload(text: string): string {
  if (!isEncryptionEnabled()) return text;
  const key = getCachedConfig().encryptionKey;
  const keyBytes = crypto.createHash('sha256').update(key).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', keyBytes, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const combined = Buffer.concat([iv, enc]);
  return '#ENC#' + combined.toString('base64');
}

export function decryptPayload(data: string): string | null {
  if (!isEncryptionEnabled()) return data;
  try {
    // Check for #ENC# prefix (bridge format)
    const trimmed = data.trimStart();
    if (!trimmed.startsWith('#ENC#')) return data;
    const b64 = trimmed.slice(5).trim();
    const combined = Buffer.from(b64, 'base64');
    if (combined.length <= 16) return null;
    const iv = combined.subarray(0, 16);
    const ct = combined.subarray(16);
    const key = getCachedConfig().encryptionKey;
    const keyBytes = crypto.createHash('sha256').update(key).digest();
    const decipher = crypto.createDecipheriv('aes-256-cbc', keyBytes, iv);
    const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}