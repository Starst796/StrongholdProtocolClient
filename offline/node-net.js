// Browser stand-in for `node:net`, imported (through the payload's import map) by the in-page game server:
// server/net.js only calls `isIP()`, to tell an IPv4 address from an IPv6 one when classifying a client address.
// The in-page server always presents itself as loopback (127.0.0.1), so this only has to be correct for literals.

const V4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * Node's `net.isIP`: 4 for an IPv4 literal, 6 for an IPv6 literal, 0 otherwise.
 * @param {unknown} input
 * @returns {0 | 4 | 6}
 */
export function isIP(input) {
  const s = String(input ?? '');
  if (V4.test(s)) {
    return s.split('.').every((part) => part.length <= 3 && Number(part) >= 0 && Number(part) <= 255) ? 4 : 0;
  }
  if (s.includes(':')) return /^[0-9a-fA-F:.]+$/.test(s) ? 6 : 0;
  return 0;
}
