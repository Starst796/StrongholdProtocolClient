// Shell server picker — packaged clients only (never part of the game repo).
//
// Copied verbatim into the payload as /js/shell/picker.js (tools/package-client.mjs), so the relative imports below
// are payload paths: public/js/net.js is ../net.js, and the pure rules are ./picker-core.js.
//
// The payload's index.html loads this module *before* /js/main.js; ES module order guarantees it runs first, so it
// can set `globalThis.__SP_SERVER__` (read by public/js/net.js through resolveServerTarget) before the game opens
// its socket. The browser build has no such file and stays pinned to its own origin.
//
// Behaviour
//   * a remembered choice in localStorage decides the server for the next launch;
//   * desktop shells skip the UI once something is remembered (reopen with F2 / --choose-server);
//   * Android always shows it — a phone has no F2 and this is the only way to switch servers there;
//   * probing opens a real /ws socket (the channel the game itself uses), so it needs no CORS headers, while a
//     best-effort /healthz fetch enriches the row whenever the server does allow it.

import { toHttpUrl, toWsUrl } from '../net.js';
import {
  BUILTIN_SERVERS, K_AUTOSTART, K_CHOSEN, K_LIST, K_SERVER,
  addressError, autostartOn, customFrom, isAndroidUA, shouldShowPicker,
} from './picker-core.js';

const PROBE_TIMEOUT_MS = 4000;
const isAndroid = () => isAndroidUA(globalThis.navigator?.userAgent);

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
  const injected = globalThis.__SP_SERVER__;
  return typeof injected === 'string' && injected.trim() ? injected.trim() : BUILTIN_SERVERS[0].address;
}

/** Normalised socket URL of an address ('' → null). toWsUrl normalises rather than validates; addressError does that. */
const keyOf = (address) => (typeof address === 'string' && address.trim() ? toWsUrl(address) : null);

/** Escape interpolated text: /healthz comes from a remote server, so its fields are never trusted as markup. */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Custom entries the user added, newest first. */
function customServers() {
  return customFrom(readItem(K_LIST, 'localStorage'));
}

/** Every entry the picker lists, de-duplicated on the normalised socket URL. */
export function serverList() {
  const seen = new Set();
  const out = [];
  const entries = [...BUILTIN_SERVERS, ...customServers().map((address) => ({ address, label: '自定义', note: '' }))];
  for (const s of entries) {
    const key = keyOf(s.address);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...s, key, http: toHttpUrl(s.address) });
  }
  return out;
}

/**
 * One attempt: opens /ws (no CORS involved) and reads /healthz when the server allows it.
 * @returns {Promise<{ ok: boolean, ms: number, info?: object }>}
 */
function probeOnce(address, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let socket = null;
    let timer = null;
    let opened = false;
    let settled = false;
    let info;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket?.close(); } catch { /* already closed */ }
      resolve({ ok, ms: Date.now() - started, info });
    };

    timer = setTimeout(() => finish(false), timeoutMs);

    // Best effort, never blocking: /healthz usually has no CORS headers, and that is the server's business
    // (the browser logs a console error for it, the picker ignores the rejection).
    fetch(`${toHttpUrl(address)}/healthz`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((json) => {
        info = json;
        if (opened) finish(true);
      })
      .catch(() => { /* no CORS or no route: the socket result decides */ });

    try {
      socket = new WebSocket(toWsUrl(address));
    } catch {
      finish(false);
      return;
    }
    socket.onopen = () => { opened = true; finish(true); };
    socket.onerror = () => { if (!opened) finish(false); };
    socket.onclose = () => { if (!opened) finish(false); };
  });
}

/**
 * Is `address` a live game server? Checks the channel the game itself will use, so a green row means the player
 * can actually get in. A failed attempt is retried once: a slow handshake (the official server sits behind
 * Cloudflare) must not turn into a misleading "无法连接".
 * @param {string} address
 * @param {number} [timeoutMs] per attempt
 * @param {number} [attempts]
 * @returns {Promise<{ ok: boolean, ms: number, info?: object }>}
 */
export async function probe(address, timeoutMs = PROBE_TIMEOUT_MS, attempts = 2) {
  let result = { ok: false, ms: 0 };
  for (let i = 0; i < Math.max(1, attempts); i++) {
    result = await probeOnce(address, timeoutMs);
    if (result.ok) return result;
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
.sp-pick__row{display:flex;gap:8px}
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
.sp-pick__hint{font-size:12px;color:#697571;line-height:1.6;min-height:1.2em}
`;

/** Render the picker into the page. */
function mount() {
  const style = document.createElement('style');
  style.textContent = CSS;
  const root = document.createElement('div');
  root.className = 'sp-pick';
  document.head.appendChild(style);
  document.body.appendChild(root);
  root.innerHTML = `
    <div class="sp-pick__box">
      <div>
        <div class="sp-pick__title">选择服务器</div>
        <div class="sp-pick__sub">STRONGHOLD PROTOCOL · SELECT SERVER</div>
      </div>
      <div class="sp-pick__list" id="sp-list"></div>
      <div class="sp-pick__row">
        <input class="sp-pick__in" id="sp-addr" placeholder="自定义地址：host、host:port、http(s)://…、ws(s)://…" spellcheck="false">
        <button class="sp-pick__btn" id="sp-add">添加</button>
      </div>
      ${isAndroid() ? '' : '<label class="sp-pick__opt"><input type="checkbox" id="sp-auto"> 记住并直接进入（下次启动不再询问，F2 可重新选择）</label>'}
      <button class="sp-pick__go" id="sp-go">进 入 游 戏</button>
      <div class="sp-pick__hint" id="sp-hint"></div>
    </div>`;

  const listEl = root.querySelector('#sp-list');
  const goEl = root.querySelector('#sp-go');
  const autoEl = root.querySelector('#sp-auto');
  const addrEl = root.querySelector('#sp-addr');
  const hintEl = root.querySelector('#sp-hint');
  const setHint = (text) => { hintEl.textContent = text || ''; };

  const saved = readItem(K_SERVER, 'localStorage');
  let list = [];
  let selected = null;
  const states = new Map();

  function render() {
    listEl.innerHTML = '';
    for (const s of list) {
      const st = states.get(s.key) || {};
      const custom = !BUILTIN_SERVERS.some((b) => keyOf(b.address) === s.key);
      const state = st.pending ? '检测中…' : st.ok ? `可连接 · ${st.ms}ms` : st.failed ? '无法连接' : '';
      const info = st.info
        ? [st.info.app ? `v${st.info.app}` : '', st.info.humans != null ? `在线 ${st.info.humans}` : '', st.info.rooms != null ? `房间 ${st.info.rooms}` : '']
          .filter(Boolean).join(' · ')
        : '';
      const card = document.createElement('div');
      card.className = `sp-pick__card${s.key === selected ? ' is-sel' : ''}`;
      card.innerHTML = `
        <div class="sp-pick__dot ${st.pending || !state ? '' : st.ok ? 'is-ok' : 'is-bad'}"></div>
        <div style="min-width:0">
          <div class="sp-pick__name">${esc(s.label)}${s.key === keyOf(buildDefault()) ? ' · 默认' : ''}</div>
          <div class="sp-pick__addr">${esc(s.http.replace(/^https?:\/\//, ''))}${info || s.note ? ` · ${esc(info || s.note)}` : ''}</div>
        </div>
        <div class="sp-pick__state">${esc(state)}</div>
        ${custom ? '<button class="sp-pick__del" title="删除">×</button>' : ''}`;
      card.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('sp-pick__del')) {
          writeItem(K_LIST, JSON.stringify(customServers().filter((a) => toWsUrl(a) !== s.key)), 'localStorage');
          loadList();
          return;
        }
        selected = s.key;
        render();
      });
      listEl.appendChild(card);
    }
    goEl.disabled = !selected;
  }

  function refresh(entry) {
    states.set(entry.key, { pending: true });
    render();
    probe(entry.address).then((r) => {
      states.set(entry.key, { ok: r.ok, ms: r.ms, info: r.info, failed: !r.ok });
      render();
      if (!r.ok && entry.key === selected) setHint(`连不上 ${entry.http} —— 确认服务器已启动，或换一个地址。`);
    });
  }

  function loadList() {
    list = serverList();
    const savedKey = keyOf(saved);
    selected = (savedKey && list.some((s) => s.key === savedKey)) ? savedKey : keyOf(buildDefault());
    if (!list.some((s) => s.key === selected)) selected = list[0]?.key ?? null;
    states.clear();
    setHint('');
    render();
    for (const s of list) refresh(s);
  }

  function choose() {
    const entry = list.find((s) => s.key === selected);
    if (!entry) return;
    writeItem(K_SERVER, entry.address, 'localStorage');
    if (autoEl) writeItem(K_AUTOSTART, autoEl.checked ? '1' : '0', 'localStorage');
    writeItem(K_CHOSEN, '1', 'sessionStorage');
    // Already the server the game booted with (it reads the same localStorage entry): just close the overlay.
    if (entry.key === bootTarget) {
      hidePicker();
      return;
    }
    globalThis.__SP_SERVER__ = entry.address;
    globalThis.location.reload();
  }

  goEl.addEventListener('click', choose);
  root.querySelector('#sp-add').addEventListener('click', () => {
    const raw = addrEl.value.trim();
    const bad = addressError(raw);
    if (bad) {
      setHint(bad);
      return;
    }
    const key = toWsUrl(raw);
    const custom = customServers();
    if (!custom.some((a) => toWsUrl(a) === key)) custom.unshift(raw);
    writeItem(K_LIST, JSON.stringify(custom), 'localStorage');
    addrEl.value = '';
    loadList();
  });
  addrEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') root.querySelector('#sp-add').click();
  });

  // The game boots underneath this overlay: hide its boot screen so nothing flashes through.
  const boot = document.getElementById('boot');
  const bootVisibility = boot?.style.visibility;
  if (boot) boot.style.visibility = 'hidden';

  if (autoEl) autoEl.checked = readItem(K_AUTOSTART, 'localStorage') !== '0';
  loadList();
  return {
    root,
    destroy() {
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
  probe,
};

// ---- launch decision --------------------------------------------------------------------------------------------
const savedAddress = readItem(K_SERVER, 'localStorage');
if (savedAddress) globalThis.__SP_SERVER__ = savedAddress;
/** The server the game is booting with: public/js/net.js reads __SP_SERVER__ when it opens the socket. */
const bootTarget = keyOf(globalThis.__SP_SERVER__);

const forced = new URLSearchParams(globalThis.location?.search || '').get('pick') === '1';
const chosenThisSession = readItem(K_CHOSEN, 'sessionStorage') === '1';
const autostart = autostartOn(readItem(K_AUTOSTART, 'localStorage'), isAndroid());
if (shouldShowPicker({ forced, chosenThisSession, savedAddress, autostart })) showPicker();