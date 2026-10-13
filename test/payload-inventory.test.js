// The 清单 (inventory) and the 体积报告 built from it: the data an incremental update is made of.
//
// Two things have to hold for the delta machinery (Android overlay + in-app update) to be safe:
//   * an inventory must describe a tree *exactly* — it is the only thing standing between a client and "your files
//     are stale but I will not tell you which";
//   * a malformed or missing base inventory must fail loudly. A silently empty diff would publish a "0 MB update"
//     that leaves a client broken, which is worse than no update at all.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  INVENTORY_FILE, INVENTORY_SCHEMA, buildInventory, diffInventory, findBaseInventory, human, inventoryReport,
  readInventory, walkFiles, writeInventory,
} from '../tools/payload-inventory.mjs';
import { sha256File, buildLatestFeed } from '../tools/release-meta.mjs';

/** A throwaway tree; `files` maps relative path → contents. */
function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-inv-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

describe('the 清单', () => {
  test('lists every file with its size and hash, sorted and deterministic', () => {
    const dir = tree({ 'index.html': '<html>', 'js/a.js': 'a', 'js/b.js': 'b', 'assets/x/y.png': 'png' });
    try {
      const inv = buildInventory(dir, { version: '0.2.5', build: 6 });
      assert.equal(inv.schema, INVENTORY_SCHEMA);
      assert.equal(inv.version, '0.2.5');
      assert.equal(inv.build, 6);
      assert.deepEqual(Object.keys(inv.files), ['assets/x/y.png', 'index.html', 'js/a.js', 'js/b.js'], 'sorted, `/` separators');
      assert.deepEqual(inv.files['js/a.js'], [1, sha256File(path.join(dir, 'js', 'a.js'))]);
      assert.equal(inv.totals.files, 4);
      assert.equal(inv.totals.bytes, 1 + 6 + 1 + 1 + 3 - 1); // <html> 6 + 'a' + 'b' + 'png'
      // the same tree hashes to the same bytes: that is what makes two builds comparable at all
      assert.equal(JSON.stringify(buildInventory(dir, { version: '0.2.5', build: 6 })), JSON.stringify(inv));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('never lists itself, and honours extra exclusions', () => {
    const dir = tree({ 'a.js': 'a' });
    try {
      writeInventory(path.join(dir, INVENTORY_FILE), buildInventory(dir));
      const fresh = buildInventory(dir);
      assert.deepEqual(Object.keys(fresh.files), ['a.js'], 'payload.json cannot carry its own hash');
      assert.deepEqual(Object.keys(buildInventory(dir, { exclude: ['a.js'] }).files), [], 'exclude is relative to the payload root');
      assert.deepEqual(Object.keys(buildInventory(dir, { exclude: ['/a.js'] }).files), [], 'a leading slash is tolerated');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('round-trips, and recomputes its totals instead of trusting them', () => {
    const dir = tree({ 'a.js': 'aaa', 'b/c.js': 'c' });
    try {
      const file = path.join(dir, '..', `inv-${path.basename(dir)}.json`);
      const inv = buildInventory(dir);
      writeInventory(file, inv);
      const back = readInventory(file);
      assert.equal(back.totals.files, 2);
      assert.equal(back.totals.bytes, 4);
      fs.writeFileSync(file, JSON.stringify({ ...inv, totals: { files: 999, bytes: 999 } }));
      assert.equal(readInventory(file).totals.files, 2, 'totals are derived, not read');
      fs.rmSync(file, { force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a missing, malformed or wrong-schema 清单 with an actionable message', () => {
    const dir = tree({ 'a.js': 'a' });
    try {
      const file = path.join(dir, 'inv.json');
      assert.throws(() => readInventory(path.join(dir, 'nope.json')), /读不到清单[\s\S]*payload-<build>\.json/);
      fs.writeFileSync(file, 'not json');
      assert.throws(() => readInventory(file), /不是 JSON/);
      fs.writeFileSync(file, JSON.stringify({ schema: 99, files: {} }));
      assert.throws(() => readInventory(file), /schema 是 99/);
      fs.writeFileSync(file, JSON.stringify({ schema: 1 }));
      assert.throws(() => readInventory(file), /缺 files/);
      fs.writeFileSync(file, JSON.stringify({ schema: 1, files: { 'a.js': 'nope' } }));
      assert.throws(() => readInventory(file), /a\.js 的形状不对/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('walkFiles sorts and uses `/`, so lists are comparable across platforms', () => {
    const dir = tree({ 'b.js': '', 'a/c.js': '', 'a/b.js': '' });
    try {
      assert.deepEqual(walkFiles(dir), ['a/b.js', 'a/c.js', 'b.js']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('diffing two 清单', () => {
  /** The shape diffInventory gets: `{ files: { rel: [size, sha] } }`. */
  const inv = (files) => ({ schema: 1, version: '0.2.5', build: 6, totals: { files: 0, bytes: 0 }, files });

  test('classifies added, changed and removed, with the bytes an update must move', () => {
    const base = inv({ 'same.js': [10, 'h1'], 'edit.js': [10, 'h2'], 'gone.js': [30, 'h3'] });
    const target = inv({ 'same.js': [10, 'h1'], 'edit.js': [12, 'h4'], 'new.js': [100, 'h5'] });
    const d = diffInventory(base, target);
    assert.deepEqual(d.added, [{ path: 'new.js', size: 100 }]);
    assert.deepEqual(d.changed, [{ path: 'edit.js', size: 12 }]);
    assert.deepEqual(d.removed, [{ path: 'gone.js', size: 30 }]);
    assert.equal(d.unchanged, 1);
    assert.equal(d.unchangedBytes, 10);
    assert.equal(d.upload, 112, 'added + changed');
    assert.equal(d.uploadFiles, 2);
    assert.deepEqual(d.bytes, { added: 100, changed: 12, removed: 30 });
  });

  test('a size change alone counts as changed (the hash is not the only truth)', () => {
    const d = diffInventory(inv({ 'a.js': [10, 'h'] }), inv({ 'a.js': [11, 'h'] }));
    assert.deepEqual(d.changed, [{ path: 'a.js', size: 11 }]);
    assert.equal(d.unchanged, 0);
  });

  test('identical trees change nothing — the incremental update is empty, not a full download', () => {
    const files = { 'a.js': [1, 'h'], 'b/c.js': [2, 'h2'] };
    const d = diffInventory(inv(files), inv(files));
    assert.equal(d.upload, 0);
    assert.equal(d.uploadFiles, 0);
    assert.equal(d.unchanged, 2);
    assert.equal(d.total, 0, 'total comes from the target totals');
  });

  test('the baseline is the newest 清单 below this build, never this build or a newer one', () => {
    const dir = tree({
      'payload-4.json': '{}', 'payload-5.json': '{}', 'payload-6.json': '{}', 'payload-7.json': '{}',
      'notes.txt': '', 'payload-x.json': '{}',
    });
    try {
      assert.equal(findBaseInventory(dir, 6).build, 5);
      assert.equal(findBaseInventory(dir, 4), null, 'nothing older than the first build');
      assert.equal(findBaseInventory(dir, 100).build, 7);
      assert.equal(findBaseInventory(tree({}), 6), null, 'a missing directory is not an error');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the 体积报告', () => {
  const inv = {
    schema: 1, version: '0.2.5', build: 6,
    totals: { files: 3, bytes: 3000 },
    files: { 'assets/local/a.png': [1000, 'h1'], 'js/main.js': [1000, 'h2'], 'index.html': [1000, 'h3'] },
  };

  test('reports the full size, the per-directory split and the delta against a base', () => {
    const base = { schema: 1, version: '0.2.4', build: 5, totals: { files: 2, bytes: 2000 }, files: { 'js/main.js': [500, 'old'], 'index.html': [1000, 'h3'] } };
    const diff = diffInventory(base, inv);
    const md = inventoryReport({ inv, diff, baseBuild: 5, baseVersion: '0.2.4', deltaFile: { name: 'delta-5-6.zip', size: 900 } });
    assert.match(md, /# 客户端 payload 体积报告 — 0\.2\.5 \(build 6\)/);
    assert.match(md, /全量：\*\*3\*\* 个文件/);
    assert.match(md, /相对 0\.2\.4 \(build 5\)：新增 1 \/ 修改 1 \/ 删除 0/);
    assert.match(md, /增量包 delta-5-6\.zip：\*\*900 B\*\*/);
    // the directory table is what tells us where the weight is: art vs code
    assert.match(md, /\| `assets` \| 1 \| 1000 B \| 33\.3% \|/);
    assert.match(md, /\| `js` \| 1 \| 1000 B \| 33\.3% \|/);
    assert.match(md, /最大的 15 个新增\/修改文件/);
    assert.match(md, /`assets\/local\/a\.png` \| 新增 \|/);
    assert.match(md, /`js\/main\.js` \| 修改 \|/);
  });

  test('says so when there is no baseline, instead of pretending the delta is zero', () => {
    const md = inventoryReport({ inv, diff: null, baseBuild: null });
    assert.match(md, /没有基准清单/);
    assert.ok(!/相对 .*build \d+：新增/.test(md), 'no invented delta figures');
    assert.ok(!md.includes('增量包 delta-'), 'and nothing about a pack that was not built');
    assert.match(md, /\| `js` \| 1 \| 1000 B \| 33\.3% \|/, 'the full-size part is still there');
  });

  test('human() keeps the numbers readable at every scale', () => {
    assert.equal(human(512), '512 B');
    assert.equal(human(2048), '2.0 KB');
    assert.equal(human(85 * 1048576), '85.0 MB');
    assert.equal(human(3 * 1073741824), '3.00 GB');
  });
});

describe('the feed carries the 清单', () => {
  const base = {
    version: '0.2.5', build: 6, tag: 'v0.2.5-b6', repo: 'o/n', notes: 'n',
    assets: { win: { name: 'win.zip', sha256: 'a'.repeat(64), size: 10 } },
  };

  test('a release with a 清单 names it, sizes it and says which build it diffs from', () => {
    const feed = buildLatestFeed({
      ...base,
      payload: { name: 'payload-6.json', sha256: 'b'.repeat(64), size: 1310720, files: 13524, bytes: 703000000, schema: INVENTORY_SCHEMA },
      baseBuild: 5,
    });
    assert.equal(feed.payload.name, 'payload-6.json');
    assert.equal(feed.payload.url, 'https://github.com/o/n/releases/download/v0.2.5-b6/payload-6.json');
    assert.equal(feed.payload.files, 13524);
    assert.equal(feed.payload.bytes, 703000000);
    assert.equal(feed.payload.schema, INVENTORY_SCHEMA);
    assert.equal(feed.payload.base, 5, 'the build the packager diffed against — a client can tell if the cheap path is open');
    assert.equal(feed.schema, 1, 'the feed schema stays 1: the key is additive, so older clients keep working');
  });

  test('a release without one simply has no key (and publishes no 清单)', () => {
    const feed = buildLatestFeed(base);
    assert.ok(!('payload' in feed));
    assert.equal(feed.win.name, 'win.zip');
  });
});
