// In-memory WebSocket pair for the offline (single-player) mode, plus the bridged socket the phone-side LAN host
// (Android) runs on.
//
// The client end speaks the WebSocket API public/js/net.js uses (onopen/onmessage/onclose/send/close/readyState);
// the server end speaks the `ws` API server/net.js' Network uses (on/off/send/close/terminate/ping/readyState/
// bufferedAmount). Frames are JSON strings handed between the two ends, deferred to a microtask so a handler can
// never re-enter the sender (the same reason a real socket delivers asynchronously).

const OPEN = 1;
const CLOSED = 3;

/** Minimal evented endpoint shared by both ends (`on`/`off`/`_emit`). */
class Emitter {
  constructor() {
    /** @type {Map<string, Function[]>} */
    this._listeners = new Map();
    this.readyState = 0;
  }

  on(event, fn) {
    const list = this._listeners.get(event) || [];
    list.push(fn);
    this._listeners.set(event, list);
    return this;
  }

  off(event, fn) {
    const list = this._listeners.get(event);
    if (list) {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    }
    return this;
  }

  _emit(event, ...args) {
    for (const fn of this._listeners.get(event) || []) {
      try { fn(...args); } catch (e) { queueMicrotask(() => { throw e; }); }
    }
  }
}

/** The server-side socket: exactly the surface server/net.js uses. */
class ServerSocket extends Emitter {
  constructor() {
    super();
    this._peer = null;
    this.bufferedAmount = 0;
  }

  send(data, cb) {
    if (this.readyState !== OPEN) { if (cb) cb(new Error('not open')); return; }
    const peer = this._peer;
    queueMicrotask(() => peer._receive(String(data)));
    if (cb) cb();
  }

  close(code = 1000, reason = '') {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    const peer = this._peer;
    queueMicrotask(() => peer._remoteClose(code, reason));
    this._emit('close');
  }

  terminate() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    const peer = this._peer;
    queueMicrotask(() => peer._remoteClose(1006, ''));
    this._emit('close');
  }

  /** Network's heartbeat: answer with a pong on the next microtask (mirrors a live socket answering ping). */
  ping() {
    queueMicrotask(() => { if (this.readyState === OPEN) this._emit('pong'); });
  }
}

/** The client-side socket: the WebSocket API public/js/net.js uses. */
class ClientSocket extends Emitter {
  constructor() {
    super();
    this._peer = null;
    this.bufferedAmount = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }

  _receive(data) {
    if (this.readyState !== OPEN) return;
    try { this.onmessage?.({ type: 'message', data }); } catch (e) { queueMicrotask(() => { throw e; }); }
  }

  _remoteClose(code, reason) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    try { this.onclose?.({ type: 'close', code, reason, wasClean: code === 1000 || code === 1001 || code === 1005 }); } catch (e) { queueMicrotask(() => { throw e; }); }
  }

  /** Fire the open event once the server side is wired up. */
  open() {
    this.readyState = OPEN;
    this._peer.readyState = OPEN;
    queueMicrotask(() => { try { this.onopen?.({ type: 'open' }); } catch (e) { queueMicrotask(() => { throw e; }); } });
  }

  send(data) {
    if (this.readyState !== OPEN) throw new Error('OfflineWebSocket: socket is not open');
    const peer = this._peer;
    queueMicrotask(() => peer._emit('message', String(data), false));
  }

  close(code = 1000, reason = '') {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    const peer = this._peer;
    queueMicrotask(() => {
      if (peer.readyState !== CLOSED) {
        peer.readyState = CLOSED;
        peer._emit('close');
      }
    });
  }
}

/**
 * A connected pair: `server` is handed to Network.handleConnection, `client` is what the game client's Net drives.
 * Call `open()` after the server side is registered, to fire the client's `onopen`.
 */
export function createLoopbackPair() {
  const client = new ClientSocket();
  const server = new ServerSocket();
  client._peer = server;
  server._peer = client;
  return { client, server, open: () => client.open() };
}

/**
 * The server end of a socket that lives *outside* the page — the phone's LAN host, where the real TCP socket and the
 * WebSocket framing are native (HostServerPlugin / MiniHostServer.java) and arrive over the Capacitor bridge. It
 * presents the same surface as {@link ServerSocket} (so Network.handleConnection cannot tell the two apart) and
 * reports the native side's events back into it.
 *
 * Frames that arrive between the socket being created and `adopt()` being called are held back: the plugin's `open`
 * event reaches the page one task before the game's Network gets the socket, and a client sends its `hello` as soon
 * as its handshake completes.
 */
class RemoteServerSocket extends Emitter {
  /**
   * @param {number} id native connection id (the plugin addresses this socket by it)
   * @param {{ send: Function, ping: Function, close: Function }} transport native side
   */
  constructor(id, transport) {
    super();
    this.id = id;
    this.transport = transport;
    this.readyState = OPEN;
    this.bufferedAmount = 0;
    this._adopted = false;
    this._pending = [];
  }

  send(data, cb) {
    if (this.readyState !== OPEN) { if (cb) cb(new Error('not open')); return; }
    try {
      this.transport.send(this.id, String(data));
      if (cb) cb();
    } catch (e) {
      if (cb) cb(e);
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    try { this.transport.close(this.id, code, reason); } catch { /* the app is going away */ }
    this._emit('close');
  }

  terminate() {
    this.close(1006, '');
  }

  /** Network's heartbeat: the native side pings and answers with `receivePong()`. */
  ping() {
    try { this.transport.ping(this.id); } catch { /* the app is going away */ }
  }

  /** Called once Network.handleConnection has registered its listeners; releases held-back frames. */
  adopt() {
    if (this._adopted) return;
    this._adopted = true;
    const held = this._pending.splice(0);
    for (const data of held) this.receive(data);
  }

  /** A text frame from the native side. */
  receive(data) {
    if (this.readyState !== OPEN) return;
    if (!this._adopted) { this._pending.push(data); return; }
    this._emit('message', String(data), false);
  }

  /** The native side answered one of our pings. */
  receivePong() {
    if (this.readyState === OPEN) this._emit('pong');
  }

  /** The native socket ended (the peer left, or the host stopped) — idempotent, and never re-announced. */
  receiveClose() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this._emit('close');
  }
}

/**
 * @param {number} id native connection id
 * @param {{ send: Function, ping: Function, close: Function }} transport native side
 */
export function createRemoteServerSocket(id, transport) {
  return new RemoteServerSocket(id, transport);
}
