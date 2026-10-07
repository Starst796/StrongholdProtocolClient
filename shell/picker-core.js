// Pure rules behind the shell server picker (shell/picker.js): when to show it, which addresses to accept, what a
// stored preference means. No DOM, no storage, no imports — so test/picker.test.js can pin the behaviour under
// plain Node. The assembler copies this next to the picker as /js/shell/picker-core.js.

/** localStorage keys (the picker is the only writer). */
export const K_SERVER = 'sp.shell.server';       // last chosen address
export const K_AUTOSTART = 'sp.shell.autostart'; // '1' = skip the picker next launch, '0' = always show
export const K_LIST = 'sp.shell.list';           // user-added servers: JSON [{ name, address }]
export const K_CHOSEN = 'sp.shell.chosen';       // sessionStorage: already entered once in this session
export const K_MODE = 'sp.shell.mode';           // 'solo' = in-page single-player server, 'multi' = a real server
export const K_HOST_PORT = 'sp.shell.hostPort';  // port 创建服务器 listens on ('' / absent = let the OS pick)
export const K_SKIP_UPDATE = 'sp.shell.skipUpdate'; // build number the player chose to ignore ('' / absent = ask again)

/** Longest stored server name (the picker's "add server" field is capped to this). */
export const NAME_MAX = 32;

/** Port 创建服务器 uses when the player keeps the default (the desktop shell's static page server is 47821). */
export const HOST_PORT_DEFAULT = 47822;

/** Ports the client itself binds (the page server / the host default) — worth naming in a port error. */
export const CLIENT_PAGE_PORT = 47821;

/**
 * Validate the port typed on the 创建服务器 screen. An empty value means "自动" (the OS picks a free port), which is
 * what the field starts as on a fresh install.
 * @param {string|number|null|undefined} raw
 * @returns {string|null} the reason to show, or null when acceptable
 */
export function hostPortError(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null; // 自动
  if (!/^\d{1,5}$/.test(s)) return '端口只能是数字（1–65535），留空表示自动分配。';
  const n = Number(s);
  if (n < 1 || n > 65535) return '端口要在 1–65535 之间（留空表示自动分配）。';
  if (n === CLIENT_PAGE_PORT) return `端口 ${CLIENT_PAGE_PORT} 被客户端自己的页面占用，请换一个。`;
  return null;
}

/**
 * The port to hand to the shell: 0 means "let the OS pick" (the field was left empty).
 * @param {string|number|null|undefined} raw
 * @returns {number}
 */
export function hostPortValue(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 0;
}

/**
 * The built-in entry: a server the player runs themselves (`npm start` in the game repo). The official remote
 * server is gone; the address the payload was built for (runtime-config.js) is added by the picker itself.
 */
export const BUILTIN_SERVERS = Object.freeze([
  { address: 'localhost:3000', label: '本机 / 局域网', note: '自己开的服务器' },
]);

/** Android WebView (Capacitor) — no F2 there, so the picker is the only way to switch servers. */
export function isAndroidUA(ua) {
  return /Android/i.test(String(ua ?? ''));
}

/**
 * Is the "remember and go straight in" preference on? Unstored defaults to on for desktop shells (they can reopen
 * the picker with F2 / --choose-server) and off on Android.
 * @param {string|null|undefined} setting stored value ('1' | '0' | null when never set)
 * @param {boolean} android
 */
export function autostartOn(setting, android) {
  return setting === null || setting === undefined ? !android : setting !== '0';
}

/**
 * Should the picker cover the boot screen this launch?
 * `chosenThisSession` also covers the reload that follows a choice (which keeps ?pick=1), so --choose-server shows
 * the picker once per launch instead of once per reload.
 * @param {{ forced: boolean, chosenThisSession: boolean, savedAddress: string|null, autostart: boolean }} state
 */
export function shouldShowPicker(state) {
  const { forced, chosenThisSession, savedAddress, autostart } = state || {};
  if (chosenThisSession) return false;
  return !!forced || !savedAddress || !autostart;
}

/**
 * Parse the stored custom-server list (JSON) into `{ name, address }` entries. Accepts the legacy shape too (an
 * array of bare address strings, from before the picker knew about names), so an existing install keeps its list.
 * @param {string|null|undefined} json
 * @returns {{ name: string, address: string }[]}
 */
export function customFrom(json) {
  try {
    const v = JSON.parse(json || '[]');
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const e of v) {
      if (typeof e === 'string' && e.trim()) out.push({ name: '', address: e.trim() });
      else if (e && typeof e === 'object' && typeof e.address === 'string' && e.address.trim()) {
        out.push({ name: typeof e.name === 'string' ? e.name.trim() : '', address: e.address.trim() });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** What to show for a saved server: the typed name, falling back to its address when the name was left blank. */
export function serverName(entry) {
  const name = String(entry?.name ?? '').trim();
  return name || String(entry?.address ?? '').trim();
}

/** Normalise a typed server name for storage (trimmed, capped to NAME_MAX). */
export function cleanName(raw) {
  return String(raw ?? '').trim().slice(0, NAME_MAX);
}

/**
 * Is the ws/wss guess for this typed address genuinely ambiguous? A scheme-less address with an explicit port is
 * the case the player cannot be expected to get right (a self-hosted server on a public IP wants plain `ws://`,
 * a TLS reverse proxy on an odd port wants `wss://`), so the picker probes both. Addresses that already carry a
 * scheme, and bare host names with no port, are decided by the normalisation alone.
 * @param {string} raw
 */
export function ambiguousScheme(raw) {
  const s = String(raw ?? '').trim();
  if (!s || /^(wss?|https?):\/\//i.test(s)) return false;
  return /^(?:\[[^\]]*\]|[^/?#:]+):\d+(?:[/?#]|$)/.test(s);
}

/**
 * Light validation of a typed address: optional scheme + host[:port] + optional path, nothing else. Normalisation
 * (ws/wss, default path) is public/js/net.js's toWsUrl; this only rejects things that are obviously not an address.
 * @returns {string|null} an error message, or null when the address looks usable
 */
export function addressError(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '请输入服务器地址。';
  if (/\s/.test(s)) return '地址里不能有空格。';
  const rest = s.replace(/^(wss?|https?):\/\//i, '');
  if (!/^[A-Za-z0-9.\-\[\]:]+(\/[A-Za-z0-9._\-/]*)?$/.test(rest)) return '地址无法识别，试试 host:port 的形式（如 192.168.1.9:3000）。';
  if (/^[.:]/.test(rest) || rest.includes('..')) return '地址无法识别，检查一下主机名。';
  return null;
}

// ---- version probe ---------------------------------------------------------------------------------------------

/**
 * The throwaway `hello` the picker sends to learn a server's wire version — the client is bundled with its own game
 * code, so this is the only thing a server has to agree on. Every real server runs `PROTOCOL_VERSION >= 1`, so a
 * `version: 0` hello always lands on server/net.js's mismatch branch, which answers
 * `error.detail = "version mismatch: server N"` *before* it validates the name or creates a session — the probe
 * therefore never shows up as an online player.
 */
export const PROBE_HELLO = Object.freeze({ t: 'hello', name: 'sp-probe', version: 0 });

/**
 * Read a server's wire version out of its first reply to PROBE_HELLO. A mismatched server answers with the number in
 * the error detail; a matching one answers `welcome` (only reachable if a server ever runs protocol 0).
 * @param {unknown} msg decoded JSON frame
 * @returns {number|null} the server's PROTOCOL_VERSION, or null when the frame carries none
 */
export function parseProbeReply(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.t === 'welcome') return Number.isInteger(msg.version) ? msg.version : null;
  const detail = msg.t === 'error' && typeof msg.detail === 'string' ? msg.detail : '';
  const m = /version mismatch:\s*server\s+(\d+)/i.exec(detail);
  return m ? Number(m[1]) : null;
}

/**
 * Can this client talk to a server that speaks `serverProtocol`? The wire number is the gate (server/net.js), so a
 * differing release version is irrelevant while the protocol matches.
 * @param {number} clientProtocol @param {number|null} serverProtocol
 * @returns {'ok'|'mismatch'|'unknown'}
 */
export function versionVerdict(clientProtocol, serverProtocol) {
  if (!Number.isInteger(serverProtocol)) return 'unknown';
  return serverProtocol === clientProtocol ? 'ok' : 'mismatch';
}

/**
 * Short row label for a probed server, or null when nothing was learned.
 * @param {number} clientProtocol @param {number|null} serverProtocol
 * @returns {string|null}
 */
export function versionLabel(clientProtocol, serverProtocol) {
  const verdict = versionVerdict(clientProtocol, serverProtocol);
  if (verdict === 'unknown') return null;
  return verdict === 'ok' ? `协议 v${serverProtocol}` : `协议 v${serverProtocol} · 需 v${clientProtocol}`;
}

/**
 * Why a mismatched server cannot be entered (shown when the player tries). Assumes a known mismatch.
 * @param {number} clientProtocol @param {number} serverProtocol
 */
export function versionMismatchHint(clientProtocol, serverProtocol) {
  return `服务器协议 v${serverProtocol}，本机客户端 v${clientProtocol} —— 无法联机。请让服务器升级到兼容版本，或换一台服务器。`;
}

// ---- update check ----------------------------------------------------------------------------------------------

/**
 * The shape of the published feed (build/dist/latest.json, written by tools/package-release.mjs and uploaded to
 * GitHub Releases by tools/publish-release.mjs — docs/PACKAGING.md §10). A client refuses anything else.
 */
export const FEED_SCHEMA = 1;

/** Longest strings taken from the feed: it is somebody else's JSON, so nothing unbounded reaches the UI. */
const FEED_TEXT_MAX = 64;
const FEED_NOTES_MAX = 240;
/** A feed is a few hundred bytes; anything larger is a redirect to an HTML page or a hostile server. */
export const FEED_MAX_BYTES = 64 * 1024;
/** Feed requests get their own timeout: an update check must never be the reason a screen feels stuck. */
export const FEED_TIMEOUT_MS = 6000;
/** sha256 of an artifact: 64 lowercase hex characters. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Trimmed string from untrusted JSON, capped, or null when there is nothing usable. */
function feedText(value, max = FEED_TEXT_MAX) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Is this URL one the client may fetch or hand to the system downloader? https anywhere; http only on this machine,
 * so a locally served test feed works while a tampered feed cannot point the client at a plaintext download.
 * @param {unknown} url
 * @returns {boolean}
 */
export function updateUrlOk(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:') return false;
  return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
}

/** One artifact of the feed: `{ name, url, sha256, size }`, or null when it is missing or not verifiable. */
function feedAsset(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = feedText(raw.url, 512);
  const sha256 = feedText(raw.sha256, 64)?.toLowerCase() ?? '';
  const size = Number(raw.size);
  // Without a url there is nothing to fetch; without a sha256 there is nothing to verify what was fetched.
  if (!url || !updateUrlOk(url) || !SHA256_RE.test(sha256) || !Number.isFinite(size) || size <= 0) return null;
  const name = feedText(raw.name, 128) ?? decodeURIComponent(url.split('/').pop() || '') ?? '';
  return { name, url, sha256, size: Math.round(size) };
}

/**
 * Read the published feed. Anything unexpected — a captive-portal HTML page, a truncated download, a schema from the
 * future, a feed with no usable artifacts — reads as null: "no update information", never a crash and never a bogus
 * "new version" prompt.
 * @param {unknown} raw parsed JSON (or the response text)
 * @returns {{version: string, build: number, versionCode: number|null, commit: string, notes: string,
 *            publishedAt: string, win: object|null, android: object|null}|null}
 */
export function parseLatestFeed(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    if (raw.length > FEED_MAX_BYTES) return null;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (Number(data.schema) !== FEED_SCHEMA) return null;
  const build = Number(data.build);
  if (!Number.isInteger(build) || build < 1) return null;
  const versionCode = Number(data.versionCode);
  const feed = {
    version: feedText(data.version) ?? '',
    build,
    versionCode: Number.isInteger(versionCode) && versionCode > 0 ? versionCode : null,
    commit: feedText(data.gameCommit) ?? '',
    notes: feedText(data.notes, FEED_NOTES_MAX) ?? '',
    publishedAt: feedText(data.publishedAt) ?? '',
    win: feedAsset(data.win),
    android: feedAsset(data.android),
  };
  return feed.win || feed.android ? feed : null;
}

/**
 * Does the feed offer something newer than what this client already is?
 *
 * `build` is this repo's own counter (release.json, rising by one per release — tools/release-meta.mjs), which is
 * the only thing that can distinguish two builds of the same game version; `versionCode` is the same number packed
 * for Android and only breaks a tie (a feed published before the counter existed).
 *
 * `local` is what /build.json says this client is: null when it could not be read at all (then this stays quiet —
 * offering a download that might be *older* than what the player runs is worse than offering none), and
 * `{ build: 0 }` for a payload built before the counter existed (or in a fork), which anything published beats.
 * @param {{build?: number, versionCode?: number}|null} local
 * @param {{build?: number, versionCode?: number}|null} remote the published feed
 * @returns {'newer'|'same'|'older'|'unknown'}
 */
export function updateVerdict(local, remote) {
  const rb = Number(remote?.build);
  if (!Number.isInteger(rb) || rb < 1) return 'unknown';
  if (local == null) return 'unknown';
  const lb = Number(local.build);
  if (!Number.isInteger(lb) || lb < 0) return 'unknown';
  if (lb === 0) return 'newer';
  if (rb !== lb) return rb > lb ? 'newer' : 'older';
  const lv = Number(local.versionCode);
  const rv = Number(remote?.versionCode);
  if (Number.isInteger(lv) && Number.isInteger(rv) && lv !== rv) return rv > lv ? 'newer' : 'older';
  return 'same';
}

/** Which artifact this shell installs: the phone takes the APK, everything else the desktop build. */
export function updatePlatform(ua) {
  return isAndroidUA(ua) ? 'android' : 'win';
}

/**
 * The artifact of the feed this shell would install, or null when the feed has none for it.
 * @param {object|null} feed @param {'android'|'win'} platform
 */
export function updateAsset(feed, platform) {
  const asset = platform === 'android' ? feed?.android : feed?.win;
  return asset ?? null;
}

/**
 * One line describing what is offered ("0.1.3 · build 12 · 6471511 · 下载 217.2 MB") — enough to decide without
 * opening anything.
 * @param {object|null} feed @param {'android'|'win'} platform
 */
export function updateLabel(feed, platform) {
  if (!feed) return '';
  const bits = [];
  if (feed.version) bits.push(feed.version);
  if (Number.isInteger(feed.build)) bits.push(`build ${feed.build}`);
  if (feed.commit) bits.push(feed.commit.slice(0, 8));
  const asset = updateAsset(feed, platform);
  if (asset) bits.push(`下载 ${(asset.size / 1048576).toFixed(1)} MB`);
  return bits.join(' · ');
}
