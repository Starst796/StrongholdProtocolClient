// Shell server picker — packaged clients only (never part of the game repo).
//
// Copied verbatim into the payload as /js/shell/picker.js (tools/package-client.mjs), so the relative imports below
// are payload paths: public/js/net.js is ../net.js, and the pure rules are ./picker-core.js.
//
// The payload's index.html loads this module *before* /js/main.js; ES module order guarantees it runs first, so it
// can set `globalThis.__SP_SERVER__` (read by public/js/net.js through resolveServerTarget) before the game opens
// its socket. The browser build has no such file and stays pinned to its own origin.
//
// Layout (Minecraft-like): a main page offers 单人游戏 / 创建服务器 / 加入服务器.
//   单人游戏 boots the in-page single-player server (offline/bootstrap.js): it writes `sp.shell.mode = 'solo'` and
//            reloads, and the offline layer runs the game's own lobby / match engine over an in-memory WebSocket.
//   创建服务器 (needs window.__SP_HOST__: the desktop preload or the Android native host's /offline/host-mobile.js)
//            opens the LAN server on this device — the client itself hosts, and LAN guests join it.
//   加入服务器 opens the server list, where the player can add a server (name + address), connect directly to a
//            typed address, or join a listed/remembered one.
//
// Behaviour
//   * a remembered choice in localStorage decides the server for the next launch;
//   * desktop shells skip the UI once something is remembered (reopen with F2 / --choose-server);
//   * Android always shows it — a phone has no F2 and this is the only way to switch servers there;
//   * probing opens a real /ws socket (the channel the game itself uses), so it needs no CORS headers, while a
//     best-effort /healthz fetch enriches the row whenever the server does allow it.

import { toHttpUrl, toWsUrl } from '../net.js';
// The game's own release + wire numbers, straight from the shared constants the payload ships next to the picker
// (this file is copied as /js/shell/picker.js, so ../../shared/constants.js is the payload's /shared/constants.js).
import { APP_VERSION, PROTOCOL_VERSION } from '../../shared/constants.js';
import {
  BUILTIN_SERVERS, FEED_TIMEOUT_MS, K_AUTOSTART, K_CHOSEN, K_HOST_PORT, K_LIST, K_MODE, K_SERVER, K_SKIP_UPDATE,
  NAME_MAX, HOST_PORT_DEFAULT,
  PROBE_HELLO, addressError, ambiguousScheme, autostartOn, cleanName, customFrom, hostPortError, hostPortValue,
  isAndroidUA, parseLatestFeed, parseProbeReply, serverName, shouldShowPicker, updateAsset, updateLabel,
  updatePlatform, updateVerdict, versionLabel, versionMismatchHint, versionVerdict,
} from './picker-core.js';

const PROBE_TIMEOUT_MS = 4000;
/** How long a reply to PROBE_HELLO (or /healthz) may take after the socket opens before the row settles without it. */
const PROBE_REPLY_TIMEOUT_MS = 1200;
const isAndroid = () => isAndroidUA(globalThis.navigator?.userAgent);

/**
 * The real WebSocket, captured at module load — *before* /offline/bootstrap.js runs (it is loaded later, see
 * index.html). In single-player that module replaces globalThis.WebSocket with the in-page loopback, whose socket
 * opens instantly and answers no matter what address it is given: probing through it would report every server as
 * "可连接 · 0ms" and 刷新 could never tell them apart. Reachability of a *remote* server must use a real socket.
 */
const NativeWebSocket = globalThis.WebSocket;

/**
 * The address the payload was built for (runtime-config.js), captured before a remembered choice overrides
 * `__SP_SERVER__` further down — otherwise that remembered address would be listed as the "默认" one.
 */
const PAYLOAD_SERVER = typeof globalThis.__SP_SERVER__ === 'string' ? globalThis.__SP_SERVER__.trim() : '';

/** localStorage/sessionStorage that never throws (disabled storage, private mode). */
function store(kind) {
  try {
    return globalThis[kind] || null;
  } catch {
    return null;
  }
}

function readItem(key, kind) {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeItem(key, value, kind) {
  try {
    if (value === null || value === undefined) store(kind)?.removeItem(key);
    else store(kind)?.setItem(key, value);
  } catch { /* ignore */ }
}

/** The address the payload was built for (runtime-config.js). */
function buildDefault() {
  return PAYLOAD_SERVER || BUILTIN_SERVERS[0].address;
}

/** Normalised socket URL of an address ('' → null). toWsUrl normalises rather than validates; addressError does that. */
const keyOf = (address) => (typeof address === 'string' && address.trim() ? toWsUrl(address) : null);

/** Escape interpolated text: /healthz comes from a remote server, so its fields are never trusted as markup. */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Custom entries the user added, newest first. */
function customServers() {
  return customFrom(readItem(K_LIST, 'localStorage'));
}

// ---- update check ----------------------------------------------------------------------------------------------
//
// A packaged client can be told that a newer build exists (docs/PACKAGING.md §10): the payload carries a feed URL
// (runtime-config.js, from client.config.json), the picker polls it once per page load and — when the published
// build number is higher than this build's (build.json) — offers to install it.
//
// Everything here is best-effort. Offline, a captive portal answering with HTML, a feed from a schema this client
// does not know: all of it ends as "no update information", never as an error screen or a blocked game.

/** `{ feed, platform }` when a newer build is offered, null otherwise. Memoised: F2 can reopen the picker. */
let updateLookup = null;

/** Text out of a shell's feed reply (`{ ok, text }`), or null when the shell reported a failure. */
function feedTextOf(reply) {
  if (typeof reply === 'string') return reply;
  if (!reply || reply.ok === false) return null;
  return typeof reply.text === 'string' ? reply.text : null;
}

/** This client's own build: /build.json, written by tools/package-client.mjs. */
async function localIdentity() {
  try {
    const res = await fetch('build.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const client = (await res.json())?.client ?? {};
    const build = Number(client.build);
    // A payload built before the build counter existed has no `client` block: that is build 0, i.e. older than
    // anything published — not "unknown", which would keep those installs from ever learning about an update.
    return {
      version: String(client.version ?? ''),
      build: Number.isFinite(build) ? build : 0,
      versionCode: Number(client.versionCode),
    };
  } catch {
    return null;
  }
}

/**
 * The feed, through whichever channel this shell has. It is not same-origin with the page, so a renderer-side fetch
 * would be refused by CORS: the desktop shell reads it in Electron's main process (preload `__SP_UPDATE__.check`)
 * and the phone reads it in its own plugin (Capacitor `AppUpdate.check`). Only the plain web build falls back to
 * fetch — where a CORS-less host refuses and the client simply learns nothing.
 */
async function readFeed(url) {
  try {
    const desktop = globalThis.__SP_UPDATE__;
    if (typeof desktop?.check === 'function') return parseLatestFeed(feedTextOf(await desktop.check(url)));
    const plugin = globalThis.Capacitor?.Plugins?.AppUpdate;
    if (typeof plugin?.check === 'function') return parseLatestFeed(feedTextOf(await plugin.check({ url })));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
      return res.ok ? parseLatestFeed(await res.text()) : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** Poll the feed (once per page load) and decide whether this client is behind. */
async function fetchUpdate() {
  const url = String(globalThis.__SP_UPDATE_FEED__ ?? '').trim();
  if (!url) return null; // no feed baked in: make no request at all
  const platform = updatePlatform(globalThis.navigator?.userAgent);
  const [local, feed] = await Promise.all([localIdentity(), readFeed(url)]);
  if (updateVerdict(local, feed) !== 'newer') return null;
  return { feed, platform };
}

const lookupUpdate = () => (updateLookup ??= fetchUpdate());

/** Every entry the picker lists, de-duplicated on the normalised socket URL. */
export function serverList() {
  const seen = new Set();
  const out = [];
  const entries = [
    ...BUILTIN_SERVERS,
    { address: buildDefault(), label: '默认服务器', note: '' },
    ...customServers().map((e) => ({ address: e.address, label: serverName(e), note: '' })),
  ];
  for (const s of entries) {
    const key = keyOf(s.address);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...s, key, http: toHttpUrl(s.address) });
  }
  return out;
}

/**
 * Socket URLs to try for a typed address, best guess first. A scheme-less `host:port` is the one case the player
 * cannot be expected to get right — a self-hosted server on a public IP wants plain `ws://`, a TLS reverse proxy
 * on an odd port wants `wss://` — so the second candidate is the other scheme.
 * @param {string} address
 * @returns {string[]}
 */
export function candidateWsUrls(address) {
  const raw = String(address ?? '').trim();
  if (!raw) return [];
  const first = toWsUrl(raw);
  if (!ambiguousScheme(raw)) return [first];
  const alt = first.startsWith('wss:') ? `ws:${first.slice(4)}` : `wss:${first.slice(3)}`;
  return [first, alt];
}

/** The web (http) URL of an already-normalised socket URL. */
const httpUrlOf = (wsUrl) => wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');

/** Is this page served by the desktop shell's loopback server (the origin that offers the /__sp/healthz proxy)? */
const isLoopbackOrigin = () => /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(String(globalThis.location?.origin ?? ''));

/**
 * Best-effort `/healthz` read for a picked server: its release/protocol numbers and live counters. It usually
 * cannot be read cross-origin (the game server sends no CORS headers), so the shells bridge it:
 *   * Android (Capacitor): `Capacitor.nativePromise` runs the request natively — no page origin, no CORS;
 *   * desktop: the loopback shell proxies it same-origin at /__sp/healthz (desktop/serve.mjs);
 *   * a CORS-enabled server, or the game's own origin, answers the plain fetch.
 * @param {string} httpBase web URL of the server (no trailing slash)
 * @returns {Promise<object|undefined>} the /healthz body when it really is this game's, else undefined
 */
async function fetchHealthzInfo(httpBase) {
  const url = `${httpBase}/healthz`;
  const cap = globalThis.Capacitor;
  if (cap && typeof cap.nativePromise === 'function') {
    try {
      const res = await cap.nativePromise('CapacitorHttp', 'request', { url, method: 'GET', headers: {} });
      const body = typeof res?.data === 'string' ? JSON.parse(res.data) : res?.data;
      if (body && body.ok === true) return body;
    } catch { /* fall through to the other channels */ }
  }
  if (isLoopbackOrigin()) {
    try {
      const r = await fetch(`/__sp/healthz?url=${encodeURIComponent(url)}`, { cache: 'no-store' });
      if (r.ok) { const body = await r.json(); if (body && body.ok === true) return body; }
    } catch { /* no proxy in a web build — the direct fetch below is the only chance */ }
  }
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (r.ok) { const body = await r.json(); if (body && body.ok === true) return body; }
  } catch { /* no CORS: the socket probe still decides reachability */ }
  return undefined;
}

/**
 * One attempt: opens /ws (no CORS involved), asks the server its wire version with PROBE_HELLO, and reads /healthz
 * through whatever channel this shell has. Reachability is the socket opening; the version and /healthz are
 * enrichments that must never hold a row back, so the attempt always resolves within `timeoutMs`.
 * @param {string} wsUrl an address already normalised by candidateWsUrls
 * @returns {Promise<{ ok: boolean, ms: number, protocol: number|null, info?: object }>}
 */
function probeOnce(wsUrl, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let socket = null;
    let opened = false;
    let settled = false;
    let protocol = null;
    let info;
    let replyDone = false;
    let healthzDone = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try { socket?.close(); } catch { /* already closed */ }
      resolve({ ok, ms: Date.now() - started, protocol, info });
    };
    // Resolve once the socket is up AND the reply + /healthz have each answered (or run out their grace).
    const settle = () => { if (opened && replyDone && healthzDone) finish(true); };

    const deadline = setTimeout(() => {
      replyDone = true;
      healthzDone = true;
      if (opened) finish(true); else finish(false);
    }, timeoutMs);

    // /healthz is best effort: its rejection (no CORS) or slowness never decides reachability.
    fetchHealthzInfo(httpUrlOf(wsUrl)).then((j) => { info = j; healthzDone = true; settle(); });
    setTimeout(() => { healthzDone = true; settle(); }, PROBE_REPLY_TIMEOUT_MS);

    try {
      // NativeWebSocket, never globalThis.WebSocket: in single-player that is the in-page loopback (see above).
      socket = new NativeWebSocket(wsUrl);
    } catch {
      finish(false);
      return;
    }
    socket.onopen = () => {
      opened = true;
      try { socket.send(JSON.stringify(PROBE_HELLO)); } catch { /* ignore */ }
      setTimeout(() => { replyDone = true; settle(); }, PROBE_REPLY_TIMEOUT_MS);
    };
    socket.onmessage = (ev) => {
      if (!opened) return;
      try { protocol = parseProbeReply(JSON.parse(typeof ev.data === 'string' ? ev.data : '')); } catch { protocol = null; }
      replyDone = true;
      settle();
    };
    socket.onerror = () => { if (!opened) finish(false); };
    socket.onclose = () => { if (!opened) finish(false); else { replyDone = true; settle(); } };
  });
}

/**
 * Is `address` a live game server? Checks the channel the game itself will use, so a green row means the player
 * can actually get in. The first candidate gets a second attempt (a slow handshake must not turn into a misleading
 * "无法连接"); the other-scheme candidate gets one, so a hopeless address still fails reasonably fast.
 * @param {string} address
 * @param {number} [timeoutMs] per attempt
 * @param {number} [attempts]
 * @returns {Promise<{ ok: boolean, ms: number, protocol: number|null, info?: object, url?: string }>} `url` is the socket URL that worked
 */
export async function probe(address, timeoutMs = PROBE_TIMEOUT_MS, attempts = 2) {
  let result = { ok: false, ms: 0 };
  const candidates = candidateWsUrls(address);
  for (let c = 0; c < candidates.length; c++) {
    const tries = c === 0 ? Math.max(1, attempts) : 1;
    for (let i = 0; i < tries; i++) {
      result = await probeOnce(candidates[c], timeoutMs);
      if (result.ok) return { ...result, url: candidates[c] };
    }
  }
  return result;
}

const CSS = `
.sp-pick{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:#0c0f0e;color:#c3cbc7;font-family:"Noto Sans SC","Oxanium",system-ui,sans-serif;padding:16px;
  overflow:auto;-webkit-user-select:none;user-select:none}
.sp-pick__box{width:min(680px,100%);display:flex;flex-direction:column;gap:14px}
.sp-pick__title{font-size:20px;letter-spacing:.14em;color:#e8f1ee;font-weight:700}
.sp-pick__sub{font-size:12px;color:#7d8a86;margin-top:4px;letter-spacing:.1em}
.sp-pick__head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.sp-pick__list{display:flex;flex-direction:column;gap:8px}
.sp-pick__card{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #26302d;border-radius:10px;
  background:#121715;cursor:pointer;min-height:56px}
.sp-pick__card:hover{border-color:#3b4a45}
.sp-pick__card.is-sel{border-color:#4ed8af;box-shadow:0 0 0 1px #4ed8af inset}
.sp-pick__dot{width:9px;height:9px;border-radius:50%;background:#5a6663;flex:0 0 auto}
.sp-pick__dot.is-ok{background:#4ed8af;box-shadow:0 0 8px #4ed8af88}
.sp-pick__dot.is-bad{background:#e0635f}
.sp-pick__name{font-size:15px;color:#e8f1ee;font-weight:600}
.sp-pick__addr{font-size:12px;color:#7d8a86;margin-top:2px;word-break:break-all}
.sp-pick__state{font-size:12px;color:#7d8a86;margin-left:auto;text-align:right;white-space:nowrap}
.sp-pick__del{color:#7d8a86;background:none;border:0;font-size:16px;cursor:pointer;padding:0 4px}
.sp-pick__del:hover{color:#e0635f}
.sp-pick__row{display:flex;gap:8px;flex-wrap:wrap}
.sp-pick__in{flex:1 1 auto;min-width:0;padding:11px 12px;border-radius:8px;border:1px solid #26302d;background:#0f1413;
  color:#e8f1ee;font-size:14px;font-family:inherit}
.sp-pick__in:focus{outline:0;border-color:#4ed8af}
.sp-pick__btn{padding:11px 16px;border-radius:8px;border:1px solid #26302d;background:#161d1b;color:#c3cbc7;
  font-size:14px;font-family:inherit;cursor:pointer;white-space:nowrap}
.sp-pick__btn:hover{border-color:#3b4a45}
.sp-pick__go{padding:14px;border-radius:10px;border:1px solid #4ed8af;background:#4ed8af;color:#08110e;
  font-size:16px;font-weight:700;font-family:inherit;cursor:pointer;letter-spacing:.08em}
.sp-pick__go:disabled{opacity:.5;cursor:default}
.sp-pick__opt{display:flex;align-items:center;gap:8px;font-size:13px;color:#98a5a1}
.sp-pick__lan{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border:1px dashed #2f3b37;border-radius:10px}
.sp-pick__lanhead{font-size:13px;color:#cdd7d3}
.sp-pick__lanhead b{color:#4ed8af}
.sp-pick__lanbtns{display:flex;gap:8px}
.sp-pick__upd{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid #2f5c4a;border-radius:10px;background:#101b17}
.sp-pick__upd[hidden]{display:none}
.sp-pick__updhead{font-size:13px;color:#cdd7d3}
.sp-pick__updhead b{color:#4ed8af}
.sp-pick__lanrow{display:flex;flex:1 1 100%;align-items:center;gap:8px}
.sp-pick__port{flex:0 0 88px;text-align:center}
.sp-pick__lan .sp-pick__note{flex:1 1 100%}
.sp-pick__hint{font-size:12px;color:#697571;line-height:1.6;min-height:1.2em}
.sp-pick__menu{display:flex;flex-direction:column;gap:12px}
.sp-pick__mode{display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding:22px 20px;border:1px solid #26302d;
  border-radius:12px;background:#121715;color:#e8f1ee;font-family:inherit;cursor:pointer;text-align:left}
.sp-pick__mode:hover{border-color:#3b4a45}
.sp-pick__mode.is-primary:hover{border-color:#4ed8af;box-shadow:0 0 0 1px #4ed8af inset}
.sp-pick__mode-name{font-size:22px;font-weight:700;letter-spacing:.1em}
.sp-pick__mode-note{font-size:12px;color:#7d8a86;letter-spacing:.06em}
.sp-pick__form{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid #26302d;border-radius:10px;background:#0f1413}
.sp-pick__field{display:flex;align-items:center;gap:10px}
.sp-pick__field>label{flex:0 0 56px;font-size:12px;color:#7d8a86}
.sp-pick__formrow{display:flex;gap:8px;justify-content:flex-end}
.sp-pick__btn.is-go{border-color:#2f6f5c;color:#d8f5ec}
.sp-pick__headbtns{display:flex;gap:8px}
.sp-pick__note{font-size:11px;color:#5f6b67;line-height:1.5}
@media (max-height:520px),(max-width:560px){
  .sp-pick{padding:10px;align-items:flex-start}
  .sp-pick__box{gap:10px}
  .sp-pick__title{font-size:16px}
  .sp-pick__sub{font-size:10px;margin-top:2px}
  .sp-pick__menu{gap:8px}
  .sp-pick__mode{padding:12px 14px;border-radius:10px;gap:3px}
  .sp-pick__mode-name{font-size:16px}
  .sp-pick__mode-note{font-size:10px}
  .sp-pick__list{gap:6px}
  .sp-pick__card{min-height:42px;padding:8px 10px;gap:8px;border-radius:8px}
  .sp-pick__name{font-size:13px}
  .sp-pick__addr,.sp-pick__state,.sp-pick__opt,.sp-pick__hint,.sp-pick__note{font-size:11px}
  .sp-pick__updhead{font-size:11px}
  .sp-pick__in{padding:8px 10px;font-size:12px}
  .sp-pick__port{flex:0 0 66px}
  .sp-pick__btn{padding:8px 11px;font-size:12px}
  .sp-pick__go{padding:10px;font-size:14px}
  .sp-pick__form{padding:10px;gap:6px;border-radius:8px}
  .sp-pick__field>label{flex:0 0 40px;font-size:11px}
}
`;

/** Render the picker into the page. */
function mount() {
  const style = document.createElement('style');
  style.textContent = CSS;
  const root = document.createElement('div');
  root.className = 'sp-pick';
  document.head.appendChild(style);
  document.body.appendChild(root);

  const saved = readItem(K_SERVER, 'localStorage');
  let screen = 'home';   // 'home' (mode menu) | 'host' (create/LAN server) | 'multi' (join a server)
  let form = null;       // null | 'add' | 'edit' (name + address) | 'direct' (address only)
  let editingKey = null; // form === 'edit': the stored server being edited (its normalised key)
  let hintText = '';
  let list = [];
  let selected = null;
  const states = new Map();

  // Open to LAN: the packaged shells expose window.__SP_HOST__ — Electron through desktop/preload.cjs, Android
  // through /offline/host-mobile.js (the native HostServer plugin). The web build has neither and keeps two entries.
  const host = globalThis.__SP_HOST__;
  let hostState = { active: false, port: null, addresses: [], url: null };
  const hostAddr = (s = hostState) => (s.addresses && s.addresses[0] ? `${s.addresses[0]}:${s.port}` : `127.0.0.1:${s.port}`);
  /** The port typed on the 创建服务器 screen: remembered, and '' means "自动" (the OS picks a free one). */
  const readHostPort = () => readItem(K_HOST_PORT, 'localStorage') ?? String(HOST_PORT_DEFAULT);

  // ---- update row -----------------------------------------------------------------------------------------------
  // undefined = not looked up yet; null = nothing newer (or the player ignored this build); { feed, platform } = offer.
  let updateOffer;

  /** Open a download page in the system browser: the desktop shell through its main process, the web in a new tab. */
  async function openUrl(url) {
    try {
      if (typeof globalThis.__SP_UPDATE__?.open === 'function') { await globalThis.__SP_UPDATE__.open(url); return true; }
      return !!globalThis.open(url, '_blank', 'noopener');
    } catch {
      return false;
    }
  }

  /** Hand the download to the phone's own downloader + system installer (the only path that keeps the save). */
  async function installOnAndroid(feed, asset) {
    const plugin = globalThis.Capacitor?.Plugins?.AppUpdate;
    if (typeof plugin?.download !== 'function' || typeof plugin?.install !== 'function') {
      const opened = await openUrl(asset.url);
      setHint(opened ? '已在浏览器打开下载页。' : `请手动下载：${asset.url}`);
      return;
    }
    setHint('正在下载更新…');
    const handle = typeof plugin.addListener === 'function'
      ? plugin.addListener('progress', ({ received, total }) => {
        const pct = total > 0 ? ` ${Math.floor((received / total) * 100)}%` : '';
        setHint(`正在下载更新…${pct}（${(received / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB）`);
      })
      : null;
    try {
      const got = await plugin.download({ url: asset.url, sha256: asset.sha256, name: asset.name });
      if (got?.error) { setHint(`更新失败：${got.error}`); return; }
      if (!got?.path) { setHint('更新失败：下载没有完成。'); return; }
      const installed = await plugin.install({ path: got.path });
      if (installed?.needPermission) {
        setHint('需要先在系统设置里允许本应用「安装未知应用」，再点一次更新。');
        await plugin.openInstallSettings?.();
        return;
      }
      if (installed?.error) { setHint(`安装失败：${installed.error}`); return; }
      setHint('已交给系统安装器：确认即可完成更新，存档不会丢。');
    } catch (e) {
      setHint(`更新失败：${e?.message || e}`);
    } finally {
      handle?.remove?.();
    }
  }

  /** Start the update for this shell (the phone installs it in place; the desktop hands over the download page). */
  async function startUpdate() {
    const feed = updateOffer?.feed;
    const asset = updateAsset(feed, updateOffer?.platform);
    if (!asset) {
      setHint('这个版本没有为这台设备准备安装包，请到发布页手动下载。');
      return;
    }
    if (updateOffer.platform === 'android') {
      await installOnAndroid(feed, asset);
      return;
    }
    // Desktop: a running payload cannot replace its own files, and the distributed form is a zip of a folder, so
    // the download page is where this ends (docs/PACKAGING.md §10 has the installer-based path for later).
    const opened = await openUrl(asset.url);
    setHint(opened ? '已在浏览器打开下载页。' : `请手动下载：${asset.url}`);
  }

  /** Repaint the update row — the home screen is the only place it exists. */
  async function renderUpdate() {
    const el = root.querySelector('#sp-upd');
    if (!el) return;
    if (updateOffer === undefined) updateOffer = await lookupUpdate();
    const feed = updateOffer?.feed;
    // A version the player already ignored stays quiet until a *newer* build shows up.
    if (!feed || readItem(K_SKIP_UPDATE, 'localStorage') === String(feed.build)) {
      el.innerHTML = '';
      el.hidden = true;
      return;
    }
    const asset = updateAsset(feed, updateOffer.platform);
    el.hidden = false;
    el.innerHTML = `
      <div class="sp-pick__updhead">有新版本 · <b>${esc(updateLabel(feed, updateOffer.platform))}</b></div>
      ${feed.notes ? `<div class="sp-pick__note">${esc(feed.notes)}</div>` : ''}
      ${asset ? '' : '<div class="sp-pick__note">这个版本没有为这台设备准备安装包。</div>'}
      <div class="sp-pick__lanbtns">
        <button class="sp-pick__btn is-go" id="sp-upd-go">${updateOffer.platform === 'android' ? '下载并安装' : '打开下载页'}</button>
        <button class="sp-pick__btn" id="sp-upd-skip">忽略此版本</button>
      </div>`;
    el.querySelector('#sp-upd-go')?.addEventListener('click', startUpdate);
    el.querySelector('#sp-upd-skip').addEventListener('click', () => {
      writeItem(K_SKIP_UPDATE, String(feed.build), 'localStorage');
      updateOffer = null; // this screen, this session — and the stored build keeps it quiet next launch too
      renderUpdate();
      setHint('已忽略这个版本，下次有新版本再提醒。');
    });
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* insecure context: fall back */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch { return false; }
  }

  /** Repaint the LAN panel (hidden entirely when the shell exposes no host controls: the web build). */
  function renderLan() {
    const el = root.querySelector('#sp-lan');
    if (!el) return;
    if (!host) { el.style.display = 'none'; return; }
    el.style.display = '';
    if (hostState.active) {
      // The port field was left empty → the OS picked this one, so say so (the address is still the real one).
      const auto = readHostPort().trim() === '';
      el.innerHTML = `
        <div class="sp-pick__lanhead">已对局域网开放 · <b>${hostAddr()}</b>${auto ? '<span class="sp-pick__note">（自动分配）</span>' : ''}</div>
        <div class="sp-pick__lanbtns">
          <button class="sp-pick__btn" id="sp-lan-copy">复制地址</button>
          <button class="sp-pick__btn" id="sp-lan-enter">进入本地服务器</button>
          <button class="sp-pick__btn" id="sp-lan-stop">关闭</button>
        </div>
        <div class="sp-pick__note">同一局域网的博士在「加入服务器 → 添加服务器」里填这个地址即可加入。</div>`;
      el.querySelector('#sp-lan-copy').addEventListener('click', async () => {
        const ok = await copyText(hostAddr());
        setHint(ok ? `已复制地址 ${hostAddr()}，发给同一局域网的博士即可` : `请手动输入地址：${hostAddr()}`);
      });      el.querySelector('#sp-lan-stop').addEventListener('click', async () => {
        try { hostState = await host.stop(); } catch { /* ignore */ }
        setHint('已关闭局域网开放');
        renderLan();
      });
      el.querySelector('#sp-lan-enter').addEventListener('click', () => {
        // Point the game client at the in-process server and reboot so the picker's remembered choice applies
        // (the launch code reads sp.shell.server back into globalThis.__SP_SERVER__).
        writeItem(K_SERVER, `127.0.0.1:${hostState.port}`, 'localStorage');
        writeItem(K_MODE, 'multi', 'localStorage');
        writeItem(K_CHOSEN, '1', 'sessionStorage');
        hidePicker();
        globalThis.location.reload();
      });
    } else {
      el.innerHTML = `
        <div class="sp-pick__lanrow">
          <label class="sp-pick__opt" for="sp-lan-port">端口</label>
          <input class="sp-pick__in sp-pick__port" id="sp-lan-port" type="text" inputmode="numeric" autocomplete="off"
                 maxlength="5" value="${esc(readHostPort())}" placeholder="自动" />
          <button class="sp-pick__btn" id="sp-lan-start">对局域网开放</button>
        </div>
        <div class="sp-pick__note">让同一局域网的博士加入你的游戏（本机即服务器，无需另外开服）。端口留空表示自动分配；填了就一定用这个端口（被占用会报错，方便做端口转发）。</div>`;
      const portEl = el.querySelector('#sp-lan-port');
      const start = async () => {
        const typed = portEl.value.trim();
        const bad = hostPortError(typed);
        if (bad) { setHint(bad); portEl.focus(); return; }
        writeItem(K_HOST_PORT, typed, 'localStorage'); // remembered for the next launch
        setHint('正在开启局域网服务器…');
        try {
          hostState = await host.start(hostPortValue(typed));
          setHint(hostState.error || '');
        } catch (e) {
          // A shell that rejects instead of reporting (an older one) still gets a readable hint.
          setHint(`开启失败：${e?.message || e}`);
        }
        renderLan();
      };
      el.querySelector('#sp-lan-start').addEventListener('click', start);
      portEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); start(); } });
    }
  }

  /** Pull the live host status from the shell and repaint (no-op without a host bridge). */
  async function refreshHost() {
    if (!host) return;
    try { hostState = await host.status(); } catch { /* ignore */ }
    renderLan();
  }

  /** The stored entry behind a key, when it is a user-added (editable) server. */
  const customEntryOf = (key) => customServers().find((e) => toWsUrl(e.address) === key) || null;

  /** The remembered/"go straight in" checkbox — Android has no F2, so it never gets one. */
  const autoRow = isAndroid()
    ? ''
    : '<label class="sp-pick__opt"><input type="checkbox" id="sp-auto"> 记住并直接进入（下次启动不再询问，F2 可重新选择）</label>';

  // 创建服务器 needs window.__SP_HOST__ (Electron preload / Android native host); the web build keeps two entries.
  const hostButton = host
    ? `
        <button class="sp-pick__mode" id="sp-host">
          <span class="sp-pick__mode-name">创建服务器</span>
          <span class="sp-pick__mode-note">对局域网开放 · 本机即服务器</span>
        </button>`
    : '';

  const HOME_HTML = `
    <div class="sp-pick__box">
      <div>
        <div class="sp-pick__title">选择模式</div>
        <div class="sp-pick__sub">STRONGHOLD PROTOCOL · GAME MODE</div>
      </div>
      <div class="sp-pick__menu">
        <button class="sp-pick__mode" id="sp-solo">
          <span class="sp-pick__mode-name">单人游戏</span>
          <span class="sp-pick__mode-note">离线模拟 · 无需服务器</span>
        </button>${hostButton}
        <button class="sp-pick__mode is-primary" id="sp-join">
          <span class="sp-pick__mode-name">加入服务器</span>
          <span class="sp-pick__mode-note">连接到服务器 · 添加服务器 / 直接连接</span>
        </button>
      </div>
      <div class="sp-pick__upd" id="sp-upd" hidden></div>
      <div class="sp-pick__hint" id="sp-hint"></div>
    </div>`;

  const HOST_HTML = `
    <div class="sp-pick__box">
      <div class="sp-pick__head">
        <div>
          <div class="sp-pick__title">创建服务器</div>
          <div class="sp-pick__sub">STRONGHOLD PROTOCOL · HOST</div>
        </div>
        <div class="sp-pick__headbtns">
          <button class="sp-pick__btn" id="sp-back">返回</button>
        </div>
      </div>
      <div class="sp-pick__lan" id="sp-lan"></div>
      <div class="sp-pick__hint" id="sp-hint"></div>
    </div>`;

  const MULTI_HTML = `
    <div class="sp-pick__box">
      <div class="sp-pick__head">
        <div>
          <div class="sp-pick__title">加入服务器</div>
          <div class="sp-pick__sub">STRONGHOLD PROTOCOL · JOIN SERVER</div>
        </div>
        <div class="sp-pick__headbtns">
          <button class="sp-pick__btn" id="sp-refresh" title="重新测试各服务器延迟">刷新</button>
          <button class="sp-pick__btn" id="sp-back">返回</button>
        </div>
      </div>
      <div class="sp-pick__list" id="sp-list"></div>
      <div id="sp-form"></div>
      <div class="sp-pick__row">
        <button class="sp-pick__btn" id="sp-add">添加服务器</button>
        <button class="sp-pick__btn" id="sp-direct">直接连接</button>
        <button class="sp-pick__btn" id="sp-edit" title="编辑选中的自建服务器">编辑</button>
      </div>
      ${autoRow}
      <button class="sp-pick__go" id="sp-go">进 入 游 戏</button>
      <div class="sp-pick__hint" id="sp-hint"></div>
    </div>`;

  function setHint(text) {
    hintText = text || '';
    const el = root.querySelector('#sp-hint');
    if (el) el.textContent = hintText;
  }

  /** Repaint the server list onto the current (multi) screen. */
  function renderList() {
    const listEl = root.querySelector('#sp-list');
    if (!listEl) return;
    const goEl = root.querySelector('#sp-go');
    const editEl = root.querySelector('#sp-edit');
    listEl.innerHTML = '';
    for (const s of list) {
      const st = states.get(s.key) || {};
      const custom = customEntryOf(s.key) != null;
      // The wire protocol is what the client and server must agree on; a differing release number is fine.
      const protocol = st.protocol ?? (Number.isInteger(st.info?.version) ? st.info.version : null);
      const verdict = versionVerdict(PROTOCOL_VERSION, protocol);
      const bad = verdict === 'mismatch' || (!st.pending && st.failed);
      const state = st.pending ? '检测中…'
        : verdict === 'mismatch' ? '协议不兼容'
          : st.ok ? `可连接 · ${st.ms}ms`
            : st.failed ? '无法连接' : '';
      const info = [
        st.info?.app ? `v${st.info.app}` : '',
        versionLabel(PROTOCOL_VERSION, protocol) || '',
        st.info?.humans != null ? `在线 ${st.info.humans}` : '',
        st.info?.rooms != null ? `房间 ${st.info.rooms}` : '',
      ].filter(Boolean).join(' · ') || s.note;
      const card = document.createElement('div');
      card.className = `sp-pick__card${s.key === selected ? ' is-sel' : ''}`;
      card.innerHTML = `
        <div class="sp-pick__dot ${st.pending || !state ? '' : bad ? 'is-bad' : st.ok ? 'is-ok' : ''}"></div>
        <div style="min-width:0">
          <div class="sp-pick__name">${esc(s.label)}${s.key === keyOf(buildDefault()) ? ' · 默认' : ''}</div>
          <div class="sp-pick__addr">${esc(s.http.replace(/^https?:\/\//, ''))}${info ? ` · ${esc(info)}` : ''}</div>
        </div>
        <div class="sp-pick__state">${esc(state)}</div>
        ${custom ? '<button class="sp-pick__del" title="删除">×</button>' : ''}`;
      card.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('sp-pick__del')) {
          writeItem(K_LIST, JSON.stringify(customServers().filter((e) => toWsUrl(e.address) !== s.key)), 'localStorage');
          loadList();
          return;
        }
        selected = s.key;
        renderList();
      });
      listEl.appendChild(card);
    }
    if (goEl) goEl.disabled = !selected;
    // Only a user-added server can be edited (the built-in and the packaged default are fixed).
    if (editEl) editEl.disabled = form !== null || !customEntryOf(selected);
  }

  function refresh(entry) {
    states.set(entry.key, { pending: true });
    renderList();
    probe(entry.address).then((r) => {
      states.set(entry.key, { ok: r.ok, ms: r.ms, protocol: r.protocol, info: r.info, failed: !r.ok, url: r.url });
      renderList();
      if (!r.ok && entry.key === selected) setHint(`连不上 ${entry.http} —— 确认服务器已启动，或换一个地址。`);
    });
  }

  /** 刷新: re-probe every listed server (the rows show 检测中… until each answers). */
  function refreshAll() {
    setHint('正在重新测试各服务器延迟…');
    states.clear();
    renderList();
    for (const s of list) refresh(s);
  }

  function loadList(keepKey) {
    list = serverList();
    const savedKey = keyOf(saved);
    selected = (keepKey && list.some((s) => s.key === keepKey)) ? keepKey
      : (savedKey && list.some((s) => s.key === savedKey)) ? savedKey
        : keyOf(buildDefault());
    if (!list.some((s) => s.key === selected)) selected = list[0]?.key ?? null;
    states.clear();
    renderList();
    for (const s of list) refresh(s);
  }

  /** Remember the choice and (re)boot into it — the only writer of sp.shell.*. */
  function connected(entry) {
    // Prefer the URL that actually answered the probe: a typed `host:port` may only be reachable on one scheme.
    const st = entry?.key ? states.get(entry.key) : null;
    // The wire protocol is the one thing the client and server must agree on (server/net.js): stop before rebooting
    // into a server that would reject this client's handshake anyway. An unknown protocol (unprobed direct connect,
    // or a probe that could not read one) is allowed — the server's own handshake is the backstop.
    const protocol = st ? (st.protocol ?? (Number.isInteger(st.info?.version) ? st.info.version : null)) : null;
    if (versionVerdict(PROTOCOL_VERSION, protocol) === 'mismatch') {
      setHint(versionMismatchHint(PROTOCOL_VERSION, protocol));
      return;
    }
    const address = (st?.ok && st.url) ? st.url : entry?.address;
    const key = keyOf(address);
    if (!key) return;
    // Leaving single-player: the page booted with the in-page server, so it must reload to get the real WebSocket
    // back — even when the chosen address is the one the payload was built for.
    const wasSolo = readItem(K_MODE, 'localStorage') === 'solo';
    writeItem(K_MODE, 'multi', 'localStorage');
    writeItem(K_SERVER, address, 'localStorage');
    const autoEl = root.querySelector('#sp-auto');
    if (autoEl) writeItem(K_AUTOSTART, autoEl.checked ? '1' : '0', 'localStorage');
    writeItem(K_CHOSEN, '1', 'sessionStorage');
    // Already the server the game booted with (it reads the same localStorage entry): just close the overlay.
    if (!wasSolo && key === bootTarget) {
      hidePicker();
      return;
    }
    globalThis.__SP_SERVER__ = address;
    globalThis.location.reload();
  }

  function enterGame() {
    const entry = list.find((s) => s.key === selected);
    if (entry) connected(entry);
  }

  const ADDR_HINT = 'host、host:port、http(s)://…、ws(s)://…';
  const ADDR_NOTE = '<div class="sp-pick__note">不写协议也能用：带端口的地址按 ws:// 与 wss:// 各试一次，公网域名默认 wss://。</div>';

  /** The add / edit / direct-connect form under the list (two fields for a saved server, one for a quick connect). */
  function renderForm() {
    const host = root.querySelector('#sp-form');
    if (!host) return;
    host.innerHTML = '';
    if (!form) { renderList(); return; }
    const editing = form === 'edit' ? customEntryOf(editingKey) : null;
    const wrap = document.createElement('div');
    wrap.className = 'sp-pick__form';
    wrap.innerHTML = form === 'direct'
      ? `<div class="sp-pick__field"><label for="sp-addr">地址</label>
           <input class="sp-pick__in" id="sp-addr" placeholder="${ADDR_HINT}" spellcheck="false"></div>
         ${ADDR_NOTE}
         <div class="sp-pick__formrow">
           <button class="sp-pick__btn" id="sp-cancel">取消</button>
           <button class="sp-pick__btn is-go" id="sp-ok">连接</button></div>`
      : `<div class="sp-pick__field"><label for="sp-name">名称</label>
           <input class="sp-pick__in" id="sp-name" maxlength="${NAME_MAX}" placeholder="我的服务器" spellcheck="false"></div>
         <div class="sp-pick__field"><label for="sp-addr">地址</label>
           <input class="sp-pick__in" id="sp-addr" placeholder="${ADDR_HINT}" spellcheck="false"></div>
         ${ADDR_NOTE}
         <div class="sp-pick__formrow">
           <button class="sp-pick__btn" id="sp-cancel">取消</button>
           <button class="sp-pick__btn is-go" id="sp-ok">${form === 'edit' ? '保存' : '完成'}</button></div>`;
    host.appendChild(wrap);

    const nameEl = wrap.querySelector('#sp-name');
    const addrEl = wrap.querySelector('#sp-addr');
    if (editing) {
      if (nameEl) nameEl.value = editing.name || '';
      addrEl.value = editing.address;
    }
    const close = () => { form = null; editingKey = null; setHint(''); renderForm(); };
    wrap.querySelector('#sp-cancel').addEventListener('click', close);
    wrap.querySelector('#sp-ok').addEventListener('click', () => {
      const raw = addrEl.value.trim();
      const bad = addressError(raw);
      if (bad) { setHint(bad); return; }
      if (form === 'direct') { connected({ address: raw }); return; }
      const key = toWsUrl(raw);
      // An edit replaces the old entry: drop both the previous key and any entry the new address collides with.
      const drop = form === 'edit' ? new Set([editingKey, key]) : new Set([key]);
      const rest = customServers().filter((e) => !drop.has(toWsUrl(e.address)));
      rest.unshift({ name: cleanName(nameEl.value), address: raw });
      writeItem(K_LIST, JSON.stringify(rest), 'localStorage');
      form = null;
      editingKey = null;
      setHint('');
      renderForm();
      loadList(key);
    });
    addrEl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') wrap.querySelector('#sp-ok').click(); });
    (nameEl || addrEl).focus();
    renderList();
  }

  /** Build the current screen's skeleton and wire it up. */
  function layout() {
    root.innerHTML = screen === 'home' ? HOME_HTML : screen === 'host' ? HOST_HTML : MULTI_HTML;
    if (screen === 'home') {
      root.querySelector('#sp-solo').addEventListener('click', () => {
        // Single-player runs the game server inside the page (offline/bootstrap.js); remember the choice and reboot
        // so that module is loaded before the game boots.
        writeItem(K_MODE, 'solo', 'localStorage');
        writeItem(K_CHOSEN, '1', 'sessionStorage');
        hidePicker();
        globalThis.location.reload();
      });
      // The host entry exists only when the shell exposes the bridge (desktop).
      root.querySelector('#sp-host')?.addEventListener('click', () => { screen = 'host'; form = null; setHint(''); layout(); });
      root.querySelector('#sp-join').addEventListener('click', () => { screen = 'multi'; form = null; setHint(''); layout(); loadList(); });
      renderUpdate();
    } else if (screen === 'host') {
      root.querySelector('#sp-back').addEventListener('click', () => { screen = 'home'; setHint(''); layout(); });
      renderLan();
      refreshHost();
    } else {
      root.querySelector('#sp-back').addEventListener('click', () => { screen = 'home'; form = null; editingKey = null; setHint(''); layout(); });
      root.querySelector('#sp-refresh').addEventListener('click', refreshAll);
      root.querySelector('#sp-add').addEventListener('click', () => { const on = form !== 'add'; form = on ? 'add' : null; editingKey = null; setHint(''); renderForm(); });
      root.querySelector('#sp-direct').addEventListener('click', () => { const on = form !== 'direct'; form = on ? 'direct' : null; editingKey = null; setHint(''); renderForm(); });
      root.querySelector('#sp-edit').addEventListener('click', () => {
        if (!customEntryOf(selected)) return;
        form = 'edit';
        editingKey = selected;
        setHint('');
        renderForm();
      });
      root.querySelector('#sp-go').addEventListener('click', enterGame);
      const autoEl = root.querySelector('#sp-auto');
      if (autoEl) autoEl.checked = readItem(K_AUTOSTART, 'localStorage') !== '0';
      renderForm();
    }
    const hintEl = root.querySelector('#sp-hint');
    if (hintEl) hintEl.textContent = hintText;
  }

  // Esc: close the form, then step back to the mode menu, then (once at the menu) leave the picker entirely — so an
  // F2 picker opened over a running game/page is dismissed with Esc. Bound on document, not root: the picker does not
  // hold keyboard focus (the game underneath does), so a root-level listener would never fire.
  const onKeyDown = (ev) => {
    if (ev.key !== 'Escape') return;
    if (form) { form = null; editingKey = null; setHint(''); renderForm(); }
    else if (screen !== 'home') { screen = 'home'; setHint(''); layout(); }
    else hidePicker();
  };
  document.addEventListener('keydown', onKeyDown);

  // The game boots underneath this overlay: hide its boot screen so nothing flashes through.
  const boot = document.getElementById('boot');
  const bootVisibility = boot?.style.visibility;
  if (boot) boot.style.visibility = 'hidden';

  layout();
  return {
    root,
    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      if (boot) boot.style.visibility = bootVisibility || '';
      root.remove();
      style.remove();
    },
  };
}

let current = null;

/** Show the picker (desktop: F2 or --choose-server). */
export function showPicker() {
  if (!current) current = mount();
}

/** Hide it again (tests, programmatic flows). */
export function hidePicker() {
  current?.destroy();
  current = null;
}

export function pickerVisible() {
  return !!current;
}

globalThis.__SP_SHELL_PICKER__ = {
  show: showPicker,
  hide: hidePicker,
  visible: pickerVisible,
  servers: serverList,
  candidates: candidateWsUrls,
  probe,
};

// ---- launch decision --------------------------------------------------------------------------------------------
// A LAN guest (the page was served by a "创建服务器" host: /js/runtime-config.js sets __SP_LAN_CLIENT__) plays on
// that host: never show the picker, and ignore any server this browser remembered from before (it must stay on its
// own origin, which net.js falls back to when __SP_SERVER__ is empty).
const lanClient = globalThis.__SP_LAN_CLIENT__ === true;
const savedAddress = lanClient ? null : readItem(K_SERVER, 'localStorage');
if (savedAddress) globalThis.__SP_SERVER__ = savedAddress;
/** The server the game is booting with: public/js/net.js reads __SP_SERVER__ when it opens the socket. */
const bootTarget = keyOf(globalThis.__SP_SERVER__);

const forced = new URLSearchParams(globalThis.location?.search || '').get('pick') === '1';
const chosenThisSession = readItem(K_CHOSEN, 'sessionStorage') === '1';
const autostart = autostartOn(readItem(K_AUTOSTART, 'localStorage'), isAndroid());
if (!lanClient && shouldShowPicker({ forced, chosenThisSession, savedAddress, autostart })) showPicker();
