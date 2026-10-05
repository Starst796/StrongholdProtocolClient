// "Open to LAN" host server for the packaged desktop client: runs the *real* game server (the payload's
// server/net.js + server/lobby.js + match/*, the same modules the in-page offline server uses) inside the Electron
// main process and answers real WebSocket connections, so other devices on the LAN can join.
//
// It is the Minecraft "integrated server" model: solo play already runs this process privately on 127.0.0.1; opening
// to LAN just rebinds to 0.0.0.0 and advertises the address. The game client (renderer) then connects to it over a
// normal ws:// socket, exactly like any remote server — no in-page loopback involved.
//
// Plain ws:// (no TLS): LAN/loopback addresses are plain ws by public/js/net.js' own rule. Data is read from the
// payload's /data/*.json on disk and injected as globalThis.__SP_DATA__ before the server modules load (their
// generated ../data.js reads it), so nothing needs a filesystem inside the browser-side modules.
//
// It also serves the whole payload over the same port (HTTP + WS share it), so a LAN peer can just open
// http://<host>:<port> in a browser and play — no client install. Guests get a runtime-config that points them at
// their own origin and skips the shell picker (see lanRuntimeConfig / shell/picker.js __SP_LAN_CLIENT__).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequestHandler } from './serve.mjs';
// `ws` is CommonJS; resolve the constructor across the interop shapes so this works both from node_modules and from
// inside the packaged app.asar. (Node exposes it as the named `WebSocketServer`; the namespace also carries it.)
import * as wsNs from 'ws';

const WebSocketServer = wsNs.WebSocketServer || (wsNs.default && wsNs.default.WebSocketServer);

/** Default LAN port (the static server uses DEFAULT_PORT=47821 next door). */
export const HOST_PORT = 47822;
/** Consecutive ports tried when the preferred one is taken, before falling back to an OS-assigned port. */
const PORT_SEARCH = 16;
/** Inbound WebSocket frame limit (same as the game server, server/index.js WS_MAX_PAYLOAD). */
const WS_MAX_PAYLOAD = 64 * 1024;

const QUIET = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });

/**
 * The game's server modules (Network / Lobby) call `log.info(...)` / `log.error(...)`, i.e. they need a logger
 * *object*. The Electron shell hands us a single variadic `log(...)` **function** (desktop/main.mjs writes it to
 * client.log); passing that straight through made every `room.create` / `room.join` throw `this.log.error is not a
 * function` inside the frame handler — the reply was never sent and the client hung/retried ("创建同盟很卡/失败").
 * Normalise either shape here.
 */
export function toLogger(log) {
  if (log && typeof log.info === 'function' && typeof log.error === 'function') return log;
  const fn = typeof log === 'function' ? log : () => {};
  const at = (level) => (...a) => fn(`[host:${level}]`, ...a);
  return { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}

/**
 * /js/runtime-config.js served to LAN guests: empty `__SP_SERVER__` makes public/js/net.js connect to the guest's
 * own origin (this host), and `__SP_LAN_CLIENT__` tells the shell picker to skip its menu and enter directly.
 */
export function lanRuntimeConfig() {
  return `// Served by the LAN host — the guest plays on this server (its own origin).
globalThis.__SP_SERVER__ = '';
globalThis.__SP_OFFLINE__ = false;
globalThis.__SP_LAN_CLIENT__ = true;
`;
}

/** Read every data/*.json in `dir` into `{ [basename]: parsed }` (same shape the game server loads). */
export function loadDataDir(dir, log = QUIET) {
  const out = {};
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  } catch (e) {
    log.warn?.(`[host] cannot read ${dir}: ${e.code || e.message} — hosting without game data`);
  }
  for (const file of names) {
    try { out[file.slice(0, -'.json'.length)] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
    catch (e) { log.error?.(`[host] skipping ${file}: ${e.message}`); }
  }
  return out;
}

/** LAN IPv4 addresses of this machine (for the "share this address" line). */
export function lanAddresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (ni && ni.family === 'IPv4' && !ni.internal && ni.address) out.push(ni.address);
    }
  }
  return out;
}

/**
 * Start the host server. `root` is the payload directory (resources/www).
 * @param {{ root: string, host?: string, port?: number, log?: object }} opts
 * @returns {Promise<{ url: string, port: number, host: string, addresses: string[], close: () => Promise<void> }>}
 */
export async function startHost({ root, host = '0.0.0.0', port = HOST_PORT, log = console } = {}) {
  const rootAbs = path.resolve(root);
  const logger = toLogger(log);

  // The server modules read game data through their generated ../data.js; inject the on-disk data first.
  globalThis.__SP_DATA__ = loadDataDir(path.join(rootAbs, 'data'), logger);

  // Import the payload's server modules by absolute file URL (relative to this repo, not the payload).
  const toUrl = (rel) => pathToFileURL(path.join(rootAbs, rel)).href;
  const [{ Network, SessionRegistry }, { Lobby }, constants] = await Promise.all([
    import(toUrl('server/net.js')),
    import(toUrl('server/lobby.js')),
    import(toUrl('shared/constants.js')),
  ]);

  const data = globalThis.__SP_DATA__;
  const registry = new SessionRegistry({});
  const lobby = new Lobby({ registry, log: logger, getData: () => data });
  const network = new Network({ registry, handler: lobby, log: logger });

  const healthz = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      // The picker probes a host over a different origin (the page is on 127.0.0.1:47821): allow it to read status.
      'Access-Control-Allow-Origin': '*',
    });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({
      ok: true, version: constants.PROTOCOL_VERSION, app: constants.APP_VERSION,
      sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
    }));
  };

  // Serve the whole payload over the same port as the WebSocket, so a LAN peer can just open http://<host>:<port>
  // in any browser and play (no client install, no separate static host). The page then reaches this server
  // same-origin; `lanRuntimeConfig()` points it at its own origin instead of the baked-in default server.
  const serveStatic = createRequestHandler({ root: rootAbs, log });

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const pathname = (() => { try { return new URL(req.url || '/', 'http://x').pathname; } catch { return '/'; } })();
    if (pathname === '/healthz') { healthz(req, res); return; }
    if (pathname === '/js/runtime-config.js') {
      // A LAN guest must talk to *this* host, not to whatever server the payload was built for (the client shell).
      const body = Buffer.from(lanRuntimeConfig());
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    serveStatic(req, res).catch((e) => {
      logger.error('[host] request failed', req.url, e);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end();
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false, clientTracking: false });
  wss.on('connection', (ws, req) => network.handleConnection(ws, req));
  wss.on('error', (e) => logger.error('[host] ws error', e));
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    let pathname = '';
    try { pathname = new URL(req.url || '/', 'http://x').pathname; } catch { /* ignore */ }
    if (pathname !== '/ws') { try { socket.destroy(); } catch { /* ignore */ } return; }
    try { wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)); }
    catch (e) { logger.error('[host] upgrade failed', e); try { socket.destroy(); } catch { /* ignore */ } }
  });

  const close = () => new Promise((done) => {
    try { network.close(); } catch { /* ignore */ }
    try { wss.close(); } catch { /* ignore */ }
    server.close(() => done());
    server.closeAllConnections?.();
  });

  // A requested port (`> 0`) is preferred, then the next ones, then an OS-assigned one; `0` means "let the OS pick".
  const candidates = port > 0
    ? [...Array.from({ length: PORT_SEARCH }, (_, i) => port + i).filter((p) => p <= 65535), 0]
    : [0];
  let lastErr = null;
  for (const p of candidates) {
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.off('listening', onOk); reject(e); };
        const onOk = () => { server.off('error', onErr); resolve(); };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(p, host);
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (e?.code !== 'EADDRINUSE') throw e;
      if (p !== 0) logger.warn(`[host] port ${p} in use — trying ${p + 1}`);
    }
  }
  if (lastErr) throw lastErr;

  const actualPort = server.address().port;
  const addresses = lanAddresses();
  logger.info(`[host] LAN server on ${host}:${actualPort}${addresses.length ? ` (${addresses.join(', ')})` : ''}`);
  return { url: `http://127.0.0.1:${actualPort}`, port: actualPort, host, addresses, close };
}
