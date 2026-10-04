// Minimal static file server for the packaged desktop client (desktop/main.mjs).
//
// tools/package-client.mjs already flattens the game server's mount layout into one directory (www/), so the
// Electron shell only has to serve plain files — no /data.js shim, no sim mount rules, no WebSocket. It binds
// loopback only: the packaged client is the sole consumer, and game traffic goes to the remote server instead.
//
// MIME / COMPRESSIBLE mirror server/index.js; test/packaging.test.js pins the two tables together so they cannot
// drift apart.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

/** Extension → Content-Type (same table as server/index.js MIME). */
export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.atlas': 'text/plain; charset=utf-8',
  '.skel': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
});

/**
 * Loopback port the desktop shell asks for. Chromium scopes localStorage (and the shell's own `sp.shell.*`
 * server choice) by *origin*, so the old `port: 0` — a fresh OS-assigned port every launch — meant every run
 * wrote to a different `http://127.0.0.1:<port>` and read back nothing: identity token, loadout, settings and
 * the remembered server were "lost" on every restart. A pinned port keeps the origin (and therefore the data).
 */
export const DEFAULT_PORT = 47821;
/** Consecutive ports tried when the preferred one is taken. The order is fixed, so the origin stays put anyway. */
export const PORT_SEARCH = 16;

/** First path segments under www/ that are content-addressed enough to cache for a day (server/index.js LONG_CACHE_DIRS). */
const LONG_CACHE_DIRS = new Set(['assets', 'fonts', 'vendor']);
const LONG_CACHE = 'public, max-age=86400';
const NO_CACHE = 'no-cache';

/** @param {string} ext @param {string[]} segments */
export function cacheControlFor(ext, segments) {
  if (ext === '.html' || ext === '.htm') return NO_CACHE;
  if (segments.length > 1 && LONG_CACHE_DIRS.has(segments[0])) return LONG_CACHE;
  return NO_CACHE;
}

/**
 * Resolve a request URL path to a file inside `root`, or null when it must be rejected (traversal, dotfile, …).
 * @param {string} root absolute
 * @param {string} rawUrl e.g. `/js/main.js?v=2`
 * @returns {string|null} absolute path (may not exist)
 */
export function resolveTarget(root, rawUrl) {
  const q = rawUrl.indexOf('?');
  let decoded;
  try { decoded = decodeURIComponent(q === -1 ? rawUrl : rawUrl.slice(0, q)); } catch { return null; }
  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return null;
  const target = path.join(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/** `bytes=a-b` → [start, end] clamped to the file, or null (ignored / unsatisfiable). */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end;
  if (!m[1]) { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] ? Number(m[2]) : size - 1; }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return [start, Math.min(end, size - 1)];
}

/** Reserved same-origin path the page calls to reach a remote server's /healthz (see createStaticServer's `proxy`). */
export const HEALTHZ_PROXY_PATH = '/__sp/healthz';
/** Give up on a remote /healthz that does not answer in time. */
const HEALTHZ_PROXY_TIMEOUT_MS = 4000;

/**
 * Resolve a `/__sp/healthz?url=<http(s)://host/healthz>` request to the remote URL to fetch, or null when it is not
 * an allowed target. Only this game's status endpoint is relayed, so the route is never an open proxy.
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function healthzProxyTarget(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl ?? ''), 'http://127.0.0.1'); } catch { return null; }
  if (u.pathname !== HEALTHZ_PROXY_PATH) return null;
  let t;
  try { t = new URL(u.searchParams.get('url') || ''); } catch { return null; }
  if (t.protocol !== 'http:' && t.protocol !== 'https:') return null;
  if (!/\/healthz\/?$/.test(t.pathname)) return null;
  return t.toString();
}

/**
 * Start the loopback static server.
 *
 * `port > 0` is preferred and, if it is busy, the next PORT_SEARCH consecutive ports are tried before giving up
 * and letting the OS pick one (`port: 0`). The caller keeps the resulting origin stable by passing a fixed port
 * (see DEFAULT_PORT) — persistence in the page depends on it.
 *
 * @param {{ root: string, host?: string, port?: number, proxy?: boolean, log?: { warn?: Function, error?: Function } }} opts
 * @returns {Promise<{ url: string, port: number, server: http.Server, close: () => Promise<void> }>}
 */
export function createStaticServer({ root, host = '127.0.0.1', port = 0, proxy = false, log = console } = {}) {
  const rootAbs = path.resolve(root);

  const finish = (req, res, status, headers, body) => {
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  /**
   * Relay a remote server's /healthz same-origin. The game server sends no CORS headers, so the page cannot read
   * that body itself; the Electron main process can (Node has no origin), which is exactly what this route exposes.
   */
  async function proxyHealthz(req, res) {
    const target = healthzProxyTarget(req.url);
    const json = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (!target) { finish(req, res, 400, json, '{"ok":false}'); return; }
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { try { ctrl?.abort(); } catch { /* ignore */ } }, HEALTHZ_PROXY_TIMEOUT_MS);
    try {
      const r = await fetch(target, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      finish(req, res, r.status, json, await r.text());
    } catch (e) {
      log.warn?.('[client] /healthz proxy failed', target, e?.message || e);
      finish(req, res, 502, json, '{"ok":false}');
    } finally {
      clearTimeout(timer);
    }
  }

  async function handle(req, res) {
    if (proxy && healthzProxyTarget(req.url)) { await proxyHealthz(req, res); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      finish(req, res, 405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'method not allowed');
      return;
    }
    const target = resolveTarget(rootAbs, req.url || '/');
    if (!target) { finish(req, res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'forbidden'); return; }

    let absPath = target;
    let stat;
    try {
      stat = await fsp.stat(absPath);
      if (stat.isDirectory()) {
        absPath = path.join(absPath, 'index.html');
        stat = await fsp.stat(absPath);
      }
      if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
    } catch (e) {
      const status = e && (e.code === 'EACCES' || e.code === 'EPERM') ? 403 : 404;
      finish(req, res, status, { 'Content-Type': 'text/plain; charset=utf-8' }, status === 403 ? 'forbidden' : 'not found');
      return;
    }

    const segments = path.relative(rootAbs, absPath).split(path.sep);
    const ext = path.extname(absPath).toLowerCase();
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControlFor(ext, segments),
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
      'Accept-Ranges': 'bytes',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }

    const range = parseRange(req.headers.range, stat.size);
    if (range) {
      const [start, end] = range;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length'] = String(end - start + 1);
      res.writeHead(206, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(absPath, { start, end }).pipe(res);
      return;
    }
    if (req.headers.range) {
      headers['Content-Range'] = `bytes */${stat.size}`;
      res.writeHead(416, headers);
      res.end();
      return;
    }
    headers['Content-Length'] = String(stat.size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(absPath).pipe(res);
  }

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    handle(req, res).catch((e) => {
      log.error?.('[client] request failed', req.url, e);
      if (!res.headersSent) finish(req, res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'internal error');
      else res.end();
    });
  });

  const candidates = port > 0
    ? [...Array.from({ length: PORT_SEARCH }, (_, i) => port + i).filter((p) => p <= 65535), 0]
    : [0];

  const listen = (p) => new Promise((resolve, reject) => {
    const onError = (e) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(p, host);
  });

  return (async () => {
    let failure = null;
    for (let i = 0; i < candidates.length; i++) {
      const p = candidates[i];
      try {
        await listen(p);
        failure = null;
        break;
      } catch (e) {
        failure = e;
        if (e?.code !== 'EADDRINUSE') throw e;
        if (candidates[i + 1] > 0) log.warn?.(`[client] loopback port ${p} is in use — trying ${candidates[i + 1]}`);
      }
    }
    if (failure) throw failure;
    server.on('error', (e) => log.error?.('[client] server error', e));
    const actual = server.address().port;
    return {
      url: `http://${host}:${actual}`,
      port: actual,
      server,
      close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections?.(); }),
    };
  })();
}
