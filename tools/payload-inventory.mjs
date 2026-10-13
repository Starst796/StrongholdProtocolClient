// The payload inventory: every file in a packaged client with its size and sha256. Two jobs, one format.
//
// 1. 清单 — it ships *inside* the payload as `payload.json`, so an installed client knows exactly what it has
//    without hashing 670 MB on a phone. The same bytes are published next to the installers as
//    `payload-<build>.json`, so the packager can diff two builds and the client can fetch the target inventory.
// 2. 体积报告 — diffing two inventories answers "how big is an incremental update really?" (0.2.4 → 0.2.5 was
//    1822 files / 85.0 MB against a 670.9 MB full payload, 12.7%) and is the data the in-app updater will use to
//    download only what changed.
//
// Format (kept compact on purpose: ~110 bytes per file, 1.5 MB for 13.5k files):
//
//   { "schema": 1, "version": "0.2.5", "build": 6,
//     "totals": { "files": 13524, "bytes": 703000000 },
//     "files": { "index.html": [12345, "<sha256 hex>"], … } }
//
// `files` holds every file *except* `payload.json` itself — a file cannot contain its own hash. Both sides of a
// diff exclude it, so the omission stays consistent; the client writes its new inventory from the downloaded
// `payload-<build>.json` (the very same bytes), and never from the delta pack.
//
// Paths always use `/`, sorted, so two inventories of identical trees are byte-identical files (which is what makes
// them comparable at all).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256File } from './release-meta.mjs';

export const INVENTORY_SCHEMA = 1;
/** Where the inventory lives inside the payload and in build/dist. */
export const INVENTORY_FILE = 'payload.json';

const toPosix = (rel) => rel.split(path.sep).join('/');
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * Every file below `root`, as sorted `a/b/c` paths.
 * @param {string} root
 * @returns {string[]}
 */
export function walkFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(child);
      else if (e.isFile()) out.push(child);
    }
  }
  return out.sort();
}

/**
 * Hash a payload tree into an inventory.
 * @param {string} root payload root (e.g. build/client/www)
 * @param {{ version?: string, build?: number, exclude?: string[], log?: (...a: any[]) => void }} [opts]
 *   `exclude` is relative to the payload root; `payload.json` is always excluded.
 * @returns {{ schema: number, version: string, build: number, totals: { files: number, bytes: number }, files: Record<string, [number, string]> }}
 */
export function buildInventory(root, opts = {}) {
  const log = opts.log ?? (() => {});
  const exclude = new Set([INVENTORY_FILE, ...(opts.exclude ?? []).map((p) => p.replace(/^\/+/, ''))]);
  const files = {};
  let files_n = 0;
  let bytes = 0;
  for (const rel of walkFiles(root)) {
    if (exclude.has(rel)) continue;
    const abs = path.join(root, rel);
    const size = fs.statSync(abs).size;
    files[rel] = [size, sha256File(abs)];
    files_n++;
    bytes += size;
  }
  log(`payload-inventory: ${files_n} 个文件, ${mb(bytes)}（清单不含 ${INVENTORY_FILE} 自身）`);
  return { schema: INVENTORY_SCHEMA, version: String(opts.version ?? ''), build: Number(opts.build ?? 0), totals: { files: files_n, bytes }, files };
}

/** Write an inventory: compact, one JSON object, trailing newline (the file is 1.5 MB, pretty-printing triples it). */
export function writeInventory(file, inv) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(inv) + '\n');
}

/**
 * Read and validate an inventory. A malformed one must fail loudly: it is the base of every delta decision, and a
 * silently empty diff would publish a "0 MB update" that leaves the client broken.
 * @param {string} file
 * @returns {{ schema: number, version: string, build: number, totals: { files: number, bytes: number }, files: Record<string, [number, string]> }}
 */
export function readInventory(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`读不到清单 ${file} —— 这个 build 的 payload-<build>.json 不在（新 clone 可以从发布包重新生成，见 tools/payload-inventory.mjs --from-zip）`);
  }
  let inv;
  try {
    inv = JSON.parse(raw);
  } catch (e) {
    throw new Error(`清单 ${file} 不是 JSON：${e.message}`);
  }
  if (inv?.schema !== INVENTORY_SCHEMA) throw new Error(`清单 ${file} 的 schema 是 ${inv?.schema}，本工具只认 ${INVENTORY_SCHEMA}`);
  if (!inv.files || typeof inv.files !== 'object') throw new Error(`清单 ${file} 缺 files`);
  const entries = Object.entries(inv.files);
  for (const [rel, v] of entries) {
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'string') {
      throw new Error(`清单 ${file} 里 ${rel} 的形状不对（应是 [size, sha256]）`);
    }
  }
  inv.totals = { files: entries.length, bytes: entries.reduce((n, [, v]) => n + v[0], 0) };
  return inv;
}

/**
 * What changed between two inventories. `added`/`changed`/`removed` are sorted path lists with sizes — the exact set
 * an incremental update has to move, and what the size report is built from.
 * @param {object} base
 * @param {object} target
 */
export function diffInventory(base, target) {
  const added = [];
  const changed = [];
  const removed = [];
  let unchanged = 0;
  let unchangedBytes = 0;
  for (const [rel, [size, sha]] of Object.entries(target.files)) {
    const before = base.files[rel];
    if (!before) added.push({ path: rel, size });
    else if (before[1] !== sha || before[0] !== size) changed.push({ path: rel, size });
    else { unchanged++; unchangedBytes += size; }
  }
  for (const [rel, [size]] of Object.entries(base.files)) {
    if (!target.files[rel]) removed.push({ path: rel, size });
  }
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  added.sort(byPath); changed.sort(byPath); removed.sort(byPath);
  const sum = (list) => list.reduce((n, e) => n + e.size, 0);
  return {
    added, changed, removed, unchanged, unchangedBytes,
    bytes: { added: sum(added), changed: sum(changed), removed: sum(removed) },
    upload: sum(added) + sum(changed),
    uploadFiles: added.length + changed.length,
    total: target.totals.bytes,
  };
}

/** `1234` → `1.2 GB` / `12.3 MB` / `45.6 KB`, for the report table. */
export function human(bytes) {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** First path segment of a payload path ('assets/local/x.png' → 'assets'), for the per-directory breakdown. */
const topDir = (rel) => (rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '(root)');

/** Files/bytes per top-level directory, biggest first. */
function byTopDir(entries) {
  const map = new Map();
  for (const { path: rel, size } of entries) {
    const dir = topDir(rel);
    const cur = map.get(dir) ?? { dir, files: 0, bytes: 0 };
    cur.files++; cur.bytes += size;
    map.set(dir, cur);
  }
  return [...map.values()].sort((a, b) => b.bytes - a.bytes);
}

/**
 * The 体积报告: what this payload weighs, how it is distributed, and what an incremental update would have to move
 * against a given base — the half-step that tells us whether the delta machinery is worth anything before building
 * it. Markdown, so it can be dropped into a PR or the session notes as-is.
 *
 * @param {{ inv: object, diff?: object|null, baseBuild?: number|null, baseVersion?: string|null, deltaFile?: {name: string, size: number}|null, biggest?: number }} input
 * @returns {string}
 */
export function inventoryReport(input) {
  const { inv, diff = null, baseBuild = null, baseVersion = null, deltaFile = null } = input;
  const biggest = input.biggest ?? 15;
  const label = `${inv.version || '?'} (build ${inv.build})`;
  const lines = [];
  lines.push(`# 客户端 payload 体积报告 — ${label}`);
  lines.push('');
  lines.push(`- 全量：**${inv.totals.files}** 个文件，**${human(inv.totals.bytes)}**`);
  if (diff) {
    const pct = diff.total ? ((diff.upload / diff.total) * 100).toFixed(1) : '0.0';
    lines.push(`- 相对 ${baseVersion ? `${baseVersion} (build ${baseBuild})` : `build ${baseBuild}`}：`
      + `新增 ${diff.added.length} / 修改 ${diff.changed.length} / 删除 ${diff.removed.length}，`
      + `需传输 **${human(diff.upload)}**（${diff.uploadFiles} 个文件，占全量 ${pct}%）`);
    lines.push(`- 未变：${diff.unchanged} 个文件，${human(diff.unchangedBytes)}（增量更新可以完全跳过）`);
    if (deltaFile) {
      const saved = diff.total - deltaFile.size;
      lines.push(`- 增量包 ${deltaFile.name}：**${human(deltaFile.size)}**，`
        + `比全量少 ${human(Math.max(saved, 0))}（${diff.total ? ((saved / diff.total) * 100).toFixed(1) : '0.0'}% 的流量）`);
    }
  } else {
    lines.push('- 没有基准清单（build/inventories/ 里没有更早的 payload-<build>.json）—— 本次只能报全量，'
      + '下次打包会自动给出增量数据。');
  }
  lines.push('');

  lines.push('## 体积分布（顶层目录）');
  lines.push('');
  lines.push('| 目录 | 文件 | 体积 | 占比 |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const d of byTopDir(Object.entries(inv.files).map(([p, v]) => ({ path: p, size: v[0] })))) {
    lines.push(`| \`${d.dir}\` | ${d.files} | ${human(d.bytes)} | ${((d.bytes / inv.totals.bytes) * 100).toFixed(1)}% |`);
  }
  lines.push('');

  if (diff && diff.uploadFiles) {
    const changes = [...diff.added.map((e) => ({ ...e, kind: '新增' })), ...diff.changed.map((e) => ({ ...e, kind: '修改' }))];
    lines.push('## 变更分布（顶层目录）');
    lines.push('');
    lines.push('| 目录 | 新增 | 修改 | 需传输 |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const d of byTopDir(changes)) {
      const a = diff.added.filter((e) => topDir(e.path) === d.dir);
      const c = diff.changed.filter((e) => topDir(e.path) === d.dir);
      lines.push(`| \`${d.dir}\` | ${a.length} (${human(a.reduce((n, e) => n + e.size, 0))}) | ${c.length} (${human(c.reduce((n, e) => n + e.size, 0))}) | ${human(d.bytes)} |`);
    }
    lines.push('');
    lines.push(`## 最大的 ${biggest} 个新增/修改文件`);
    lines.push('');
    lines.push('| 文件 | 变化 | 体积 |');
    lines.push('| --- | --- | ---: |');
    for (const e of changes.sort((a, b) => b.size - a.size).slice(0, biggest)) {
      lines.push(`| \`${e.path}\` | ${e.kind} | ${human(e.size)} |`);
    }
    lines.push('');
    if (diff.removed.length) {
      lines.push(`## 删除的文件（${diff.removed.length}）`);
      lines.push('');
      for (const e of diff.removed.slice(0, biggest)) lines.push(`- \`${e.path}\` — ${human(e.size)}`);
      lines.push('');
    }
  }

  lines.push('## 怎么读这份报告');
  lines.push('');
  lines.push('- 「需传输」= 新增 + 修改的原始字节（未压缩）。素材多为已压缩图片，压缩收益很小 —— 真实值由增量包本身给出');
  lines.push('  （见 build/dist/delta-<base>-<build>.zip），这一步先看原始体积是否值得做增量。');
  lines.push('- 全量仍然要发：增量只对「装的是上一个 build」的客户端有意义，版本落后太多、或清单对不上时回退全量。');
  lines.push('- 清单由 tools/package-release.mjs 每次打包生成：payload 内 `payload.json` + build/dist/payload-<build>.json（同一内容）。');
  lines.push('');
  return lines.join('\n');
}

/**
 * Bootstrap a base inventory from a shipped artifact — for a fresh clone whose build/inventories/ is empty (build/ is
 * gitignored), and for the first build that has a manifest at all. Extracts the payload out of the zip (`tar` is on
 * Windows 10+, macOS and Linux) and hashes it; the extracted tree is deleted again.
 *
 * @param {string} zip desktop zip produced by tools/package-release.mjs
 * @param {{ zipRoot?: string, tmp?: string, log?: (...a: any[]) => void, keep?: boolean }} [opts]
 *   `zipRoot` defaults to Electron's layout, `win-unpacked/resources/www`.
 * @returns {{ inventory: object, dir: string, buildJson: object|null }}
 */
export function inventoryFromZip(zip, opts = {}) {
  const log = opts.log ?? (() => {});
  const zipRoot = String(opts.zipRoot ?? 'win-unpacked/resources/www').replace(/\/+$/, '');
  if (!fs.existsSync(zip)) throw new Error(`没有这个 zip：${zip}`);
  const dir = path.resolve(opts.tmp ?? path.join(path.dirname(zip), `.unzip-${path.basename(zip, '.zip')}`));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  log(`payload-inventory: 从 ${path.basename(zip)} 解出 ${zipRoot}/ …`);
  const r = spawnSync('tar', ['-xf', zip, '-C', dir, zipRoot], { stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`tar -xf 退出码 ${r.status}`);
  const payload = path.join(dir, ...zipRoot.split('/'));
  if (!fs.existsSync(path.join(payload, 'build.json'))) throw new Error(`${zipRoot}/build.json 不在 —— zip 里没有 payload（用 --zip-root 指到 payload 目录）`);
  const buildJson = JSON.parse(fs.readFileSync(path.join(payload, 'build.json'), 'utf8'));
  const inventory = buildInventory(payload, {
    version: buildJson?.client?.version ?? buildJson?.game?.app ?? '',
    build: buildJson?.client?.build ?? 0,
    log,
  });
  if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
  return { inventory, dir, buildJson };
}

/** Newest `payload-<build>.json` in `dir` whose build is *below* `build` — the base a report/delta is computed from. */
export function findBaseInventory(dir, build) {
  let best = null;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const m = /^payload-(\d+)\.json$/.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= build) continue;
    if (!best || n > best.build) best = { build: n, file: path.join(dir, name) };
  }
  return best;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const argv = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  const zip = opt('--from-zip');
  if (!zip) {
    console.log('usage: node tools/payload-inventory.mjs --from-zip <desktop.zip> [--zip-root win-unpacked/resources/www]');
    console.log('                                        [--out build/inventories/payload-<build>.json] [--keep]');
    console.log('');
    console.log('从已发布的桌面 zip 重新生成某个 build 的清单（新 clone 里 build/ 是空的，需要它当增量基准）。');
  } else {
    const out = opt('--out');
    const { inventory } = inventoryFromZip(zip, { zipRoot: opt('--zip-root'), keep: argv.includes('--keep'), log: console.log });
    const file = out ?? path.join('build', 'inventories', `payload-${inventory.build}.json`);
    writeInventory(file, inventory);
    console.log(`payload-inventory: 清单 → ${file.split(path.sep).join('/')}（${inventory.totals.files} 文件, ${human(inventory.totals.bytes)}）`);
  }
}
