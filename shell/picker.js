// Shell server picker — packaged clients only (never part of the game repo).
//
// Copied verbatim into the payload as /js/shell/picker.js (tools/package-client.mjs), so the relative imports below
// are payload paths: public/js/net.js is ../net.js, and the pure rules are ./picker-core.js.
//
// The payload's index.html loads this module *before* /js/main.js; ES module order guarantees it runs first, so it
// can set `globalThis.__SP_SERVER__` (read by public/js/net.js through resolveServerTarget) before the game opens
// its socket. The browser build has no such file and stays pinned to its own origin.
//
// Layout (Minecraft-like): a main page offers 单人游戏 / 多人游戏. 单人游戏 is reserved — the game has no
// server-less mode (the lobby/room/match lifecycle is server-authoritative) — so it only explains itself. 多人游戏
// opens the server list, where the player can add a server (name + address), connect directly to a typed address,
// or join a listed/remembered one.
//
// Behaviour
//   * a remembered choice in localStorage decides the server for the next launch;
//   * desktop shells skip the UI once something is remembered (reopen with F2 / --choose-server);
//   * Android always shows it — a phone has no F2 and this is the only way to switch servers there;
//   * probing opens a real /ws socket (the channel the game itself uses), so it needs no CORS headers, while a
//     best-effort /healthz fetch enriches the row whenever the server does allow it.

import { toHttpUrl, toWsUrl } from '../net.js';
import {
  BUILTIN_SERVERS, K_AUTOSTART, K_CHOSEN, K_LIST, K_SERVER, NAME_MAX,
  addressError, autostartOn, cleanName, customFrom, isAndroidUA, serverName, shouldShowPicker,
} from './picker-core.js';

const PROBE_TIMEOUT_MS = 4000;
const isAndroid = () => isAndroidUA(globalThis.navigator?.userAgent);

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
 * can actually get in. A failed attempt is retried once: a slow handshake must not turn into a misleading
 * "无法连接".
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
  let screen = 'home';   // 'home' (mode menu) | 'multi' (server list)
  let form = null;       // null | 'add' (name + address) | 'direct' (address only)
  let hintText = '';
  let list = [];
  let selected = null;
  const states = new Map();

  /** The remembered/"go straight in" checkbox — Android has no F2, so it never gets one. */
  const autoRow = isAndroid()
    ? ''
    : '<label class="sp-pick__opt"><input type="checkbox" id="sp-auto"> 记住并直接进入（下次启动不再询问，F2 可重新选择）</label>';

  const HOME_HTML = `
    <div class="sp-pick__box">
      <div>
        <div class="sp-pick__title">选择模式</div>
        <div class="sp-pick__sub">STRONGHOLD PROTOCOL · GAME MODE</div>
      </div>
      <div class="sp-pick__menu">
        <button class="sp-pick__mode" id="sp-solo">
          <span class="sp-pick__mode-name">单人游戏</span>
          <span class="sp-pick__mode-note">离线模拟 · 开发中</span>
        </button>
        <button class="sp-pick__mode is-primary" id="sp-multi">
          <span class="sp-pick__mode-name">多人游戏</span>
          <span class="sp-pick__mode-note">连接到服务器 · 添加服务器 / 直接连接</span>
        </button>
      </div>
      <div class="sp-pick__hint" id="sp-hint"></div>
    </div>`;

  const MULTI_HTML = `
    <div class="sp-pick__box">
      <div class="sp-pick__head">
        <div>
          <div class="sp-pick__title">多人游戏</div>
          <div class="sp-pick__sub">STRONGHOLD PROTOCOL · MULTIPLAYER</div>
        </div>
        <button class="sp-pick__btn" id="sp-back">返回</button>
      </div>
      <div class="sp-pick__list" id="sp-list"></div>
      <div id="sp-form"></div>
      <div class="sp-pick__row">
        <button class="sp-pick__btn" id="sp-add">添加服务器</button>
        <button class="sp-pick__btn" id="sp-direct">直接连接</button>
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
    listEl.innerHTML = '';
    for (const s of list) {
      const st = states.get(s.key) || {};
      const custom = customServers().some((e) => toWsUrl(e.address) === s.key);
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
  }

  function refresh(entry) {
    states.set(entry.key, { pending: true });
    renderList();
    probe(entry.address).then((r) => {
      states.set(entry.key, { ok: r.ok, ms: r.ms, info: r.info, failed: !r.ok });
      renderList();
      if (!r.ok && entry.key === selected) setHint(`连不上 ${entry.http} —— 确认服务器已启动，或换一个地址。`);
    });
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
    const key = keyOf(entry?.address);
    if (!key) return;
    writeItem(K_SERVER, entry.address, 'localStorage');
    const autoEl = root.querySelector('#sp-auto');
    if (autoEl) writeItem(K_AUTOSTART, autoEl.checked ? '1' : '0', 'localStorage');
    writeItem(K_CHOSEN, '1', 'sessionStorage');
    // Already the server the game booted with (it reads the same localStorage entry): just close the overlay.
    if (key === bootTarget) {
      hidePicker();
      return;
    }
    globalThis.__SP_SERVER__ = entry.address;
    globalThis.location.reload();
  }

  function enterGame() {
    const entry = list.find((s) => s.key === selected);
    if (entry) connected(entry);
  }

  /** The add-server / direct-connect form under the list (Minecraft's two fields vs. one). */
  function renderForm() {
    const host = root.querySelector('#sp-form');
    if (!host) return;
    host.innerHTML = '';
    if (!form) return;
    const wrap = document.createElement('div');
    wrap.className = 'sp-pick__form';
    wrap.innerHTML = form === 'add'
      ? `<div class="sp-pick__field"><label for="sp-name">名称</label>
           <input class="sp-pick__in" id="sp-name" maxlength="${NAME_MAX}" placeholder="我的服务器" spellcheck="false"></div>
         <div class="sp-pick__field"><label for="sp-addr">地址</label>
           <input class="sp-pick__in" id="sp-addr" placeholder="host、host:port、http(s)://…、ws(s)://…" spellcheck="false"></div>
         <div class="sp-pick__formrow">
           <button class="sp-pick__btn" id="sp-cancel">取消</button>
           <button class="sp-pick__btn is-go" id="sp-ok">完成</button></div>`
      : `<div class="sp-pick__field"><label for="sp-addr">地址</label>
           <input class="sp-pick__in" id="sp-addr" placeholder="host、host:port、http(s)://…、ws(s)://…" spellcheck="false"></div>
         <div class="sp-pick__formrow">
           <button class="sp-pick__btn" id="sp-cancel">取消</button>
           <button class="sp-pick__btn is-go" id="sp-ok">连接</button></div>`;
    host.appendChild(wrap);

    const nameEl = wrap.querySelector('#sp-name');
    const addrEl = wrap.querySelector('#sp-addr');
    wrap.querySelector('#sp-cancel').addEventListener('click', () => { form = null; setHint(''); renderForm(); });
    wrap.querySelector('#sp-ok').addEventListener('click', () => {
      const raw = addrEl.value.trim();
      const bad = addressError(raw);
      if (bad) { setHint(bad); return; }
      if (form === 'direct') { connected({ address: raw }); return; }
      const key = toWsUrl(raw);
      const rest = customServers().filter((e) => toWsUrl(e.address) !== key);
      rest.unshift({ name: cleanName(nameEl.value), address: raw });
      writeItem(K_LIST, JSON.stringify(rest), 'localStorage');
      form = null;
      setHint('');
      renderForm();
      loadList(key);
    });
    addrEl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') wrap.querySelector('#sp-ok').click(); });
    (nameEl || addrEl).focus();
  }

  /** Build the current screen's skeleton and wire it up. */
  function layout() {
    root.innerHTML = screen === 'home' ? HOME_HTML : MULTI_HTML;
    if (screen === 'home') {
      root.querySelector('#sp-solo').addEventListener('click', () => setHint('单人模式还没做：游戏的大厅 / 房间 / 模拟都在服务端，暂时不能脱离服务器运行，敬请期待。'));
      root.querySelector('#sp-multi').addEventListener('click', () => { screen = 'multi'; form = null; setHint(''); layout(); loadList(); });
    } else {
      root.querySelector('#sp-back').addEventListener('click', () => { screen = 'home'; form = null; setHint(''); layout(); });
      root.querySelector('#sp-add').addEventListener('click', () => { form = form === 'add' ? null : 'add'; setHint(''); renderForm(); });
      root.querySelector('#sp-direct').addEventListener('click', () => { form = form === 'direct' ? null : 'direct'; setHint(''); renderForm(); });
      root.querySelector('#sp-go').addEventListener('click', enterGame);
      const autoEl = root.querySelector('#sp-auto');
      if (autoEl) autoEl.checked = readItem(K_AUTOSTART, 'localStorage') !== '0';
      renderForm();
      renderList();
    }
    const hintEl = root.querySelector('#sp-hint');
    if (hintEl) hintEl.textContent = hintText;
  }

  // Esc: close the form, then step back to the mode menu.
  root.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (form) { form = null; setHint(''); renderForm(); }
    else if (screen === 'multi') { screen = 'home'; setHint(''); layout(); }
  });

  // The game boots underneath this overlay: hide its boot screen so nothing flashes through.
  const boot = document.getElementById('boot');
  const bootVisibility = boot?.style.visibility;
  if (boot) boot.style.visibility = 'hidden';

  layout();
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
