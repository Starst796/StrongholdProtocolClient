// Pure rules behind the shell server picker (shell/picker.js): when to show it, which addresses to accept, what a
// stored preference means. No DOM, no storage, no imports — so test/picker.test.js can pin the behaviour under
// plain Node. The assembler copies this next to the picker as /js/shell/picker-core.js.

/** localStorage keys (the picker is the only writer). */
export const K_SERVER = 'sp.shell.server';       // last chosen address
export const K_AUTOSTART = 'sp.shell.autostart'; // '1' = skip the picker next launch, '0' = always show
export const K_LIST = 'sp.shell.list';           // user-added servers: JSON [{ name, address }]
export const K_CHOSEN = 'sp.shell.chosen';       // sessionStorage: already entered once in this session

/** Longest stored server name (the picker's "add server" field is capped to this). */
export const NAME_MAX = 32;

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
