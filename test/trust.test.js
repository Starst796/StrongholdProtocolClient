// The desktop shell's TLS trust policy (desktop/trust.mjs): which (server, certificate) pairs count as accepted.
// Kept dependency-free (no Electron, no DOM) so `node --test` can pin it straight from a fresh clone — the dialog
// around it needs a window, but the decision it hands to Electron must not silently drift.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  describeCertificate, fingerprintOf, hostKey, isTrusted, loadTrusted, remember, saveTrusted, shortFingerprint,
} from '../desktop/trust.mjs';

describe('TLS trust store', () => {
  let dir;
  before(() => { dir = mkdtempSync(path.join(tmpdir(), 'sp-trust-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('the key is the host (with port), so one decision covers every request to that server', () => {
    assert.equal(hostKey('wss://frp-boy.com:60751/ws'), 'frp-boy.com:60751');
    assert.equal(hostKey('https://FRP-Boy.com/healthz'), 'frp-boy.com');
    assert.equal(hostKey('ws://192.168.1.9:3000/ws'), '192.168.1.9:3000');
    assert.equal(hostKey('nonsense'), '');
    assert.equal(hostKey(undefined), '');
  });

  test('the fingerprint prefers SHA-256 and is compared case-insensitively', () => {
    assert.equal(fingerprintOf({ fingerprint256: 'AA:BB:CC' }), 'aa:bb:cc');
    assert.equal(fingerprintOf({ fingerprint: 'AA:BB', fingerprint256: 'CC:DD' }), 'cc:dd');
    assert.equal(fingerprintOf({ fingerprint: 'AA:BB' }), 'aa:bb');
    assert.equal(fingerprintOf(null), '');
  });

  test('a long fingerprint is shortened for the dialog, in either format, and a short one is left alone', () => {
    const hex = Array.from({ length: 32 }, (_, i) => String(i).padStart(2, '0')).join(':');
    assert.equal(shortFingerprint(hex), '00:01:02:…:29:30:31');
    assert.equal(shortFingerprint('AA:BB'), 'AA:BB');
    assert.equal(shortFingerprint('sha256/fdkudkl+/siw3dqxuf4kwia/dncftep4mi381oi80gi='), 'sha256/fdkudk…i80gi=');
    assert.equal(shortFingerprint('sha256/short'), 'sha256/short');
    assert.equal(shortFingerprint(''), '');
  });

  test('a decision only covers that exact certificate — a changed one is a new question', () => {
    const map = remember({}, 'frp-boy.com:60751', 'aa:bb');
    assert.equal(isTrusted(map, 'frp-boy.com:60751', 'aa:bb'), true);
    assert.equal(isTrusted(map, 'frp-boy.com:60751', 'cc:dd'), false, 'rotated certificate asks again');
    assert.equal(isTrusted(map, 'other.example', 'aa:bb'), false, 'another host is another question');
    assert.equal(isTrusted(map, 'frp-boy.com:60751', ''), false);
    assert.equal(isTrusted({}, 'frp-boy.com:60751', 'aa:bb'), false);
  });

  test('remember returns a new map (callers persist what they get back)', () => {
    const before = { a: '1' };
    const after = remember(before, 'b', '2');
    assert.deepEqual(before, { a: '1' });
    assert.deepEqual(after, { a: '1', b: '2' });
  });

  test('the store is a JSON file, and anything unreadable means "nothing trusted yet"', () => {
    const file = path.join(dir, 'trusted-certs.json');
    assert.deepEqual(loadTrusted(file), {}, 'missing file');
    saveTrusted(file, { 'frp-boy.com:60751': 'aa:bb' });
    assert.deepEqual(loadTrusted(file), { 'frp-boy.com:60751': 'aa:bb' }, 'round trip');
    writeFileSync(file, 'not json');
    assert.deepEqual(loadTrusted(file), {});
    writeFileSync(file, '["array"]');
    assert.deepEqual(loadTrusted(file), {}, 'an array is not a store');
  });

  test('the prompt text falls back when the platform reports no names', () => {
    assert.deepEqual(describeCertificate(null), { subject: '(未知)', issuer: '(未知)', validFrom: 0, validTo: 0 });
    assert.equal(describeCertificate({ subjectName: 'CN=x', issuerName: 'CN=y' }).subject, 'CN=x');
  });
});
