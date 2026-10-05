// Tests for the "open to LAN" host server (desktop/host-server.mjs).
//
// Pure helpers always run. The round-trip test needs a game checkout (the real server modules) and the `ws`
// package (installed in desktop/node_modules); it skips itself when either is missing, like the other checkout
// tests. It assembles a *minimal* payload (no 260 MB of assets) from the checkout so startHost() can import the
// real server/net.js + lobby.js and answer a real WebSocket `hello` → `welcome`.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findGameRoot, SERVER_PRIVATE } from '../tools/game-contract.mjs';
import { OFFLINE_FILES, dataFileNames, serverDataSource } from '../tools/package-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS_CJS = path.join(ROOT, 'desktop', 'node_modules', 'ws', 'index.js');
const HAVE_WS = fs.existsSync(WS_CJS);

const GAME_ROOT = (() => {
  try { return findGameRoot({ clientRoot: ROOT }); } catch { return null; }
})();

describe('host server helpers', () => {
  test('loadDataDir reads each *.json into a basename key', async (t) => {
    if (!HAVE_WS) return t.skip('ws not installed (desktop/node_modules)');
    const { loadDataDir } = await import('../desktop/host-server.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-data-'));
    try {
      fs.writeFileSync(path.join(dir, 'config.json'), '{"a":1}');
      fs.writeFileSync(path.join(dir, 'chess.json'), '{"b":2}');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
      const data = loadDataDir(dir, { warn() {}, error() {} });
      assert.deepEqual(Object.keys(data).sort(), ['chess', 'config']);
      assert.equal(data.chess.b, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('lanAddresses lists non-internal IPv4 addresses only, private ranges first', async (t) => {
    if (!HAVE_WS) return t.skip('ws not installed (desktop/node_modules)');
    const { lanAddresses } = await import('../desktop/host-server.mjs');
    assert.deepEqual(lanAddresses({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] }), []);
    assert.deepEqual(
      lanAddresses({ eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }, { family: 'IPv6', internal: false, address: 'fe80::1' }] }),
      ['192.168.1.5'],
    );
    // A machine has several addresses (Wi-Fi, cellular, VPN) and the picker shows the first: a carrier address there
    // would be useless to the other players, so the LAN ranges come first while the rest keeps its order.
    assert.deepEqual(
      lanAddresses({
        rmnet: [{ family: 'IPv4', internal: false, address: '10.23.78.141' }],
        tun0: [{ family: 'IPv4', internal: false, address: '100.101.102.103' }],
        wlan0: [{ family: 'IPv4', internal: false, address: '192.168.43.7' }],
        eth1: [{ family: 'IPv4', internal: false, address: '203.0.113.9' }],
      }),
      ['192.168.43.7', '10.23.78.141', '100.101.102.103', '203.0.113.9'],
    );
  });

  test('toLogger accepts a plain function (the Electron shell passes one)', async (t) => {
    if (!HAVE_WS) return t.skip('ws not installed (desktop/node_modules)');
    const { toLogger } = await import('../desktop/host-server.mjs');
    // the game's Network/Lobby call log.info/warn/error; a bare `log(...)` function would make those throw
    const seen = [];
    const logger = toLogger((...a) => seen.push(a.join(' ')));
    for (const level of ['info', 'warn', 'error', 'debug']) assert.equal(typeof logger[level], 'function', `${level} must exist`);
    logger.error('boom');
    assert.match(seen[0], /boom/);
    // an object logger passes through unchanged
    const obj = { info() {}, warn() {}, error() {}, debug() {} };
    assert.equal(toLogger(obj), obj);
  });
});

describe('host server round-trip', { skip: (HAVE_WS && GAME_ROOT) ? false : 'needs a game checkout and ws' }, () => {
  let root; // minimal payload directory
  let host = null;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-host-'));
    // server/**/*.js minus the Node-only / replaced files, at the same relative paths the payload uses
    const copyServer = (rel) => {
      for (const e of fs.readdirSync(path.join(GAME_ROOT, 'server', rel), { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { copyServer(childRel); continue; }
        if (!e.name.endsWith('.js') || SERVER_PRIVATE.includes(childRel.toLowerCase())) continue;
        const dst = path.join(root, 'server', childRel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(GAME_ROOT, 'server', childRel), dst);
      }
    };
    copyServer('');
    fs.writeFileSync(path.join(root, 'server', 'data.js'), serverDataSource(dataFileNames(GAME_ROOT)));
    fs.cpSync(path.join(GAME_ROOT, 'shared'), path.join(root, 'shared'), { recursive: true });
    const dp = OFFLINE_FILES.find(([name]) => name === 'data-provider.js');
    const dst = path.join(root, dp[1]);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'offline', dp[0]), dst);
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    for (const f of fs.readdirSync(path.join(GAME_ROOT, 'data'))) {
      if (f.endsWith('.json')) fs.copyFileSync(path.join(GAME_ROOT, 'data', f), path.join(root, 'data', f));
    }
    // a stand-in for the payload's index.html: proves the host serves the game statically to LAN browsers
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>lan-home</title>');
    fs.mkdirSync(path.join(root, 'js'), { recursive: true });
    fs.writeFileSync(path.join(root, 'js', 'runtime-config.js'), 'globalThis.__SP_SERVER__ = "localhost:3000";\n');
  });

  after(async () => {
    if (host) { await host.close().catch(() => {}); host = null; }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test('answers /healthz and completes a WebSocket hello → welcome', async () => {
    const { startHost } = await import('../desktop/host-server.mjs');
    const wsPkg = await import(pathToFileURL(WS_CJS).href);
    const WebSocket = (wsPkg.default || wsPkg).WebSocket;

    host = await startHost({ root, host: '127.0.0.1', port: 0, log: { info() {}, warn() {}, error() {}, debug() {} } });
    assert.ok(host.port > 0, 'a real port is chosen');

    const health = await fetch(`http://127.0.0.1:${host.port}/healthz`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(typeof health.version, 'number', 'protocol version comes from the payload constants');

    // A browser on the LAN gets the game itself (static), and a runtime-config that points it at this host.
    const home = await fetch(`http://127.0.0.1:${host.port}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<title>lan-home<\/title>/);
    const rc = await fetch(`http://127.0.0.1:${host.port}/js/runtime-config.js`).then((r) => r.text());
    assert.match(rc, /__SP_SERVER__ = ''/, 'a guest uses its own origin, not the baked-in server');
    assert.match(rc, /__SP_LAN_CLIENT__ = true/, 'and the picker is told to skip its menu');

    const welcome = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws`);
      const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('no welcome')); }, 5000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'host-test', version: health.version, rid: 1 })));
      ws.on('message', (d) => {
        const msg = JSON.parse(String(d));
        if (msg.t === 'welcome') { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } resolve(msg); }
      });
      ws.on('error', reject);
    });
    assert.equal(welcome.t, 'welcome');
    assert.equal(welcome.name, 'host-test');
    assert.equal(typeof welcome.playerId, 'string');
  });

  test('room.create replies even when the shell logs through a plain function', async () => {
    // Regression: main.mjs passes `log(...)` (a function), not a logger object. Network/Lobby call this.log.info/error,
    // so a bare function made every room.create/room.join throw inside the frame handler and the reply never came
    // (the client hung and retried — "创建同盟很卡/失败"). The lobby logs "[lobby] … created" on this path.
    const { startHost } = await import('../desktop/host-server.mjs');
    const wsPkg = await import(pathToFileURL(WS_CJS).href);
    const WebSocket = (wsPkg.default || wsPkg).WebSocket;
    const logs = [];
    const host2 = await startHost({ root, host: '127.0.0.1', port: 0, log: (...a) => logs.push(a.join(' ')) });
    try {
      const reply = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${host2.port}/ws`);
        const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('no reply')); }, 5000);
        ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'fn-log', version: 1, rid: 1 })));
        ws.on('message', (d) => {
          const m = JSON.parse(String(d));
          if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 2 }));
          if (m.rid === 2) { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } resolve(m); }
        });
        ws.on('error', reject);
      });
      assert.equal(reply.t, 'ok', 'room.create must be answered');
      assert.ok(logs.some((l) => /created/.test(l)), 'the lobby logged through the function');
    } finally {
      await host2.close().catch(() => {});
    }
  });

  // The picker's port field: 0 = 自动 (OS), a number = exactly that port. A busy port is reported, never worked
  // around, because a player who types one may need it for port forwarding.
  test('a chosen port is used exactly, and a busy one is an error instead of a silent shift', async () => {
    const { startHost } = await import('../desktop/host-server.mjs');
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };

    // Find a free port by asking the OS, then close it so we can ask for it by number.
    const scout = await startHost({ root, host: '127.0.0.1', port: 0, log: quiet });
    const wanted = scout.port;
    await scout.close();

    const exact = await startHost({ root, host: '127.0.0.1', port: wanted, strict: true, log: quiet });
    assert.equal(exact.port, wanted, 'the requested port is the port we got');
    try {
      // While it is taken, the same request must fail loudly (and not move to another port)...
      await assert.rejects(
        () => startHost({ root, host: '127.0.0.1', port: wanted, strict: true, log: quiet }),
        (e) => e.code === 'EADDRINUSE',
        'a busy port must reject with EADDRINUSE',
      );
      // ...while the internal (non-strict) path still searches for the next free one, so nothing else changed.
      const searching = await startHost({ root, host: '127.0.0.1', port: wanted, log: quiet });
      assert.notEqual(searching.port, wanted, 'the non-strict path moves on to a free port');
      assert.ok(searching.port > 0);
      await searching.close();
    } finally {
      await exact.close();
    }

    // The exact port is free again after close (no leaked listener), and the first request takes it back.
    const again = await startHost({ root, host: '127.0.0.1', port: wanted, strict: true, log: quiet });
    assert.equal(again.port, wanted);
    await again.close();
  });

  test('port 0 means "let the OS pick" on either path', async () => {
    const { startHost } = await import('../desktop/host-server.mjs');
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    for (const strict of [false, true]) {
      const h = await startHost({ root, host: '127.0.0.1', port: 0, strict, log: quiet });
      assert.ok(h.port > 0, `strict=${strict} still binds a real port`);
      await h.close();
    }
  });
});
