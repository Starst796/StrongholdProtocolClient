// The client's own release identity: which build this is, what number Android sees, and where it is published.
//
// The game's APP_VERSION alone cannot tell two clients apart. Upstream keeps 0.1.3 across many commits (bce1827,
// 6471511, …), and Gradle's versionCode used to be derived straight from that version — so every build of a 0.1.3
// cycle carried the same number. That is enough to install one over the other, but it cannot answer "is there
// something newer than what I have?", which is what an update check needs. Hence a counter of our own:
//
//   release.json   { "build": 12 }   the last released build; the next release is build + 1
//
// It lives in the repo (so any checkout can rebuild the same number) and is written by tools/package-release.mjs
// after the artifacts are built. Semver stays the game's; the build number rides along in build.json and in the
// Android versionCode.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASE_FILE = path.join(CLIENT_ROOT, 'release.json');
/** Build numbers are packed under Gradle's versionCode (see androidVersionCode), which must stay below 2^31-1. */
export const BUILD_MAX = 9999;

/** The tracked release counter — `{ build: 0 }` when the file is missing or unreadable (a fresh clone, a fork). */
export function readRelease() {
  try {
    const build = Number(JSON.parse(fs.readFileSync(RELEASE_FILE, 'utf8'))?.build);
    return { build: Number.isInteger(build) && build > 0 ? build : 0 };
  } catch {
    return { build: 0 };
  }
}

export function writeRelease(build) {
  fs.writeFileSync(RELEASE_FILE, JSON.stringify({ build }, null, 2) + '\n');
}

/**
 * The build number of the release being produced: one past the tracked counter, or an explicit `--build N`
 * (re-publishing an already built number, or repairing a release that failed halfway).
 * @param {string|number|undefined} explicit
 * @returns {number}
 */
export function nextBuild(explicit) {
  if (explicit != null && String(explicit).trim() !== '') {
    const n = Number(explicit);
    if (!Number.isInteger(n) || n < 1 || n > BUILD_MAX) throw new Error(`--build 要是 1–${BUILD_MAX} 的整数，收到 ${explicit}`);
    return n;
  }
  const next = readRelease().build + 1;
  if (next > BUILD_MAX) throw new Error(`release.json 的 build 已经到上限 ${BUILD_MAX}`);
  return next;
}

/**
 * The release part of Gradle's versionCode, straight from the semver (0.1.2 → 102). Kept apart from the build
 * counter so that a version bump always outranks every build of the previous version.
 * @param {string} version
 * @returns {number|null} null when the version is not parseable
 */
export function versionCode(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : null;
}

/**
 * Gradle's versionCode for a release: the version's own code with the build number packed underneath
 * (0.1.3 + build 12 → 1030012). It only ever rises — a version bump scales past every build of the old version, and
 * within one version the build counter counts up — which is what Android demands before it accepts an update over
 * an installed app *without* an uninstall (an uninstall is what costs the player their localStorage save).
 * @param {string} version
 * @param {number} build
 * @returns {number|null} null when the version is not parseable
 */
export function androidVersionCode(version, build = 0) {
  const code = versionCode(version);
  if (code == null) return null;
  const b = Math.min(Math.max(Number(build) || 0, 0), BUILD_MAX);
  return code * 10000 + b;
}

/** Tag of a release: `v0.1.3-b12`. Only a name for the humans on the releases page; clients read latest.json. */
export function releaseTag(version, build) {
  return `v${version}-b${build}`;
}

/** The URL a packaged client polls to learn whether there is something newer (an asset of the GitHub release). */
export function latestFeedUrl(repo) {
  return `https://github.com/${repo}/releases/latest/download/latest.json`;
}

/** Download URL of one artifact inside a release. */
export function assetUrl(repo, tag, name) {
  return `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
}

/** sha256 of a file, streamed: the artifacts are hundreds of MB, so they never land in one buffer. */
export function sha256File(file, chunk = 1 << 20) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(chunk);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunk, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * The update feed a packaged client reads (docs/PACKAGING.md §10): everything needed to decide "newer?" and to
 * fetch and verify the file, and nothing else. `schema` is bumped whenever the shape changes — a client refuses a
 * schema it does not know rather than guessing.
 *
 * @param {{
 *   version: string, build: number, protocol?: number|null, gameCommit?: string|null, notes?: string,
 *   tag: string, repo: string, publishedAt?: string,
 *   assets?: { win?: {name: string, sha256: string, size: number}, android?: {name: string, sha256: string, size: number} },
 * }} input
 */
export function buildLatestFeed(input) {
  const { version, build, tag, repo, assets = {} } = input;
  const feed = {
    schema: 1,
    version,
    build,
    versionCode: androidVersionCode(version, build),
    tag,
    protocol: input.protocol ?? null,
    gameCommit: input.gameCommit ?? null,
    publishedAt: input.publishedAt ?? new Date().toISOString(),
    notes: input.notes ?? '',
  };
  for (const [platform, a] of Object.entries(assets)) {
    if (!a) continue;
    feed[platform] = { name: a.name, url: assetUrl(repo, tag, a.name), sha256: a.sha256, size: a.size };
  }
  return feed;
}
