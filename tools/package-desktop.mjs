// Builds the desktop client: assemble the payload from a game checkout, install the Electron shell's deps when
// needed, then run electron-builder. See docs/PACKAGING.md.
//
//   node tools/package-desktop.mjs [--server <addr>] [--game <checkout>] [--portable] [--skip-install]
//
//   --server <addr>   game server the client connects to (default: client.config.json / localhost:3000)
//   --game <dir>      Stronghold-Protocol checkout (default: SP_GAME_ROOT / client.config.json / ../Stronghold-Protocol)
//   --portable        single-file portable .exe instead of the folder (it unpacks the whole app to %TEMP% on
//                     *every* launch: ~24 s to the first screen versus ~0.5 s for the folder)
//   --skip-install    do not run `npm install` in desktop/ even when electron is missing
//
// The default target is the folder (`dir`) → `build/desktop/win-unpacked/`: a normal .exe with its DLLs, locales
// and resources/ beside it. That is what gets distributed (zip it yourself, see docs/PACKAGING.md §4). Either way
// the game's ~245 MB of art/audio sits in resources/www, so nothing shrinks — but the folder starts instantly,
// while a single-file exe must extract all of it to %TEMP% before the window can appear.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_ROOT, assembleClient, parseCommonArgs } from './package-client.mjs';

const DESKTOP = path.join(CLIENT_ROOT, 'desktop');

/** electron-builder targets for the requested output (see the header). */
export function desktopTargets({ portable = false } = {}) {
  return [portable ? 'portable' : 'dir'];
}

/** PATH with the running Node first: npm lifecycle scripts locate `node` from it. */
function childEnv() {
  return { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` };
}

/** bin entry of an installed package (package.json "bin" is a string or a name→path map). */
function pkgBin(dir, name) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const rel = typeof pj.bin === 'string' ? pj.bin : pj.bin?.[name];
    return rel ? path.join(dir, rel) : null;
  } catch {
    return null;
  }
}

/**
 * Spawn a child, inheriting stdio. `shell` defaults to false: with cmd.exe a command path containing spaces
 * (`process.execPath` is `C:\Program Files\nodejs\node.exe` for a normal Node install) is split on the space and
 * fails with "'C:\Program' is not recognized". A shell is only needed to resolve npm (.cmd) — pass it explicitly.
 */
function run(cmd, args, cwd, { shell = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell, env: childEnv() });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

/** Total size of a directory tree. */
function dirBytes(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? dirBytes(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size;
  return n;
}

export function buildDesktop(o = {}) {
  const built = assembleClient({ server: o.server, gameRoot: o.game, feed: o.feed, build: o.build });

  const builder = pkgBin(path.join(DESKTOP, 'node_modules', 'electron-builder'), 'electron-builder');
  const electronDist = path.join(DESKTOP, 'node_modules', 'electron', 'dist');
  if (!builder || !fs.existsSync(electronDist)) {
    if (o.skipInstall) throw new Error('desktop/node_modules 不完整 —— 先在 desktop/ 里跑 `npm install`');
    console.log('package-desktop: 安装 Electron 壳依赖（首次约 500 MB）…');
    run('npm', ['install', '--no-audit', '--no-fund'], DESKTOP, { shell: process.platform === 'win32' });
  }

  const targets = desktopTargets(o);
  console.log(`package-desktop: 构建 ${targets.join(' + ')}（服务器 ${built.server}，游戏 ${built.game.describe || built.game.app}）…`);
  const args = [builder, '--win', targets[0], '--x64'];
  // Package with the Electron that `npm install` already put in desktop/node_modules instead of letting
  // electron-builder fetch the release zip (and SHASUMS) from GitHub on every build: that download fails on an
  // offline / firewalled machine (ETIMEDOUT) even though electron is installed, and it is unnecessary when the
  // dist is right there. Missing dist (a skipped binary download) keeps the normal download path.
  if (fs.existsSync(electronDist)) args.push(`--config.electronDist=${electronDist}`);
  run(process.execPath, args, DESKTOP);

  const out = path.join(CLIENT_ROOT, 'build', 'desktop');
  const artifacts = [];
  const appDir = path.join(out, 'win-unpacked');
  if (fs.existsSync(appDir)) artifacts.push({ rel: 'build/desktop/win-unpacked/', dir: appDir });
  // only report the single-file exe when this run built it: an older one may still sit in the output directory
  if (targets.includes('portable')) {
    for (const f of fs.existsSync(out) ? fs.readdirSync(out).filter((f) => f.endsWith('.exe')) : []) {
      artifacts.push({ rel: `build/desktop/${f}`, file: path.join(out, f) });
    }
  }
  const sizes = {};
  for (const a of artifacts) {
    const bytes = a.dir ? dirBytes(a.dir) : fs.statSync(a.file).size;
    sizes[a.rel] = bytes;
    console.log(`package-desktop: ${a.rel} —— ${(bytes / 1048576).toFixed(1)} MB${a.dir ? '（解压后目录）' : ''}`);
  }
  return { ...built, targets, artifacts: artifacts.map((a) => a.rel), sizes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseCommonArgs(process.argv.slice(2));
  if (o.help) console.log('usage: node tools/package-desktop.mjs [--server <address>] [--game <checkout>] [--portable] [--skip-install]');
  else buildDesktop(o);
}
