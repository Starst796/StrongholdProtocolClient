// One-shot release driver for this packaging repo, meant to be run *by hand* right after the game repo
// (../Stronghold-Protocol) has been updated — see docs/PACKAGING.md §9 and PACKAGING-EXPERIENCE.md.
//
//   package.bat / package.sh            (thin wrappers: find Node, then run this)
//   npm run release
//   node tools/package-release.mjs [options]
//
// It does the five things a release needs, in order:
//   1. reads the game repo's release version (shared/constants.js APP_VERSION, the number the game shows);
//   2. takes the next client build number (release.json + 1) and aligns this repo's version fields to both — the
//      version from the game (0.1.3) and the build packed under it (build 12 → versionCode 1030012, which is what
//      lets an installed app be updated in place; see tools/release-meta.mjs);
//   3. builds the desktop client (folder form) + a zip of it, and the Android debug APK;
//   4. copies the artifacts into build/dist/, writes the update feed there (latest.json) and remembers the build
//      number in release.json;
//   5. commits the aligned version + the new build number in this repo.
//
// Publishing is separate and explicit: `node tools/publish-release.mjs` uploads the artifacts and the feed to
// GitHub Releases (docs/PACKAGING.md §10). Nothing in this driver touches the network.
//
// The game repo is never modified: its version is only *read*. Everything else (payload, patches, shells) is
// produced by tools/package-desktop.mjs / tools/package-android.mjs, which this driver reuses.
//
//   --game <dir>      Stronghold-Protocol checkout (default: SP_GAME_ROOT / client.config.json / sibling)
//   --server <addr>   server the payload connects to (default: client.config.json / localhost:3000)
//   --feed <url>      update feed baked into the payload (default: client.config.json update.feed; '' = no check)
//   --build <n>       build number to use (default: release.json + 1)
//   --notes <text>    release notes for the feed (default: 上游 <version>（<commit>）; this text is shown to players)
//   --tag <tag>       release tag (default: v<version>-b<build>)
//   --portable        desktop single-file .exe instead of the folder (slow first screen; see docs/PACKAGING.md §4)
//   --no-zip          keep the win-unpacked folder, skip the zip
//   --skip-android    do not build the APK
//   --release         Android release APK instead of debug (unsigned; needs a signing config to install)
//   --no-commit       align versions + build, but do not `git commit`
//   --no-test         skip the `node --test` gate before building
//   --skip-install    never run `npm install` in desktop/ or mobile/
//   --quiet           less chatter

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLIENT_ROOT, loadConfig } from './package-client.mjs';
import { androidVersionCode, buildLatestFeed, nextBuild, readRelease, releaseTag, sha256File, versionCode, writeRelease } from './release-meta.mjs';
import { findGameRoot, readAppVersion, readProtocolVersion } from './game-contract.mjs';
import { buildDesktop } from './package-desktop.mjs';

/** Files whose version field tracks the game repo (same set as commit 1ca6d71). */
export const VERSION_JSON = Object.freeze(['package.json', 'desktop/package.json', 'mobile/package.json']);
/** Lockfiles whose root + packages[""] version must follow (npm's own transitive entries never change). */
export const VERSION_LOCKS = Object.freeze(['desktop/package-lock.json', 'mobile/package-lock.json']);
const GRADLE = path.join('mobile', 'android', 'app', 'build.gradle');

// `versionCode` (the semver → code map) and `androidVersionCode` (code + build) live in tools/release-meta.mjs —
// re-exported so the older import sites keep working.
export { versionCode };

function run(cmd, args, { cwd = CLIENT_ROOT, env = process.env, shell = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env, shell });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 退出码 ${r.status}`);
  return r;
}

/** git with captured output (status 1 is meaningful for diff --quiet, so no throw here). */
function git(args, { cwd = CLIENT_ROOT } = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Point this repo's version fields at `version` (and Gradle's versionCode at `version` + `build`); returns the files
 * that actually changed.
 * Only the two leading `"version":` entries of a lockfile (root + packages[""]) are touched, so npm's transitive
 * `0.1.0`s in dev dependencies stay exactly as npm wrote them (and the files keep their original formatting).
 * @param {string} version
 * @param {number} [build]
 * @returns {string[]}
 */
export function alignVersions(version, build = readRelease().build) {
  const changed = [];
  const writeIfChanged = (file, next) => {
    if (fs.readFileSync(file, 'utf8') === next) return false;
    fs.writeFileSync(file, next);
    return true;
  };

  for (const rel of VERSION_JSON) {
    const file = path.join(CLIENT_ROOT, rel);
    const next = fs.readFileSync(file, 'utf8')
      .replace(/("version"\s*:\s*")[^"]*(")/, (m, a, b) => `${a}${version}${b}`);
    if (writeIfChanged(file, next)) changed.push(rel);
  }
  for (const rel of VERSION_LOCKS) {
    const file = path.join(CLIENT_ROOT, rel);
    let n = 0;
    const next = fs.readFileSync(file, 'utf8')
      .replace(/("version"\s*:\s*")[^"]*(")/g, (m, a, b) => (n++ < 2 ? `${a}${version}${b}` : m));
    if (writeIfChanged(file, next)) changed.push(rel);
  }
  const gradle = path.join(CLIENT_ROOT, GRADLE);
  if (fs.existsSync(gradle)) {
    const code = androidVersionCode(version, build);
    const next = fs.readFileSync(gradle, 'utf8')
      .replace(/(\bversionCode\s+)\d+/, (m, a) => (code == null ? m : `${a}${code}`))
      .replace(/(\bversionName\s+")[^"]*(")/, `$1${version}$2`);
    if (writeIfChanged(gradle, next)) changed.push(GRADLE.split(path.sep).join('/'));
  }
  return changed;
}

/** JDK 17+ home: JAVA_HOME first, then the usual install roots (newest version-looking directory wins). */
function findJdk() {
  const javaExe = process.platform === 'win32' ? 'java.exe' : 'java';
  const ok = (dir) => dir && fs.existsSync(path.join(dir, 'bin', javaExe));
  if (ok(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  const roots = process.platform === 'win32'
    ? ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Java')]
    : ['/usr/lib/jvm'];
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      const dir = path.join(root, entry);
      if (ok(dir)) found.push(dir);
    }
  }
  const score = (dir) => {
    const m = /(\d+)(?:\.(\d+))?/.exec(path.basename(dir));
    return m ? Number(m[1]) * 100 + Number(m[2] || 0) : -1;
  };
  found.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
  return found.pop() || '';
}

/** Android SDK: ANDROID_HOME / ANDROID_SDK_ROOT, then the per-OS default the SDK manager installs into. */
function findSdk() {
  const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
  if (process.platform === 'win32') candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'));
  else if (process.platform === 'darwin') candidates.push(path.join(os.homedir(), 'Library', 'Android', 'sdk'));
  else candidates.push(path.join(os.homedir(), 'Android', 'Sdk'));
  return candidates.find((c) => c && fs.existsSync(c)) || '';
}

/** Compress `dir` into `zipPath` (the folder itself becomes the zip's single root entry). */
function zipDir(dir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  const args = (tool) => ['-a', '-c', '-f', zipPath, '-C', path.dirname(dir), path.basename(dir)];
  if (process.platform === 'win32' || process.env.SP_ZIP === 'tar') {
    run('tar', args());
    return;
  }
  // GNU/Linux and macOS: `zip` is the reliable one; bsdtar (`tar -a`) or 7z as fallbacks.
  for (const tool of ['zip', '7z', 'tar']) {
    const probe = spawnSync(tool, ['--help'], { encoding: 'utf8' });
    if (probe.error) continue;
    if (tool === 'zip') run('zip', ['-q', '-r', zipPath, path.basename(dir)], { cwd: path.dirname(dir) });
    else if (tool === '7z') run('7z', ['a', '-mx=9', zipPath, path.basename(dir)], { cwd: path.dirname(dir) });
    else run('tar', args());
    return;
  }
  throw new Error('找不到压缩工具（zip / 7z / tar）—— 用 --no-zip 跳过，或装一个');
}

function dirBytes(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? dirBytes(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size;
  return n;
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

/** Build the APK through the existing CLI and copy it into build/dist/. Skips (with a warning) when no JDK/SDK. */
function buildAndroid({ version, o, log }) {
  const jdk = findJdk();
  const sdk = findSdk();
  if (!jdk || !sdk) {
    log(`package-release: 跳过 APK —— 缺少 ${!jdk ? 'JDK 17+' : 'Android SDK'}（见 docs/PACKAGING.md §5）`);
    return null;
  }
  const args = ['tools/package-android.mjs'];
  if (o.game) args.push('--game', o.game);
  if (o.server) args.push('--server', o.server);
  if (o.feed) args.push('--feed', o.feed);
  if (o.release) args.push('--release');
  if (o.skipInstall) args.push('--skip-install');
  run(process.execPath, args, { env: { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk } });

  const base = path.join(CLIENT_ROOT, 'mobile', 'android', 'app', 'build', 'outputs', 'apk');
  const apks = fs.existsSync(base)
    ? fs.readdirSync(base, { recursive: true }).map(String).filter((f) => f.endsWith('.apk')).map((f) => path.join(base, f))
    : [];
  if (!apks.length) throw new Error(`没有生成 APK：${base}`);
  const wanted = o.release ? /release/ : /debug/;
  const apk = apks.find((f) => wanted.test(path.basename(f))) ?? apks.sort().pop();
  const dist = path.join(CLIENT_ROOT, 'build', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const dst = path.join(dist, `StrongholdProtocol-${version}-android-${o.release ? 'release' : 'debug'}.apk`);
  fs.copyFileSync(apk, dst);
  return { apk, dst };
}

function commitRelease({ version, build, protocol, artifacts, log }) {
  const staged = git(['add', '-A']);
  if (staged.error) throw staged.error;
  if (git(['diff', '--cached', '--quiet']).status === 0) {
    log('package-release: 没有需要提交的改动');
    return null;
  }
  const body = [
    `chore(release): 客户端对齐上游 ${version}（build ${build} · 桌面目录版 + Android apk）`,
    '',
    `上游 Stronghold-Protocol 已发布 ${version}（协议 v${protocol ?? '?'}），本仓库的版本字段同步跟上（Android versionCode ${androidVersionCode(version, build)}），并打包出：`,
    ...artifacts.map((a) => `- ${path.relative(CLIENT_ROOT, a).split(path.sep).join('/')}`),
    '',
    `客户端构建号 build ${build}（release.json），发到 GitHub Releases 的更新 feed 见 docs/PACKAGING.md §10。`,
    '',
    '由 tools/package-release.mjs 生成（入口 package.bat / package.sh）。',
    '',
    'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>',
    '',
  ].join('\n');
  const msgFile = path.join(CLIENT_ROOT, 'build', 'release-commit.txt');
  fs.mkdirSync(path.dirname(msgFile), { recursive: true });
  fs.writeFileSync(msgFile, body);
  run('git', ['commit', '-F', msgFile]);
  return git(['rev-parse', '--short', 'HEAD']).stdout.trim();
}

export function parseReleaseArgs(argv) {
  const o = {
    game: undefined, server: undefined, feed: undefined, build: undefined, notes: undefined, tag: undefined,
    repo: undefined, portable: false, skipInstall: false,
    zip: true, android: true, commit: true, test: true, release: false, quiet: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const val = () => (eq === -1 ? argv[++i] : a.slice(eq + 1));
    if (key === '--game') o.game = val();
    else if (key === '--server') o.server = val();
    else if (key === '--feed') o.feed = val();
    else if (key === '--build') o.build = val();
    else if (key === '--notes') o.notes = val();
    else if (key === '--tag') o.tag = val();
    else if (key === '--repo') o.repo = val();
    else if (key === '--portable') o.portable = true;
    else if (key === '--skip-install') o.skipInstall = true;
    else if (key === '--no-zip') o.zip = false;
    else if (key === '--skip-android' || key === '--no-android') o.android = false;
    else if (key === '--release') o.release = true;
    else if (key === '--no-commit') o.commit = false;
    else if (key === '--no-test') o.test = false;
    else if (key === '--quiet') o.quiet = true;
    else if (key === '-h' || key === '--help') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

export function release(o = {}) {
  const log = o.quiet ? () => {} : console.log;

  const config = loadConfig();
  const gameRoot = findGameRoot({ cli: o.game, clientRoot: CLIENT_ROOT, config });
  const version = readAppVersion(gameRoot);
  if (!version) throw new Error(`${gameRoot}/shared/constants.js 里读不到 APP_VERSION`);
  const protocol = readProtocolVersion(gameRoot);
  log(`package-release: 上游 ${path.relative(CLIENT_ROOT, gameRoot) || gameRoot} —— 版本 ${version}，协议 v${protocol ?? '?'}`);

  // This build's identity: what an installed client compares against the published feed (tools/release-meta.mjs).
  // Bumped before the build so the APK carries the new Gradle versionCode; release.json is only written once the
  // artifacts are actually there (a failed build must not burn a build number).
  const build = nextBuild(o.build);
  log(`package-release: 客户端构建号 build ${build}（Android versionCode ${androidVersionCode(version, build)}）`);

  const changed = alignVersions(version, build);
  log(changed.length
    ? `package-release: 版本号对齐 → ${changed.join('、')}`
    : `package-release: 版本号已是 ${version}（build ${build}）`);

  if (o.test) {
    log('package-release: 先跑一遍测试（--no-test 可跳过）…');
    run(process.execPath, ['--test']);
  }

  const built = buildDesktop({ server: o.server, gameRoot: o.game, feed: o.feed, portable: o.portable, skipInstall: o.skipInstall });
  const dist = path.join(CLIENT_ROOT, 'build', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const artifacts = [];
  let winZip = null;
  const unpacked = path.join(CLIENT_ROOT, 'build', 'desktop', 'win-unpacked');
  if (fs.existsSync(unpacked)) {
    log(`package-release: 桌面目录版 ${mb(dirBytes(unpacked))} → build/desktop/win-unpacked/`);
    if (o.zip) {
      const zipPath = path.join(dist, `StrongholdProtocol-${version}-win-x64.zip`);
      log('package-release: 正在压缩（这会花上一会儿）…');
      zipDir(unpacked, zipPath);
      winZip = zipPath;
      artifacts.push(zipPath);
      log(`package-release: ${path.relative(CLIENT_ROOT, zipPath).split(path.sep).join('/')} —— ${mb(fs.statSync(zipPath).size)}`);
    }
  } else {
    log('package-release: 没找到 build/desktop/win-unpacked —— 桌面版可能没打出来（--portable 时属正常）');
  }
  for (const rel of built.artifacts ?? []) {
    if (rel.endsWith('.exe')) artifacts.push(path.join(CLIENT_ROOT, rel));
  }

  let android = null;
  if (o.android) {
    log('package-release: 打 Android APK…');
    android = buildAndroid({ version, o, log });
    if (android) {
      artifacts.push(android.dst);
      log(`package-release: ${path.relative(CLIENT_ROOT, android.dst).split(path.sep).join('/')} —— ${mb(fs.statSync(android.dst).size)}`);
    }
  }

  // The build number is now real: remember it in release.json before committing, so a checkout can tell which
  // build these artifacts are, and the next release counts up from here.
  writeRelease(build);

  const repo = String(o.repo ?? config.update?.repo ?? '').trim();
  const tag = String(o.tag ?? '').trim() || releaseTag(version, build);
  let feed = null;
  if (!repo) {
    log('package-release: client.config.json 没配 update.repo —— 跳过更新 feed（latest.json）');
  } else {
    // The feed is what an installed client polls (docs/PACKAGING.md §10). Its asset URLs point at the release this
    // very build will be published as, so publish with the same --tag (tools/publish-release.mjs reads it back).
    // The default note is the upstream version + commit, not upstream's last commit *subject*: that is a game-dev
    // line ("feedback5: … §25.22.9 …") and this text is shown to players in the update row. --notes overrides it.
    const notes = String(o.notes ?? '').trim()
      || `上游 Stronghold-Protocol ${version}（${String(built.game?.commit ?? '').slice(0, 8) || '?'}）`;
    const assets = {
      win: assetEntry(winZip),
      android: assetEntry(android?.dst),
    };
    feed = buildLatestFeed({
      version, build, protocol, tag, repo, notes, assets,
      gameCommit: built.game?.commit ? String(built.game.commit) : null,
    });
    const feedPath = path.join(dist, 'latest.json');
    fs.writeFileSync(feedPath, JSON.stringify(feed, null, 2) + '\n');
    artifacts.push(feedPath);
    log(`package-release: 更新 feed → build/dist/latest.json（tag ${tag}）`);
  }

  let commit = null;
  if (o.commit) {
    commit = commitRelease({ version, build, protocol, artifacts, log });
    if (commit) log(`package-release: 已提交 ${commit}`);
  }

  log(`\npackage-release: 完成 —— 版本 ${version}，build ${build}${feed ? `，tag ${tag}` : ''}`);
  for (const a of artifacts) log(`  ${path.relative(CLIENT_ROOT, a).split(path.sep).join('/')}`);
  if (feed) {
    log('\npackage-release: 发布（上传安装包 + latest.json 到 GitHub Releases）:');
    log(`  node tools/publish-release.mjs${o.tag ? ` --tag ${tag}` : ''}`);
    log(`  发布后客户端轮询：${config.update?.feed ?? ''}`);
  }
  return { version, protocol, build, tag, gameRoot, changed, artifacts, android, feed, commit };
}

/** `{name, sha256, size}` for one artifact — the shape buildLatestFeed() publishes. Null when there is no artifact. */
function assetEntry(file) {
  if (!file || !fs.existsSync(file)) return null;
  const size = fs.statSync(file).size;
  return { name: path.basename(file), sha256: sha256File(file), size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseReleaseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('usage: node tools/package-release.mjs [--game <checkout>] [--server <addr>] [--feed <url>]');
    console.log('                                        [--build <n>] [--notes <text>] [--tag <tag>] [--repo <owner/name>]');
    console.log('                                        [--portable] [--no-zip] [--skip-android] [--release]');
    console.log('                                        [--no-commit] [--no-test] [--skip-install]');
  } else {
    release(o);
  }
}
