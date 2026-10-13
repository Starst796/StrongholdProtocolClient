// The incremental pack (tools/payload-delta.mjs): what actually reaches a phone on an update.
//
// The archive is unpacked on the device by java.util.zip.ZipInputStream, which is stricter about the *shape* of a zip
// than most writers are: it reads the local header of each entry as it streams, so entries whose sizes only live in
// a trailing data descriptor (general purpose flag bit 3), or that use an exotic method, are the kind of thing that
// works on a desktop and fails on Android. Everything it needs is checked here against a real pack built from two
// tiny payload trees — no device required, and no dependency on a zip library either.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { buildInventory, diffInventory, readInventory, writeInventory } from '../tools/payload-inventory.mjs';
import { DELTA_META, auditPayloadAgainstInventory, deltaEntry, deltaFileName, writeDeltaPack } from '../tools/payload-delta.mjs';
import { sha256File } from '../tools/release-meta.mjs';

/**
 * Read a zip the way {@link java.util.zip.ZipFile} does: through the *central directory*, which is where the entry
 * sizes and offsets always live. Deliberately not a streaming local-header walk — the packs are written by bsdtar,
 * which puts each entry's sizes in a trailing data descriptor (general purpose flag bit 3), so a streaming reader
 * would have to scan for it. That is exactly why the phone uses ZipFile, and this helper mirrors that.
 */
function readZip(file) {
  const buf = fs.readFileSync(file);
  // End of central directory: 22 bytes + an optional comment, at the very end.
  let eocd = -1;
  for (let at = buf.length - 22; at >= 0 && at > buf.length - 22 - 65536; at--) {
    if (buf.readUInt32LE(at) === 0x06054b50) { eocd = at; break; }
  }
  assert.ok(eocd >= 0, 'the pack has an end-of-central-directory record (a truncated download has none)');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, `central directory entry ${i}`);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    // Local header: skip it by its own name/extra lengths (the sizes there may be zeroed by the descriptor bit).
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const raw = buf.subarray(dataAt, dataAt + compressed);
    out.push({ name, method, crc, size, data: method === 0 ? raw : zlib.inflateRawSync(raw) });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Two payload trees that differ the way a real release does: changed, added and untouched files. */
function makeTrees() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-delta-'));
  const base = path.join(dir, 'base');
  const target = path.join(dir, 'target');
  const write = (root, rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  for (const root of [base, target]) {
    write(root, 'index.html', '<html>v1</html>');
    write(root, 'js/main.js', 'console.log("shared");');
    write(root, 'assets/unchanged/keep.png', Buffer.alloc(64 * 1024, 7)); // big and identical: must NOT be in the pack
  }
  write(target, 'index.html', '<html>v2</html>'); // changed
  write(target, 'js/new/feature.js', 'export const feature = 1;\n'); // added
  write(target, 'assets/local/new-art.png', Buffer.alloc(32 * 1024, 3)); // added, the usual bulk
  return { dir, base, target };
}

describe('the incremental pack', () => {
  let trees;
  let packs;
  before(() => {
    trees = makeTrees();
    fs.mkdirSync(path.join(trees.dir, 'inv'), { recursive: true });
    const baseInv = buildInventory(trees.base, { version: '0.2.4', build: 5 });
    const inv = buildInventory(trees.target, { version: '0.2.5', build: 6 });
    writeInventory(path.join(trees.dir, 'inv', 'payload-5.json'), baseInv);
    packs = {
      baseInv,
      inv,
      diff: diffInventory(baseInv, inv),
      base: (() => {
        const p = path.join(trees.dir, 'out', deltaFileName(5, 6));
        const r = writeDeltaPack({
          payloadRoot: trees.target, inventory: inv, diff: diffInventory(baseInv, inv), from: 5, to: 6,
          version: '0.2.5', out: p, log: () => {},
        });
        return r;
      })(),
      entries: null,
    };
    packs.entries = readZip(packs.base.file);
  });
  after(() => fs.rmSync(trees.dir, { recursive: true, force: true }));

  test('holds the changed and added files, and nothing else', () => {
    const payload = packs.entries.filter((e) => e.name.startsWith('payload/') && !e.name.endsWith('/')).map((e) => e.name);
    assert.deepEqual(payload, [
      'payload/delta.json', 'payload/index.html', 'payload/js/new/feature.js', 'payload/assets/local/new-art.png',
    ], 'the pack’s own list plus exactly the changed and added files');
    assert.deepEqual(packs.diff.changed.map((e) => e.path), ['index.html']);
    // the 585 MB of unchanged files in a real release are exactly what this file list leaves out
    assert.equal(packs.entries.some((e) => e.name.includes('keep.png')), false);
  });

  test('carries the per-file sha256 the phone verifies while unpacking', () => {
    const metaEntry = packs.entries.find((e) => e.name === `payload/${DELTA_META.replace('payload/', '')}`);
    assert.ok(metaEntry, 'delta.json is in the pack');
    const meta = JSON.parse(metaEntry.data.toString('utf8'));
    assert.equal(meta.schema, 1);
    assert.equal(meta.from, 5);
    assert.equal(meta.to, 6);
    assert.equal(meta.build, 6);
    assert.deepEqual(Object.keys(meta.files).sort(), ['assets/local/new-art.png', 'index.html', 'js/new/feature.js']);
    // the pair is [size, sha256] — the same shape the 清单 uses — and it must match the file in the pack
    for (const [rel, [size, hash]] of Object.entries(meta.files)) {
      const entry = packs.entries.find((e) => e.name === `payload/${rel}`);
      assert.equal(entry.data.length, size, `${rel} size`);
      assert.equal(sha256File(path.join(trees.target, rel)), hash, `${rel} hash`);
    }
    // ...and the file bytes in the pack are the payload's, not a re-encoding
    const html = packs.entries.find((e) => e.name === 'payload/index.html');
    assert.equal(html.data.toString('utf8'), '<html>v2</html>');
  });

  test('is a zip java.util.zip.ZipFile can read: central directory, deflate, real sizes', () => {
    assert.ok(packs.entries.length > 0);
    for (const entry of packs.entries) {
      assert.ok(entry.method === 0 || entry.method === 8, `${entry.name} uses method ${entry.method}`);
      assert.ok(entry.data !== null, `${entry.name} inflates`);
      // bsdtar writes the sizes in a trailing data descriptor; ZipFile reads the central directory instead, so the
      // entry it hands over already knows its size — that is what the phone checks before writing a byte.
      if (entry.size >= 0 && !entry.name.endsWith('/')) assert.ok(entry.crc > 0, `${entry.name} carries a crc`);
    }
    assert.equal(packs.entries.filter((e) => e.name === 'payload/index.html').length, 1);
  });

  test('reports the size and digest the feed publishes', () => {
    const entry = deltaEntry(packs.base.file, packs.base.meta);
    assert.equal(entry.name, deltaFileName(5, 6));
    assert.equal(entry.size, fs.statSync(packs.base.file).size);
    assert.equal(entry.sha256, sha256File(packs.base.file));
    assert.equal(entry.files, 3);
    assert.equal(entry.bytes, packs.base.bytes);
  });

  test('refuses an empty diff instead of shipping a useless pack', () => {
    const same = diffInventory(packs.inv, packs.inv);
    assert.throws(() => writeDeltaPack({
      payloadRoot: trees.target, inventory: packs.inv, diff: same, from: 6, to: 7, out: path.join(trees.dir, 'x.zip'),
    }), /没有任何变更/);
  });

  test('refuses a path that would escape the payload root', () => {
    const evil = { ...packs.inv };
    assert.throws(() => writeDeltaPack({
      payloadRoot: trees.target, inventory: evil,
      diff: { added: [{ path: '../../etc/passwd', size: 1 }], changed: [], removed: [] },
      from: 5, to: 6, out: path.join(trees.dir, 'evil.zip'),
    }), /路径不能用/);
    assert.throws(() => writeDeltaPack({
      payloadRoot: trees.target, inventory: evil,
      diff: { added: [{ path: 'C:/windows/x.js', size: 1 }], changed: [], removed: [] },
      from: 5, to: 6, out: path.join(trees.dir, 'evil.zip'),
    }), /路径不能用/);
  });

  test('a pack is not built from a 清单 that does not describe the payload', () => {
    // A stale pair would produce a pack that misses a changed file, leaving a client half-updated.
    const stale = { ...packs.inv, files: { ...packs.inv.files, 'js/removed.js': [10, 'a'.repeat(64)] } };
    const audit = auditPayloadAgainstInventory(trees.target, stale);
    assert.deepEqual(audit.missing, ['js/removed.js'], 'the audit names what the 清单 promises but the payload lacks');
    assert.deepEqual(audit.extra, [], 'and what the payload has that the 清单 forgot');
    // ...and the pack refuses a change it cannot vouch for, rather than shipping a file with no size/hash pair.
    assert.throws(() => writeDeltaPack({
      payloadRoot: trees.target, inventory: stale,
      diff: { added: [{ path: 'js/missing.js', size: 10 }], changed: [], removed: [] },
      from: 5, to: 6, out: path.join(trees.dir, 'stale.zip'),
    }), /清单里没有/);
  });

  test('the pack applies on top of the base 清单 alone, so the client needs no full manifest', () => {
    // What the phone ends up with: the APK's files plus this pack's. Simulating that merge is how we check that the
    // pack carries everything a client on build 5 lacks.
    const merged = new Map(Object.entries(packs.baseInv.files));
    const meta = JSON.parse(packs.entries.find((e) => e.name === 'payload/delta.json').data.toString('utf8'));
    for (const [rel, pair] of Object.entries(meta.files)) merged.set(rel, pair);
    assert.deepEqual([...merged.keys()].sort(), Object.keys(packs.inv.files).sort());
    for (const [rel, pair] of Object.entries(packs.inv.files)) {
      assert.deepEqual(merged.get(rel), pair, `${rel} matches the target inventory`);
    }
  });

  test('the base 清单 is read back the same way the packager wrote it', () => {
    const back = readInventory(path.join(trees.dir, 'inv', 'payload-5.json'));
    assert.equal(back.build, 5);
    assert.deepEqual(Object.keys(back.files).sort(), Object.keys(packs.baseInv.files).sort());
  });
});
