// Phone-side LAN host: gives an Android build the same 「创建服务器 · 对局域网开放」 entry the desktop shell has.
//
// The transport is native (HostServerPlugin → MiniHostServer.java): one port on the phone serving the payload
// statically *and* the game's WebSocket, so a peer on the same network can just open http://<phone-ip>:47822 — no
// client install, no server machine. The game logic itself stays here in the WebView (the same server modules the
// offline single-player boot runs, via /offline/game-server.js) and the plugin ferries frames between the two: the
// phone's own client and every guest end up as ordinary sockets on one Network instance.
//
// Exposes globalThis.__SP_HOST__ = { start, stop, status }, the shape desktop/preload.cjs provides, so
// shell/picker.js shows its 创建服务器 screen unchanged. A no-op where the plugin is absent (web / Electron).
//
// This file is loaded as a CLASSIC script (see patches/game-client.patch), NOT as a module, and it must stay free of
// static `import`. Module scripts are deferred, and — measured on a real WebView — an earlier module whose
// dependency graph is still loading does not hold back the ones after it: /js/shell/picker.js executed ~140 ms
// before this file, read `__SP_HOST__` as undefined and rendered no 创建服务器 entry. A classic script runs while the
// document is parsed, before every module script — the guarantee the desktop preload has. Its game server modules are
// therefore imported on demand, when someone actually opens the port (which also keeps the boot light: nobody pays
// for server/net.js + lobby.js unless they host).

(() => {
  const plugin = globalThis.Capacitor?.Plugins?.HostServer;
  // No plugin → the web build has no host entry; Electron's preload provides the bridge instead.
  if (!plugin) return;

  /** Game server modules, loaded on demand: the in-page engine and the bridged socket it runs on. */
  const load = () => Promise.all([import('/offline/game-server.js'), import('/offline/loopback.js')]);

  /** The in-page game server: built once, kept across host sessions (idle connections cost nothing). */
  let server = null;
  let log = { info() {}, warn() {}, error() {}, debug() {} };
  /** Native connection id → bridged socket. */
  const sockets = new Map();
  /**
   * Frames of connections whose socket is still being set up. Loading the engine takes a few ticks and a client
   * sends its `hello` the moment its handshake completes, so those first frames must be held, not dropped.
   */
  const early = new Map();

  /** Build the game server before the port opens, so the first guest is never answered by half a server. */
  const ready = () => {
    if (!server) {
      server = load()
        .then(async ([gameServer]) => {
          log = gameServer.makeLog('[host]');
          return gameServer.startGameServer({ log });
        })
        .catch((e) => {
          server = null;
          throw e;
        });
    }
    return server;
  };

  const transport = {
    send(id, data) {
      Promise.resolve(plugin.send({ id, data })).catch((e) => {
        // The socket is gone (the guest closed the tab): tell the game so the session is cleaned up.
        log.warn(`send to ${id} failed`, e?.message || e);
        sockets.get(id)?.receiveClose();
      });
    },
    ping(id) {
      Promise.resolve(plugin.ping({ id })).catch(() => sockets.get(id)?.receiveClose());
    },
    close(id, code, reason) {
      Promise.resolve(plugin.closeConn({ id, code, reason })).catch(() => {});
    },
  };

  plugin.addListener('open', ({ id, peer }) => {
    const held = [];
    early.set(id, held);
    load()
      .then(async ([, loopback]) => {
        const sock = loopback.createRemoteServerSocket(id, transport);
        early.delete(id);
        // Whatever the guest already sent is handed to the socket before the game sees it: RemoteServerSocket holds
        // frames until adopt(), so Order is preserved (hello first) and nothing is dropped.
        for (const data of held) sock.receive(data);
        sockets.set(id, sock);
        const srv = await ready();
        srv.network.handleConnection(sock, { socket: { remoteAddress: peer || '127.0.0.1' }, headers: {} });
        sock.adopt();
      })
      .catch((e) => {
        early.delete(id);
        log.error('cannot accept connection', e);
        sockets.delete(id);
        transport.close(id, 1011, 'server unavailable');
      });
  });
  plugin.addListener('frame', ({ id, data }) => {
    const held = early.get(id);
    if (held) held.push(data);
    else sockets.get(id)?.receive(data);
  });
  plugin.addListener('pong', ({ id }) => sockets.get(id)?.receivePong());
  plugin.addListener('close', ({ id }) => {
    early.delete(id);
    const sock = sockets.get(id);
    sockets.delete(id);
    sock?.receiveClose();
  });

  // The game engine lives in this page, so when the page goes away (the reload after 进入本地服务器, or the app
  // closing) the guests it was serving would keep talking to nothing. Disconnect them: the port itself stays open,
  // and a guest's client sees a normal drop it can retry instead of a silent hang.
  globalThis.addEventListener?.('pagehide', () => {
    Promise.resolve(plugin.closeAll()).catch(() => {});
  });

  const toState = (res) => ({
    active: !!res?.active,
    port: typeof res?.port === 'number' ? res.port : null,
    addresses: Array.isArray(res?.addresses) ? res.addresses : [],
    url: typeof res?.url === 'string' ? res.url : null,
    // A port the player asked for that the phone could not take (busy): shown as a hint, not an exception.
    ...(typeof res?.error === 'string' ? { error: res.error } : {}),
  });

  globalThis.__SP_HOST__ = {
    /** @param {number} [port] 0/omitted = let the OS pick; otherwise that exact port (a busy one is reported) */
    async start(port) {
      await ready();
      return toState(await plugin.start({ port: Number.isInteger(port) && port >= 0 ? port : 0 }));
    },
    async stop() {
      // End the sessions before the port closes, so the game sees a clean disconnect rather than dead sockets.
      early.clear();
      for (const sock of sockets.values()) sock.receiveClose();
      sockets.clear();
      return toState(await plugin.stop());
    },
    async status() {
      return toState(await plugin.status());
    },
  };})();
