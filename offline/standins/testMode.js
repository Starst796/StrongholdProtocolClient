// Payload stand-in for server/testMode.js — shipped to `server/testMode.js` by tools/package-client.mjs.
//
// Why a stand-in at all: 0.3.1 added `server/testMode.js` (whether this process may open test rooms) and
// server/lobby.js imports it at the top of the module. The real file reads `os.networkInterfaces()` and imports
// server/plugins/trusted.js (node:fs), and neither a browser nor a WebView has them — the in-page server would fail
// to load, offline single-player included. The module is otherwise pure: everything below except
// `interfacesArePrivate`'s interface snapshot is the game's own logic, copied verbatim from 0.3.3.
//
// What changes, and why it cannot matter for a client:
//   * `interfacesArePrivate` answers false when no snapshot is supplied (the game does the same when the read
//     throws); a packaged client cannot read the machine's interfaces from the page, and failing closed is exactly
//     the gate's contract for "unknown".
//   * `isUnspecifiedAddress` / `trustedHostAllowed` are inlined from server/plugins/trusted.js (pure functions, no
//     fs) instead of importing that Node-only module.
// A test room therefore can never open from the page's own server. The desktop shell runs the real module from its
// verbatim server tree (tools/server-tree.mjs → resources/srv), so `SP_TEST_MODE` still behaves there.

import { isIP } from 'node:net';
import { isLocalIp, normalizeIp } from './net.js';

const LOCAL = new Set(['1', 'true', 'yes', 'on', 'local']);
const SILENT_OFF = new Set(['', '0', 'off', 'false', 'no']);

/** Printed when `1` is refused. The launcher and the server log share this text. */
export const TEST_MODE_PUBLIC_HINT =
  '测试模式 1 未开启：监听地址是公网，或这台机器有公网地址。仅本机请用 --host 127.0.0.1；局域网请用 --host <局域网IP>；要在公网监听上开启请用 --test-mode force（或 SP_TEST_MODE=force）。'; // i18n-ignore: operator console text (launcher and server log), not UI

/** Printed when SP_TEST_MODE is a word this process does not know. Test rooms stay off. */
export const TEST_MODE_UNKNOWN_HINT =
  '未识别的 SP_TEST_MODE，测试房间保持关闭。可用的值：off、1、force。'; // i18n-ignore: operator console text (launcher and server log), not UI

/** Printed when force opens test rooms on a public or wildcard listener. Same hint style as TEST_MODE_PUBLIC_HINT. */
export const TEST_MODE_FORCE_HINT =
  '测试模式 force 已在公网或通配监听上开启测试房间（--test-mode force 或 SP_TEST_MODE=force）。环回地址前面的反向代理仍然是公网部署。'; // i18n-ignore: operator console text (launcher and server log), not UI

/** @param {unknown} raw @returns {'off'|'local'|'force'} */
export function parseTestModeEnv(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'force') return 'force';
  if (LOCAL.has(s)) return 'local';
  return 'off';
}

/**
 * A word that is not a known mode and not a silent off. null when there is nothing to warn about.
 * @param {unknown} raw the SP_TEST_MODE value before parseTestModeEnv
 * @returns {string|null}
 */
export function unrecognizedTestMode(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (SILENT_OFF.has(s) || s === 'force' || LOCAL.has(s)) return null;
  return TEST_MODE_UNKNOWN_HINT;
}

/** Parse literals first; normalizeIp expands IPv4-mapped IPv6 and strips the zone id. */
function listeningIp(host) { return isIP(host) ? normalizeIp(host) : ''; }

/** [ASSUMED] All of IPv4 0/8 and every spelling of IPv6 zero are unspecified for this gate. */
export function isUnspecifiedAddress(host) {
  const ip = listeningIp(host);
  if (isIP(ip) === 4) return Number(ip.split('.')[0]) === 0;
  // Empty groups in a valid IPv6 literal are compressed zeros; a dotted tail is also numeric.
  return isIP(ip) === 6 && ip.split(':').every((g) => !g || (g.includes('.')
    ? g.split('.').every((n) => Number(n) === 0) : parseInt(g, 16) === 0));
}

/** A local (or loopback) listening address; `trusted-force` permits anything. */
export const trustedHostAllowed = (host, mode) => mode === 'trusted-force'
  || (isLocalIp(listeningIp(host)) && !isUnspecifiedAddress(host));

/**
 * True when every non-internal address is local (or there is none). False when any is public or the snapshot cannot
 * be read — and, in a browser, when no snapshot was supplied: a page cannot enumerate the machine's interfaces.
 * @param {NodeJS.Dict<any[]>|null|undefined} [interfaces]
 */
export function interfacesArePrivate(interfaces) {
  const snapshot = interfaces;
  if (snapshot == null || typeof snapshot !== 'object') return false;
  try {
    for (const list of Object.values(snapshot)) {
      if (!Array.isArray(list)) continue;
      for (const info of list) {
        if (!info || info.internal) continue;
        const ip = normalizeIp(typeof info.address === 'string' ? info.address : '');
        if (!ip) continue;
        if (!isLocalIp(ip)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {'off'|'local'|'force'|string} mode
 * @param {string} host the bound address (empty until listen)
 * @param {NodeJS.Dict<any[]>|null} [interfaces] test snapshot; omitted reads the machine
 * @returns {{ enabled: boolean, warn: string|null }}
 */
export function testModeGate(mode, host, interfaces) {
  const m = mode === 'force' || mode === 'local' ? mode : 'off';
  if (m === 'off') return { enabled: false, warn: null };
  const known = typeof host === 'string' && isIP(host) !== 0;
  if (!known) return { enabled: false, warn: null };
  let local = trustedHostAllowed(host, 'trusted');
  if (!local && isUnspecifiedAddress(host)) local = interfacesArePrivate(interfaces);
  if (m === 'local' && !local) return { enabled: false, warn: TEST_MODE_PUBLIC_HINT };
  if (m === 'force' && !local) {
    return {
      enabled: true,
      warn: TEST_MODE_FORCE_HINT,
    };
  }
  return { enabled: true, warn: null };
}
