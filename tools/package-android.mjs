// Builds the Android client (.apk): assemble the payload from a game checkout, sync the Capacitor project, then run
// the Gradle wrapper. See docs/PACKAGING.md.
//
//   node tools/package-android.mjs [--server localhost:3000] [--game <checkout>] [--release] [--skip-install]
//
//   --server <addr>   game server the client connects to (default: client.config.json / localhost:3000)
//   --game <dir>      Stronghold-Protocol checkout (default: SP_GAME_ROOT / client.config.json / ../Stronghold-Protocol)
//   --release         build a release APK (unsigned → it still needs `apksigner`, see docs/PACKAGING.md)
//   --skip-install    do not run `npm install` in mobile/ even when the Capacitor CLI is missing
//
// Needs a JDK 17+ (JAVA_HOME) and the Android SDK (`ANDROID_HOME` / the platform default location) with
// platform 36 + build-tools 36 — the versions mobile/android/variables.gradle asks for.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLIENT_ROOT, assembleClient, parseCommonArgs } from './package-client.mjs';

const MOBILE = path.join(CLIENT_ROOT, 'mobile');
const ANDROID = path.join(MOBILE, 'android');
const MANIFEST = path.join(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml');

/** PATH with the running Node first: Capacitor spawns Node/Gradle helpers from it. */
function childEnv() {
  return { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` };
}

/**
 * Spawn a child, inheriting stdio. `shell` defaults to false: with cmd.exe a command path containing spaces
 * (`process.execPath` is `C:\Program Files\nodejs\node.exe` for a normal Node install) is split on the space and
 * fails with "'C:\Program' is not recognized". A shell is only needed to resolve npm (.cmd) and gradlew.bat.
 */
function run(cmd, args, cwd, { shell = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell, env: childEnv() });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

/** Android SDK location (env first, then the per-OS default the SDK manager installs into). */
function sdkDir() {
  const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
  if (process.platform === 'win32') candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'));
  else if (process.platform === 'darwin') candidates.push(path.join(os.homedir(), 'Library', 'Android', 'sdk'));
  else candidates.push(path.join(os.homedir(), 'Android', 'Sdk'));
  return candidates.find((c) => c && fs.existsSync(c)) || '';
}

/**
 * The browser client reaches a LAN server over plain ws:// when the packaged address has no TLS, so the app allows
 * cleartext (default: ws to a local/LAN server). `cap add android` regenerates the manifest, hence this re-patch.
 */
function ensureCleartext() {
  const src = fs.readFileSync(MANIFEST, 'utf8');
  if (src.includes('usesCleartextTraffic')) return;
  fs.writeFileSync(MANIFEST, src.replace(/(<application\b)/, '$1\n        android:usesCleartextTraffic="true"'));
  console.log('package-android: 已在 AndroidManifest.xml 打开 usesCleartextTraffic（供局域网 ws:// 服务器）');
}

const o = parseCommonArgs(process.argv.slice(2));
if (o.help) {
  console.log('usage: node tools/package-android.mjs [--server <address>] [--game <checkout>] [--release] [--skip-install]');
  process.exit(0);
}
const built = assembleClient({ server: o.server, gameRoot: o.game, feed: o.feed });

const cli = path.join(MOBILE, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
if (!fs.existsSync(cli)) {
  if (o.skipInstall) throw new Error('mobile/node_modules 缺失 —— 先在 mobile/ 里跑 `npm install`');
  console.log('package-android: 安装 Capacitor CLI（首次）…');
  run('npm', ['install', '--no-audit', '--no-fund'], MOBILE, { shell: process.platform === 'win32' });
}

if (!fs.existsSync(ANDROID)) {
  console.log('package-android: 添加 Android 平台（mobile/android/）…');
  run(process.execPath, [cli, 'add', 'android'], MOBILE);
}
ensureCleartext();

const sdk = sdkDir();
if (!sdk) throw new Error('找不到 Android SDK —— 设置 ANDROID_HOME（见 docs/PACKAGING.md）');
fs.writeFileSync(path.join(ANDROID, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '\\\\')}\n`);
if (!process.env.JAVA_HOME) console.warn('package-android: 未设置 JAVA_HOME —— Gradle 需要 JDK 17+（见 docs/PACKAGING.md）');

console.log(`package-android: 把 payload 同步进 Capacitor 工程（服务器 ${built.server}，游戏 ${built.game.describe || built.game.app}）…`);
run(process.execPath, [cli, 'sync', 'android'], MOBILE);

const task = o.release ? 'assembleRelease' : 'assembleDebug';
console.log(`package-android: gradlew ${task}…`);
run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', [task, '--no-daemon', '--console=plain'], ANDROID, { shell: process.platform === 'win32' });

const apkDir = path.join(ANDROID, 'app', 'build', 'outputs', 'apk');
const found = fs.existsSync(apkDir) ? fs.readdirSync(apkDir, { recursive: true }).filter((f) => String(f).endsWith('.apk')) : [];
if (!found.length) throw new Error(`没有生成 APK：${apkDir}`);
for (const f of found) {
  const full = path.join(apkDir, f);
  const st = fs.statSync(full);
  console.log(`package-android: ${path.relative(CLIENT_ROOT, full).split(path.sep).join('/')} (${(st.size / 1048576).toFixed(1)} MB)`);
}
