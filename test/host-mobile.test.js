// Tests for the phone-side LAN host bridge: offline/host-mobile.js' transport adapter (the bridged socket in
// offline/loopback.js) driven by a stand-in for the Android plugin (HostServerPlugin.java).
//
// The interesting half of the Android host is pure JS: a native socket arrives as a plugin event, becomes a socket
// the game's own server modules can adopt, and the lobby's replies go back out through the plugin. That whole path
// runs here against the real server/net.js + lobby.js of a minimal payload assembled from the checkout (the same
// trick test/host.test.js uses) — only the Capacitor plumbing itself needs a device.
//
// How the pieces line up on the phone:
//   browser guest ──ws──> MiniHostServer.java ──plugin "frame"──> host-mobile.js ──> RemoteServerSocket
//                    <──plugin send()──────<── server/net.js' Network ──<── lobby.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import module from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findGameRoot, SERVER_PRIVATE } from '../tools/game-contract.mjs';
import { OFFLINE_FILES, dataFileNames, serverDataSource } from '../tools/package-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME_ROOT = (() => {
  try { return findGameRoot({ clientRoot: ROOT }); } catch { return null; }
})();

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('bridged socket (phone host transport)', () => {
  test('speaks the surface server/net.js drives', async () => {
    const { createRemoteServerSocket } = await import('../offline/loopback.js');
    const sock = createRemoteServerSocket(1, { send() {}, ping() {}, close() {} });
    assert.equal(sock.readyState, 1, 'readyState must be OPEN (WS_OPEN) or the game drops every frame');
    assert.equal(typeof sock.bufferedAmount, 'number');
    for (const fn of ['on', 'off', 'send', 'close', 'terminate', 'ping']) assert.equal(typeof sock[fn], 'function', `${fn}() missing`);
  });

  test('hands frames to the transport and reports the native close once', async () => {
    const { createRemoteServerSocket } = await import('../offline/loopback.js');
    const sent = [];
    const closed = [];
    const sock = createRemoteServerSocket(9, {
      send: (id, data) => sent.push([id, data]),
      ping: () => {},
      close: (id, code, reason) => closed.push([id, code, reason]),
    });
    sock.adopt();

    let closeEvents = 0;
    sock.on('close', () => closeEvents++);
    sock.send('{"t":"ping","c":1}');
    assert.deepEqual(sent, [[9, '{"t":"ping","c":1}']], 'the frame is addressed by the native socket id');

    sock.close(1000, 'bye');
    assert.deepEqual(closed, [[9, 1000, 'bye']]);
    assert.equal(closeEvents, 1);
    assert.equal(sock.readyState, 3, 'a closed socket is CLOSED');

    // idempotent: a later native close (the plugin reports it too) must not re-announce or re-send
    sock.receiveClose();
    sock.close();
    assert.equal(closeEvents, 1);
    assert.equal(closed.length, 1);

    // and nothing goes out on a closed socket
    let err = null;
    sock.send('{"t":"ping","c":2}', (e) => { err = e; });
    assert.ok(err, 'send() on a closed socket reports the error through its callback');
    assert.equal(sent.length, 1);
  });

  test('a peer that vanishes does not throw into the transport', async () => {
    const { createRemoteServerSocket } = await import('../offline/loopback.js');
    const sock = createRemoteServerSocket(3, {
      send: () => { throw new Error('bridge gone'); },
      ping: () => { throw new Error('bridge gone'); },
      close: () => { throw new Error('bridge gone'); },
    });
    sock.adopt();
    let err = null;
    sock.send('x', (e) => { err = e; });
    assert.match(err.message, /bridge gone/);
    sock.ping(); // must not propagate: Network's heartbeat runs on a timer
    sock.close(); // must not propagate either
    assert.equal(sock.readyState, 3);
  });

  test('frames that arrive before the game adopts the socket are held, not dropped', async () => {
    const { createRemoteServerSocket } = await import('../offline/loopback.js');
    const sock = createRemoteServerSocket(4, { send() {}, ping() {}, close() {} });
    const seen = [];
    sock.receive('early-1');
    sock.receive('early-2');
    sock.on('message', (data) => seen.push(data));
    assert.deepEqual(seen, [], 'nothing is emitted before the listener exists');
    sock.adopt();
    assert.deepEqual(seen, ['early-1', 'early-2'], 'held frames are released in order on adopt()');
    sock.receive('later');
    assert.deepEqual(seen, ['early-1', 'early-2', 'later']);
    assert.deepEqual(sock.adopt(), undefined);

    // frames after a native close are ignored, like a real socket
    sock.receiveClose();
    sock.receive('after-close');
    assert.deepEqual(seen, ['early-1', 'early-2', 'later']);
  });
});

describe('phone host round-trip', { skip: GAME_ROOT ? false : 'needs a game checkout' }, () => {
  let root; // minimal payload directory
  let server; // { registry, lobby, network }

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mobile-host-'));
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
    const dpDst = path.join(root, dp[1]);
    fs.mkdirSync(path.dirname(dpDst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'offline', dp[0]), dpDst);
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    for (const f of fs.readdirSync(path.join(GAME_ROOT, 'data'))) {
      if (f.endsWith('.json')) fs.copyFileSync(path.join(GAME_ROOT, 'data', f), path.join(root, 'data', f));
    }

    // The phone's WebView reads /data/*.json with fetch(); the Node stand-in injects what the same files hold.
    const data = {};
    for (const f of fs.readdirSync(path.join(GAME_ROOT, 'data'))) {
      if (f.endsWith('.json')) data[f.slice(0, -'.json'.length)] = JSON.parse(fs.readFileSync(path.join(GAME_ROOT, 'data', f), 'utf8'));
    }
    globalThis.__SP_DATA__ = data;

    const url = (rel) => pathToFileURL(path.join(root, rel)).href;
    const [{ Network, SessionRegistry }, { Lobby }, { loadData }] = await Promise.all([
      import(url('server/net.js')), import(url('server/lobby.js')), import(url('server/data.js')),
    ]);
    const loaded = await loadData();
    const registry = new SessionRegistry({});
    const lobby = new Lobby({ registry, log: QUIET, getData: () => loaded });
    server = { registry, lobby, network: new Network({ registry, handler: lobby, log: QUIET }) };
  });

  after(() => {
    try { server?.network.close(); } catch { /* ignore */ }
    if (root) fs.rmSync(root, { recursive: true, force: true });
    delete globalThis.__SP_DATA__;
  });

  /** A fake plugin: an id, the frames the "guest" sent, and every frame the game sends back. */
  function fakePlugin() {
    let nextId = 1;
    const listeners = new Map();
    const sent = [];
    const pings = [];
    const closed = [];
    const sockets = new Map(); // id → bridged socket (what host-mobile.js keeps)
    const plugin = {
      sent,
      pings,
      closed,
      sockets,
      addListener(event, fn) {
        listeners.set(event, fn);
        return Promise.resolve();
      },
      emit(event, data) { listeners.get(event)?.(data); },
      send: ({ id, data }) => { sent.push(JSON.parse(data)); return Promise.resolve({ ok: true }); },
      ping: ({ id }) => { pings.push(id); return Promise.resolve({ ok: true }); },
      closeConn: ({ id, code, reason }) => { closed.push([id, code, reason]); return Promise.resolve({ ok: true }); },
      start: () => Promise.resolve({ active: true, port: 47822, addresses: ['192.168.1.7'], url: 'http://127.0.0.1:47822' }),
      stop: () => Promise.resolve({ active: false, port: null, addresses: [], url: null }),
      status: () => Promise.resolve({ active: true, port: 47822, addresses: ['192.168.1.7'], url: 'http://127.0.0.1:47822' }),
    };
    return plugin;
  }

  /** Wire one guest the way offline/host-mobile.js does, and return the socket the game adopted. */
  async function connectGuest(plugin, id, peer) {
    const { createRemoteServerSocket } = await import('../offline/loopback.js');
    const sock = createRemoteServerSocket(id, {
      send: (to, data) => plugin.send({ id: to, data }),
      ping: (to) => plugin.ping({ id: to }),
      close: (to, code, reason) => plugin.closeConn({ id: to, code, reason }),
    });
    plugin.sockets.set(id, sock);
    server.network.handleConnection(sock, { socket: { remoteAddress: peer }, headers: {} });
    sock.adopt();
    return sock;
  }

  test('a guest that says hello gets a welcome through the plugin', async () => {
    const plugin = fakePlugin();
    const sock = await connectGuest(plugin, 1, '192.168.1.9');

    // A guest sends its hello the instant the handshake completes — the host's own phone would too.
    sock.receive(JSON.stringify({ t: 'hello', name: 'remote-guest', version: 1, rid: 1 }));
    await tick();

    const welcome = plugin.sent.find((m) => m.t === 'welcome');
    assert.ok(welcome, `expected a welcome, got ${JSON.stringify(plugin.sent)}`);
    assert.equal(welcome.name, 'remote-guest');
    assert.equal(typeof welcome.playerId, 'string', 'the lobby minted a session for the remote socket');

    // room.create must be answered too (the desktop regression: a logger that threw left the client hanging)
    sock.receive(JSON.stringify({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 2 }));
    await tick();
    assert.ok(plugin.sent.some((m) => m.rid === 2 && m.t === 'ok'), 'room.create is answered over the bridge');
  });

  test('two guests share one lobby: the second joins the room the first created', async () => {
    const plugin = fakePlugin();
    const guestA = await connectGuest(plugin, 11, '192.168.1.9');
    guestA.receive(JSON.stringify({ t: 'hello', name: 'guest-a', version: 1, rid: 1 }));
    await tick();
    guestA.receive(JSON.stringify({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 2 }));
    await tick();

    const state = plugin.sent.filter((m) => m.t === 'room.state').pop();
    assert.ok(state?.code, `expected a room.state with a code, got ${JSON.stringify(plugin.sent)}`);

    const guestB = await connectGuest(plugin, 12, '192.168.1.10');
    guestB.receive(JSON.stringify({ t: 'hello', name: 'guest-b', version: 1, rid: 1 }));
    await tick();
    guestB.receive(JSON.stringify({ t: 'room.join', code: state.code, rid: 2 }));
    await tick();
    assert.ok(plugin.sent.some((m) => m.rid === 2 && m.t === 'ok'), 'the second guest joined the room');

    // and the room now holds both of them
    const latest = plugin.sent.filter((m) => m.t === 'room.state').pop();
    const seated = (latest.seats || []).filter((s) => s && (s.name === 'guest-a' || s.name === 'guest-b')).length;
    assert.equal(seated, 2, `both guests are seated: ${JSON.stringify(latest.seats)}`);

    // the heartbeat pings through the plugin, addressed by native socket id
    assert.ok(plugin.pings.every((id) => id === 11 || id === 12), `pings are addressed by id: ${plugin.pings}`);
  });

  test('the game dropping a session closes the native socket', async () => {
    const plugin = fakePlugin();
    const sock = await connectGuest(plugin, 21, '10.0.0.5');
    sock.receive(JSON.stringify({ t: 'hello', name: 'leaver', version: 1, rid: 1 }));
    await tick();

    // Network closes sockets it can no longer trust (flooding, replaced session, shutdown)
    sock.terminate();
    assert.equal(plugin.closed.length, 1, 'terminate() tells the native side to drop the socket');
    assert.equal(plugin.closed[0][0], 21);
    assert.equal(sock.readyState, 3);

    let err = null;
    sock.send('{"t":"ping","c":1}', (e) => { err = e; });
    assert.ok(err, 'no frames leave a terminated socket');
  });
});

describe('phone host files are in the payload', () => {
  test('offline/host-mobile.js is copied and loaded before the picker', () => {
    const rel = OFFLINE_FILES.find(([name]) => name === 'host-mobile.js');
    assert.ok(rel, 'host-mobile.js must be part of the offline layer');
    assert.equal(rel[1], 'offline/host-mobile.js');
    assert.ok(OFFLINE_FILES.some(([name, dest]) => name === 'game-server.js' && dest === 'offline/game-server.js'), 'game-server.js is shared with bootstrap.js');

    const src = fs.readFileSync(path.join(ROOT, 'offline', 'host-mobile.js'), 'utf8');
    assert.match(src, /globalThis\.Capacitor\?\.Plugins\?\.HostServer/, 'it must look for the native plugin');
    assert.match(src, /globalThis\.__SP_HOST__ = \{/, 'and expose the bridge the picker reads');
    assert.ok(/\bawait ready\(\)/.test(src), 'the game server must be built before the port opens');
    // Loaded as a classic script, so it may not use static imports (see the file's header for the measured race).
    assert.ok(!/^\s*import\s/m.test(src), 'host-mobile.js must not have static imports — it runs as a classic script');
    assert.match(src, /import\('\/offline\/game-server\.js'\)/, 'the engine is imported on demand instead');
    assert.match(src, /addEventListener\?\.\('pagehide'/, 'it must drop guests when the page (and so the engine) goes away');
  });
});

// The bridge itself, driven exactly as the page does it. Two things can only be seen here (they both broke on a real
// phone): the picker must find the bridge *before* its module runs (hence the classic script), and a guest's first
// frame arrives the instant its handshake completes — before the engine has even been imported.
describe('phone host bridge in the page', { skip: GAME_ROOT ? false : 'needs a game checkout' }, () => {
  let root;
  let bridge;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-bridge-'));
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
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const data = {};
    for (const f of fs.readdirSync(path.join(GAME_ROOT, 'data'))) {
      if (!f.endsWith('.json')) continue;
      fs.copyFileSync(path.join(GAME_ROOT, 'data', f), path.join(root, 'data', f));
      data[f.slice(0, -'.json'.length)] = JSON.parse(fs.readFileSync(path.join(GAME_ROOT, 'data', f), 'utf8'));
    }
    globalThis.__SP_DATA__ = data; // what the WebView's fetch('/data/*.json') yields
    // The offline layer as the payload ships it (the bridge imports its neighbours by payload path).
    fs.mkdirSync(path.join(root, 'offline'), { recursive: true });
    for (const [name, rel] of OFFLINE_FILES) fs.copyFileSync(path.join(ROOT, 'offline', name), path.join(root, rel));

    process.env.SP_PAYLOAD_ROOT = root;
    await import('./payload-loader.mjs'); // keep the hook file referenced before register()
    module.register(new URL('./payload-loader.mjs', import.meta.url), import.meta.url);
  });

  after(() => {
    delete globalThis.__SP_HOST__;
    delete globalThis.Capacitor;
    delete globalThis.__SP_DATA__;
    delete process.env.SP_PAYLOAD_ROOT;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test('a guest is answered even though its frames race the engine being loaded', async () => {
    const listeners = new Map();
    const sent = [];
    const closed = [];
    const started = [];
    const plugin = {
      addListener: (event, fn) => {
        listeners.set(event, fn);
        return Promise.resolve({ remove() {} });
      },
      send: ({ id, data }) => {
        sent.push(JSON.parse(data));
        return Promise.resolve({ ok: true });
      },
      ping: () => Promise.resolve({ ok: true }),
      closeConn: ({ id, code }) => {
        closed.push({ id, code });
        return Promise.resolve({ ok: true });
      },
      start: ({ port } = {}) => {
        started.push(port);
        return Promise.resolve({ active: true, port: port || 47822, addresses: ['192.168.1.7'], url: 'http://127.0.0.1:47822' });
      },
      stop: () => Promise.resolve({ active: false, port: null, addresses: [], url: null }),
      status: () => Promise.resolve({ active: true, port: 47822, addresses: ['192.168.1.7'], url: 'http://127.0.0.1:47822' }),
    };
    globalThis.Capacitor = { Plugins: { HostServer: plugin } };

    // Loaded the way the page does it: a classic script, not a module — and nothing else defines the bridge.
    const code = fs.readFileSync(path.join(ROOT, 'offline', 'host-mobile.js'), 'utf8');
    new Function(code)();
    assert.ok(globalThis.__SP_HOST__, 'the bridge must be defined synchronously, before any module script runs');
    assert.deepEqual(Object.keys(globalThis.__SP_HOST__), ['start', 'stop', 'status']);

    const state = await globalThis.__SP_HOST__.start();
    assert.equal(state.active, true);
    assert.deepEqual(started, [0], 'no port typed means "let the OS pick" (0)');

    // A typed port is passed straight through to the native side, which binds exactly it.
    await globalThis.__SP_HOST__.stop();
    const chosen = await globalThis.__SP_HOST__.start(25565);
    assert.equal(chosen.port, 25565);
    assert.deepEqual(started, [0, 25565]);

    // ...and a port the native side could not take comes back as a hint, not an exception.
    plugin.start = ({ port } = {}) => Promise.resolve({ active: false, port: null, addresses: [], url: null, error: `端口 ${port} 已被占用，请换一个端口再试。` });
    const busy = await globalThis.__SP_HOST__.start(25565);
    assert.equal(busy.active, false);
    assert.match(busy.error, /已被占用/);
    plugin.start = ({ port } = {}) => Promise.resolve({ active: true, port: port || 47822, addresses: ['192.168.1.7'], url: 'http://127.0.0.1:47822' });
    await globalThis.__SP_HOST__.start();

    // The guest connects and sends its hello in the same tick the native side reports the open — the engine still
    // has to be imported (load()), so the frame lands before any socket exists for it.
    listeners.get('open')({ id: 5, peer: '192.168.1.9' });
    listeners.get('frame')({ id: 5, data: JSON.stringify({ t: 'hello', name: 'racy-guest', version: 1, rid: 1 }) });
    await tick();
    await tick();
    await new Promise((r) => setTimeout(r, 50));

    const welcome = sent.find((m) => m.t === 'welcome');
    assert.ok(welcome, `the held frame must be replayed, got ${JSON.stringify(sent)}`);
    assert.equal(welcome.name, 'racy-guest');

    // and the session keeps working afterwards
    listeners.get('frame')({ id: 5, data: JSON.stringify({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 2 }) });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(sent.some((m) => m.rid === 2 && m.t === 'ok'), 'room.create is answered');

    // a guest that leaves is dropped, not remembered
    listeners.get('close')({ id: 5 });
    assert.ok(!closed.some((c) => c.id === 5), 'a normal close needs no native closeConn');

    // stopping disconnects the guests (the engine in the page is gone at that point)
    listeners.get('open')({ id: 6, peer: '192.168.1.10' });
    listeners.get('frame')({ id: 6, data: JSON.stringify({ t: 'hello', name: 'second', version: 1, rid: 1 }) });
    await new Promise((r) => setTimeout(r, 50));
    const stopped = await globalThis.__SP_HOST__.stop();
    assert.equal(stopped.active, false);
    assert.ok(sent.filter((m) => m.t === 'welcome').length >= 2, 'both guests had been welcomed');
  });
});