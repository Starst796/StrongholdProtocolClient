// The incremental pack: only the files that changed between two payload builds, as one zip.
//
// The 清单 (tools/payload-inventory.mjs) tells us *what* changed; this turns "what changed" into something a client
// can fetch: 0.2.4 → 0.2.5 was 1824 files / 85.0 MB, against a 670.9 MB payload. That is the difference between a
// player waiting ~7 minutes on a phone and waiting ~40.
//
// Shape of the archive (an Android client unpacks it with java.util.zip, so: plain deflate, no encryption, no
// data descriptors to worry about):
//
//   payload/<every added or changed file, at its payload-relative path>
//   payload/delta.json    { schema, from, to, version, build, files: { path: [size, sha256] } }
//
// `files` is the same `[size, sha256]` pair the 清单 uses, holding only the entries in this pack — the unpacker
// verifies every file against it before the overlay goes live, which is what makes an interrupted download
// harmless. The client also downloads `payload-<build>.json` (the full 清单); that is what it keeps as its own new
// inventory, so this pack does not need to carry the unchanged entries.
//
// Why one pack per release, diffed against the immediately previous build: the client must be *on* the base build
// for the pack to apply. Anything else (an older build, an APK installed from elsewhere, a broken overlay) falls
// back to the full installer — never to a partial file set the client cannot verify.

import fs from 'node:fs';
import path from 'node:path';
import { INVENTORY_SCHEMA, walkFiles } from './payload-inventory.mjs';
import { sha256File } from './release-meta.mjs';
import { zipDir } from './zip.mjs';

/** Where the delta's own bookkeeping file sits inside the archive. */
export const DELTA_META = 'delta.json';
/** Release-asset name: which builds the pack goes between, so a feed's `delta.base` is visible in the file name. */
export function deltaFileName(from, to) {
  return `delta-${from}-${to}.zip`;
}

/**
 * Build the pack for `diff` out of the *target* payload tree.
 *
 * The changed files are hard-linked into a staging directory (instant, same volume) and the whole directory is zipped
 * once — no per-file archiving, no 85 MB copy, and the archive keeps the payload layout the client expects.
 *
 * @param {{ payloadRoot: string, inventory: object, diff: object, from: number, to: number, version?: string,
 *   out: string, log?: (...a: any[]) => void }} o
 * @returns {{ file: string, size: number, files: number, bytes: number, meta: object }}
 */
export function writeDeltaPack(o) {
  const log = o.log ?? (() => {});
  const changed = [...o.diff.added, ...o.diff.changed].map((e) => e.path).sort();
  if (!changed.length) throw new Error('没有任何变更 —— 这一版不需要增量包');

  // Validate everything *before* touching the disk: a pack built from a stale 清单 must fail with a sentence that
  // says which file is wrong, not with a file-system error halfway through a staging directory.
  const pairs = new Map();
  for (const rel of changed) {
    // A path from a hand-edited 清单 could point anywhere; the phone would write it wherever it said.
    if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.split('/').includes('..') || /^[A-Za-z]:/.test(rel)) {
      throw new Error(`清单里的路径不能用：${rel}`);
    }
    const entry = o.inventory.files[rel];
    if (!entry) throw new Error(`清单里没有 ${rel} —— 清单和 payload 不是同一次生成`);
    if (!fs.existsSync(path.join(o.payloadRoot, rel))) throw new Error(`payload 里没有 ${rel} —— 清单和 payload 不是同一次生成`);
    pairs.set(rel, entry);
  }

  const stage = path.join(path.dirname(o.out), `.delta-${o.from}-${o.to}.staging`);
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  fs.rmSync(stage, { recursive: true, force: true });
  const root = path.join(stage, 'payload');
  fs.mkdirSync(root, { recursive: true });
  let bytes = 0;
  const files = {};
  try {
    for (const rel of changed) {
      const src = path.join(o.payloadRoot, rel);
      const dst = path.join(root, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      try {
        fs.linkSync(src, dst); // hard link: no copy, and the archive is built from these paths
      } catch {
        fs.copyFileSync(src, dst); // another volume, or a filesystem without links
      }
      files[rel] = pairs.get(rel);
      bytes += pairs.get(rel)[0];
    }

    const meta = {
      schema: INVENTORY_SCHEMA,
      from: o.from,
      to: o.to,
      version: String(o.version ?? o.inventory.version ?? ''),
      build: o.to,
      files,
    };
    fs.writeFileSync(path.join(root, DELTA_META), JSON.stringify(meta) + '\n');
    const out = zipDir(root, o.out);
    const size = fs.statSync(out).size;
    log(`payload-delta: ${path.basename(out)} —— ${Object.keys(files).length} 个文件, ${(bytes / 1048576).toFixed(1)} MB 原始 → ${(size / 1048576).toFixed(1)} MB 压缩`);
    return { file: out, size, files: Object.keys(files).length, bytes, meta };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Check that every file the inventory lists is really in the tree (and vice versa), i.e. that the 清单 and the
 * payload were produced from the same build. A stale pair would build a pack that either misses a changed file
 * (leaving a client half-updated) or names one that does not exist.
 *
 * @param {string} payloadRoot
 * @param {object} inventory
 * @returns {{ missing: string[], extra: string[], files: number }}
 */
export function auditPayloadAgainstInventory(payloadRoot, inventory) {
  const onDisk = new Set(walkFiles(payloadRoot).filter((rel) => rel !== 'payload.json'));
  const listed = new Set(Object.keys(inventory.files));
  const missing = [...listed].filter((rel) => !onDisk.has(rel)).sort();
  const extra = [...onDisk].filter((rel) => !listed.has(rel)).sort();
  return { missing, extra, files: onDisk.size };
}

/** sha256 of a delta pack, for the feed entry (the client verifies the whole download before unpacking). */
export function deltaEntry(file, meta = null) {
  return {
    name: path.basename(file),
    sha256: sha256File(file),
    size: fs.statSync(file).size,
    ...(meta ? { files: Object.keys(meta.files ?? {}).length, bytes: Object.values(meta.files ?? {}).reduce((n, v) => n + v[0], 0) } : {}),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const payloadRoot = opt('--payload');
  const base = opt('--base');
  const to = Number(opt('--build'));
  if (!payloadRoot || !base || !Number.isInteger(to)) {
    console.log('usage: node tools/payload-delta.mjs --payload <dir> --base <payload-N.json> --build <n> [--out <file>]');
    console.log('');
    console.log('按清单差集打一个增量包（发布时由 package-release.mjs 自动调用）。');
    process.exit(0);
  }
  const { diffInventory, readInventory } = await import('./payload-inventory.mjs');
  const baseInv = readInventory(path.resolve(base));
  const inventory = readInventory(opt('--inventory') ?? path.join(payloadRoot, 'payload.json'));
  const audit = auditPayloadAgainstInventory(payloadRoot, inventory);
  if (audit.missing.length || audit.extra.length) {
    console.error(`清单与 payload 对不上：缺 ${audit.missing.length} 个、多 ${audit.extra.length} 个`
      + `（例如 ${[...audit.missing, ...audit.extra].slice(0, 3).join(', ')}）—— 重新打包`);
    process.exit(1);
  }
  const diff = diffInventory(baseInv, inventory);
  const out = path.resolve(opt('--out') ?? path.join('build', 'dist', deltaFileName(baseInv.build, to)));
  const pack = writeDeltaPack({ payloadRoot, inventory, diff, from: baseInv.build, to, out, log: console.log });
  console.log(`payload-delta: → ${out.split(path.sep).join('/')}（${pack.files} 个文件）`);
}
