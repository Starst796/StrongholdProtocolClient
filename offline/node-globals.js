// Node globals for the in-page game server: `process` and the timer globals a browser does not have.
//
// The payload runs the game's *server* modules in the page (single-player and the phone-side LAN host), and 0.2.3+
// started using Node globals in code those modules import:
//
//   server/match/botEmotes.js   export const BOT_EMOTES_ON = process.env.SP_BOT_EMOTES !== '0';
//   server/lobby.js             setImmediate(() => this.disposeMatchCtx(ctx));
//
// Neither exists in a browser or a WebView, and both are evaluated *while the module graph is imported* (or when a
// match is disposed), so the first one killed the whole offline boot: /offline/bootstrap.js statically imports
// /offline/game-server.js, the ReferenceError aborted that import chain, the in-page server never started, the
// WebSocket was never redirected, and the client dialled the real `ws://localhost:3000` — "连接中断，正在重连".
//
// This file restores the smallest surface those modules need. It is a CLASSIC script (loaded by the patched
// index.html before any module script), because a module would be deferred: by the time it ran, bootstrap.js'
// static imports would already have thrown. Same reasoning as /offline/host-mobile.js.
//
// It never overwrites a real implementation (the Electron main process and Node hosts keep their own `process`), and
// `versions` is deliberately empty: server/sim/simdata.js decides `IS_NODE` from `process.versions.node`, so the sim
// must keep seeing a browser.
//
// Anything *not* provided here (Buffer, require, __dirname, …) is caught at packaging time by
// tools/node-globals.mjs — the payload must never ship a module that would throw on load. Add a shim there only
// after checking what the game actually does with it.

(() => {
  const g = globalThis;

  if (typeof g.process === 'undefined') {
    /** Environment overrides a packaged client may want to honour (`SP_BOT_EMOTES`, …) are read from localStorage. */
    const env = {};
    try {
      const raw = g.localStorage?.getItem('sp.env');
      if (raw) Object.assign(env, JSON.parse(raw));
    } catch { /* no storage: an empty environment is fine */ }

    const nextTick = (fn, ...args) => {
      // queueMicrotask is the closest thing to nextTick; fall back to a macrotask on very old engines.
      if (typeof g.queueMicrotask === 'function') g.queueMicrotask(() => fn(...args));
      else setTimeout(() => fn(...args), 0);
    };

    g.process = {
      env,
      argv: [],
      platform: 'browser',
      arch: 'javascript',
      pid: 0,
      execPath: '',
      versions: {},            // empty on purpose: simdata.js's IS_NODE must stay false
      exitCode: 0,
      nextTick,
      cwd: () => '/',
      // The offline server never registers signal handlers, but a stray call must not be fatal.
      on: () => g.process,
      once: () => g.process,
      off: () => g.process,
      removeListener: () => g.process,
      emit: () => false,
      exit: () => {},
      hrtime: Object.assign((prev) => {
        const ms = (g.performance?.now?.() ?? Date.now());
        const sec = Math.floor(ms / 1000);
        const ns = Math.floor((ms % 1000) * 1e6);
        const out = [sec, ns];
        if (prev) { out[0] -= prev[0]; out[1] -= prev[1]; if (out[1] < 0) { out[0] -= 1; out[1] += 1e9; } }
        return out;
      }, { bigint: () => BigInt(Math.floor((g.performance?.now?.() ?? Date.now()) * 1e6)) }),
    };
  }

  if (typeof g.setImmediate !== 'function') {
    g.setImmediate = (fn, ...args) => setTimeout(() => fn(...args), 0);
    g.clearImmediate = (id) => clearTimeout(id);
  }
})();
