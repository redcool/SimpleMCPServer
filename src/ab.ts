import http from 'http';
import * as os from 'os';
import { join } from 'path';
import { existsSync, statSync, mkdirSync, copyFileSync, createWriteStream, createReadStream, unlinkSync } from 'fs';
import { getCachedConfig } from './config.js';
import { log } from './logger.js';
import { bridges } from './bridgeState.js';

const MAX_AB_SIZE = 512 * 1024 * 1024; // 512MB — streamed AssetBundle upload/download (NOT buffered like JSON routes)
// ── AssetBundle cache & phone-reachable host helper ──
// The server doubles as the AB relay: Editor builds+uploads via POST /ab,
// the runtime bridge (e.g. Android phone) downloads via GET /ab/<file>.
function getLanIp(): string | null {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (!net.internal && net.family === 'IPv4') return net.address;
      }
    }
  } catch {}
  return null;
}

/** Returns "host:port" a remote bridge can reach the server on.
 *  Prefers the configured IP when it is a real address; otherwise picks the
 *  local IPv4 that shares a subnet with a connected remote bridge (so a
 *  multi-homed server serves the right interface to each client), falling
 *  back to the first non-internal LAN IPv4. */
function bestHostForBridge(): string {
  const cfg = getCachedConfig();
  const ip = cfg.ip;
  if (ip && ip !== '0.0.0.0' && ip !== '127.0.0.1' && ip !== '::') return `${ip}:${cfg.port}`;

  // Prefer the local interface that shares a subnet with a connected remote bridge.
  const remoteIps = [...bridges.values()]
    .map(b => b.clientIp || '')
    .filter(c => c && c !== '127.0.0.1' && c !== '::1')
    .map(c => c.startsWith('::ffff:') ? c.slice(7) : c);
  const nets = os.networkInterfaces();
  for (const remote of remoteIps) {
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.internal || net.family !== 'IPv4' || !net.netmask) continue;
        if (sameSubnet(remote, net.address, net.netmask)) return `${net.address}:${cfg.port}`;
      }
    }
  }
  const lan = getLanIp();
  return lan ? `${lan}:${cfg.port}` : `${ip || '127.0.0.1'}:${cfg.port}`;
}

/** True if IPv4 a and b are in the same subnet given netmask. */
function sameSubnet(a: string, b: string, mask: string): boolean {
  const ai = a.split('.'), bi = b.split('.'), mi = mask.split('.');
  if (ai.length !== 4 || bi.length !== 4 || mi.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    if ((parseInt(ai[i], 10) & parseInt(mi[i], 10)) !== (parseInt(bi[i], 10) & parseInt(mi[i], 10))) return false;
  }
  return true;
}


/**
 * AssetBundle transfer — stream binary AB files (binary-safe, NOT string concat).
 *   POST /ab?name=<file>   body = raw AB bytes → streamed to <abCacheDir>/<file>
 *   GET  /ab/<file>        streams the file back. Used by shader.hot_replace (runtime bridge).
 */
export async function handleABRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
      const abDir = getCachedConfig().abCacheDir || join(process.cwd(), 'ab-cache');

      // GET /ab/<file> — download
      if (req.method === 'GET' && url.pathname.startsWith('/ab/')) {
        const file = decodeURIComponent(url.pathname.slice('/ab/'.length));
        if (!/^[A-Za-z0-9._-]+$/.test(file) || file.length > 255) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid file name' }));
          return;
        }
        const filePath = join(abDir, file);
        if (!existsSync(filePath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'AssetBundle not found' }));
          return;
        }
        const st = statSync(filePath);
        if (!st.isFile()) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not a file' }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': st.size,
        });
        log(`[Server] Serving AB '${file}' (${st.size} bytes) to ${req.socket.remoteAddress || 'unknown'}`);
        createReadStream(filePath).pipe(res);
        return;
      }

      // POST /ab?name=<file> — upload (raw binary body = AB bytes)
      if (req.method === 'POST') {
        const name = url.searchParams.get('name') || `ab_${Date.now()}`;
        if (!/^[A-Za-z0-9._-]+$/.test(name) || name.length > 255) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid file name' }));
          return;
        }
        try { mkdirSync(abDir, { recursive: true }); } catch (e: any) { log('[Server] mkdir ab-cache error:', e.message); }

        // ── Same-PC fast path: server copies the bridge's local build file directly (no upload) ──
        // The bridge passes localpath = absolute path of the file it just built. If the server can
        // read it (same machine), copy it into ab-cache and return the URL — zero bytes transferred.
        // If not (cross-PC), tell the bridge to stream-upload instead.
        const localpath = url.searchParams.get('localpath');
        if (localpath) {
          let lp = localpath;
          try { lp = decodeURIComponent(localpath); } catch {}
          let handled = false;
          try {
            if (existsSync(lp)) {
              const lst = statSync(lp);
              if (lst.isFile()) {
                const dest = join(abDir, name);
                copyFileSync(lp, dest);
                const host = bestHostForBridge();
                const dlUrl = `http://${host}/ab/${name}`;
                log(`[Server] AB '${name}' local-copy from '${lp}' (${lst.size} bytes) → ${dlUrl}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, file: name, bytes: lst.size, url: dlUrl, host, mode: 'local-copy' }));
                handled = true;
              }
            }
          } catch (e: any) {
            log(`[Server] local-copy failed for '${lp}', requesting streaming upload: ${e.message}`);
          }
          if (handled) { req.resume(); return; }
          // Local file not accessible (likely cross-PC) — bridge should stream-upload instead.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, code: 'local_unavailable' }));
          req.resume();
          return;
        }

        const filePath = join(abDir, name);
        const out = createWriteStream(filePath);
        let received = 0, aborted = false;
        req.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_AB_SIZE) {
            aborted = true;
            try { out.destroy(); } catch {}
            try { unlinkSync(filePath); } catch {}
            if (!res.headersSent) {
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'AssetBundle too large (limit ' + MAX_AB_SIZE + ' bytes)' }));
            }
          }
        });
        req.pipe(out);
        out.on('finish', () => {
          if (aborted) return;
          const host = bestHostForBridge();
          const dlUrl = `http://${host}/ab/${name}`;
          log(`[Server] Stored AB '${name}' (${received} bytes) → ${dlUrl}`);
          if (!res.headersSent) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, file: name, bytes: received, url: dlUrl, host, port: getCachedConfig().port }));
          }
        });
        out.on('error', (err) => {
          aborted = true;
          try { unlinkSync(filePath); } catch {}
          if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); }
        });
        req.on('error', () => {
          aborted = true;
          try { out.destroy(); } catch {}
          if (!res.headersSent) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Upload aborted' })); }
        });
        return;
      }

      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Use GET /ab/<file> or POST /ab?name=<file>' }));
      return;
}