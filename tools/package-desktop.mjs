// Builds the desktop client (.exe): assemble the payload from a game checkout, install the Electron shell's deps
// when needed, then run electron-builder. See docs/PACKAGING.md.
//
//   node tools/package-desktop.mjs [--server game.starst.site] [--game <checkout>] [--dir] [--skip-install]
//
//   --server <addr>   game server the client connects to (default: client.config.json / game.starst.site)
//   --game <dir>      Stronghold-Protocol checkout (default: SP_GAME_ROOT / client.config.json / ../Stronghold-Protocol)
//   --dir             build the unpacked app directory only (fast; no portable single-file exe)
//   --skip-install    do not run `npm install` in desktop/ even when electron is missing

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLIENT_ROOT, assembleClient, parseCommonArgs } from './package-client.mjs';

const DESKTOP = path.join(CLIENT_ROOT, 'desktop');

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

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', env: childEnv() });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

const o = parseCommonArgs(process.argv.slice(2));
if (o.help) {
  console.log('usage: node tools/package-desktop.mjs [--server <address>] [--game <checkout>] [--dir] [--skip-install]');
  process.exit(0);
}
const built = assembleClient({ server: o.server, gameRoot: o.game });

const builder = pkgBin(path.join(DESKTOP, 'node_modules', 'electron-builder'), 'electron-builder');
const electronDist = path.join(DESKTOP, 'node_modules', 'electron', 'dist');
if (!builder || !fs.existsSync(electronDist)) {
  if (o.skipInstall) throw new Error('desktop/node_modules 不完整 —— 先在 desktop/ 里跑 `npm install`');
  console.log('package-desktop: 安装 Electron 壳依赖（首次约 500 MB）…');
  run('npm', ['install', '--no-audit', '--no-fund'], DESKTOP);
}

console.log(`package-desktop: 构建 ${o.dir ? '未打包目录' : '单文件 portable exe'}（服务器 ${built.server}，游戏 ${built.game.describe || built.game.app}）…`);
run(process.execPath, [builder, '--win', ...(o.dir ? ['dir'] : ['portable']), '--x64'], DESKTOP);

const out = path.join(CLIENT_ROOT, 'build', 'desktop');
for (const f of fs.existsSync(out) ? fs.readdirSync(out).filter((f) => f.endsWith('.exe')) : []) {
  const st = fs.statSync(path.join(out, f));
  console.log(`package-desktop: ${path.join('build', 'desktop', f)} (${(st.size / 1048576).toFixed(1)} MB)`);
}
console.log(`package-desktop: 免安装目录版 build/desktop/win-unpacked/StrongholdProtocol.exe`);
