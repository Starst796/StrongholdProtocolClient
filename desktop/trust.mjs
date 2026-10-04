// Trust-on-first-use store for the desktop shell: which (server, certificate) pairs the player has accepted.
//
// A packaged client talks to whatever server the player runs, and a self-hosted one very often sits behind a tunnel
// or reverse proxy with a self-signed certificate (SakuraFrp's "automatic TLS" is one) — Chromium refuses those with
// ERR_CERT_AUTHORITY_INVALID. Rather than verifying nothing, the shell asks once per server and remembers the exact
// certificate it showed, so:
//
//   * every other server, and every other request, is still verified normally;
//   * a *changed* certificate (a different fingerprint) asks again instead of being waved through.
//
// Pure logic plus a small JSON file — no Electron import — so test/trust.test.js can pin it under plain Node.
// The Android shell keeps the same policy in TrustedCerts.java / MainActivity.java (see docs/PACKAGING.md §5).

import fs from 'node:fs';

/** `wss://frp-boy.com:60751/ws` → `frp-boy.com:60751`: keyed on the host only, so every request to it is covered. */
export function hostKey(url) {
  try {
    return String(new URL(url).host || '').toLowerCase();
  } catch {
    return '';
  }
}

/** Electron's Certificate → its lower-cased SHA-256 fingerprint ('' when the platform gave us none). */
export function fingerprintOf(certificate) {
  return String(certificate?.fingerprint256 || certificate?.fingerprint || '').trim().toLowerCase();
}

/**
 * Shorten a fingerprint for the dialog. Electron hands out `sha256/<base64>`, Android's shell formats the digest as
 * `AA:BB:…` — both are shortened here so the prompt stays readable either way.
 */
export function shortFingerprint(fp) {
  const s = String(fp ?? '');
  if (!s) return '';
  if (s.includes(':')) {
    const parts = s.split(':').filter(Boolean);
    return parts.length < 8 ? s : [...parts.slice(0, 3), '…', ...parts.slice(-3)].join(':');
  }
  const m = /^((?:sha\d+)\/)(.+)$/i.exec(s);
  return m && m[2].length > 14 ? `${m[1]}${m[2].slice(0, 6)}…${m[2].slice(-6)}` : s;
}

/** Load the persisted `{ host: fingerprint }` map; a missing or corrupt file means "nothing trusted yet". */
export function loadTrusted(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function saveTrusted(file, map) {
  try {
    fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
  } catch { /* a read-only profile must not break the game */ }
}

/** Is this exact certificate already trusted for this host? (A new fingerprint is a new question.) */
export function isTrusted(map, host, fp) {
  return !!host && !!fp && map?.[host] === fp;
}

/** Remember it, returning a new map so callers can persist it. */
export function remember(map, host, fp) {
  return { ...map, [host]: fp };
}

/** What the prompt shows about the certificate (Electron's Certificate exposes these as strings). */
export function describeCertificate(certificate) {
  return {
    subject: String(certificate?.subjectName || '(未知)'),
    issuer: String(certificate?.issuerName || '(未知)'),
    validFrom: Number(certificate?.validStart || 0),
    validTo: Number(certificate?.validExpiry || 0),
  };
}
