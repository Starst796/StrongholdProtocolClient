// Builds the standalone client payload used by the packaged clients (Windows .exe via desktop/, Android .apk via
// Capacitor; see docs/PACKAGING.md).
//
// The browser client is written for the game server's mount layout (`/` → public/, `/data/` → data/, `/shared/` →
// shared/, `/sim/` → server/sim/*.js, `/data.js` → the DATA_SHIM). A packaged client has no Node server, so this
// flattens the mounts of a *game checkout* into one directory that any static server (or Android WebView) can serve
// as-is:
//
//   build/client/www/  index.html js/ css/ vendor/ fonts/ assets/ dev/   ← public/
//                      data/    ← data/ (+ an empty local-assets.json when the optional local art is absent)
//                      shared/  ← shared/
//                      sim/     ← server/sim/**/*.js minus the Node-only loader
//                      data.js  ← DATA_SHIM_JS (browser stand-in for server/data.js)
//                      build.json, js/runtime-config.js, js/shell/*, css/shell-display.css  ← generated (which server
//                                                                             / which game commit / shell hooks)
//
// The game checkout is never modified: the source-level hooks a packaged client needs live in
// patches/game-client.patch and are applied to the payload copy (tools/payload-patches.mjs).
//
//   node tools/package-client.mjs [--server localhost:3000] [--game <checkout>] [--out <dir>] [--quiet]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  DATA_SHIM_JS, GAME_MOUNTS, PACK_INDEX_FILE, SERVER_MOUNT, SERVER_NODE_BUILTINS, SERVER_PRIVATE, SERVER_PRIVATE_DIRS,
  SIM_PRIVATE,
  findGameRoot, readAppVersion, readProtocolVersion, verifyGameContract,
} from './game-contract.mjs';
import { PATCHED_FILES, applyPayloadPatch, assertPatched } from './payload-patches.mjs';
import { CLIENT_ROOT, androidVersionCode, readRelease } from './release-meta.mjs';

export { CLIENT_ROOT };
export const DEFAULT_SERVER = 'localhost:3000';
export const DEFAULT_OUT = path.join(CLIENT_ROOT, 'build', 'client', 'www');
export const CONFIG_FILE = path.join(CLIENT_ROOT, 'client.config.json');
/** Served when the optional local-client art was never extracted (mirrors server/index.js EMPTY_LOCAL_ART). */
const EMPTY_LOCAL_ART = JSON.stringify({ version: 1, source: 'none', count: 0, groups: {} });
/**
 * Per-mount filter (ES modules only, minus each mount's Node-only / replaced files):
 *   sim    — server/index.js serves /sim as ES modules only, minus the Node-only loader;
 *   server — the offline payload mirrors server/ so the in-page server (offline/bootstrap.js) can import the real
 *            net.js / lobby.js / match engine. server/match/* import `../sim/...`, which resolves to /server/sim/*
 *            inside the payload (the engine reads game data through the generated /server/data.js), so server/sim is
 *            mirrored here too; the browser client keeps using its own /sim mount (public/js/battle/runner.js).
 *            The node:http layer (server/http/**, SERVER_PRIVATE_DIRS) and the pack registry are left out: a
 *            packaged client serves its files itself and ships a generated /packs/index.json instead.
 */
const MOUNT_KEEP = {
  sim: (rel) => rel.endsWith('.js') && !SIM_PRIVATE.includes(path.basename(rel).toLowerCase()),
  server: (rel) => rel.endsWith('.js')
    && !SERVER_PRIVATE.includes(rel.toLowerCase())
    && !SERVER_PRIVATE_DIRS.some((dir) => rel.toLowerCase().startsWith(`${dir}/`)),
};

/** client.config.json (gameRoot pointer, defaults) — a missing file is fine. */
export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** `git -C <gameRoot> …`, or null when git/the checkout is unavailable (the manifest then omits the commit). */
function git(gameRoot, args) {
  // No shell: git.exe is found through CreateProcess' .exe fallback, and a shell would break paths with spaces.
  const r = spawnSync('git', ['-C', gameRoot, ...args], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').trim();
}

/** What the payload was built from: the game checkout's version, commit and wire protocol. */
export function gameInfo(gameRoot) {
  let name = '';
  let version = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(gameRoot, 'package.json'), 'utf8'));
    name = String(pkg.name || '');
    version = String(pkg.version || '');
  } catch { /* not fatal: the manifest just records less */ }
  return {
    name,
    version,
    app: readAppVersion(gameRoot),
    protocol: readProtocolVersion(gameRoot),
    describe: git(gameRoot, ['describe', '--tags', '--always', '--dirty']),
    commit: git(gameRoot, ['rev-parse', 'HEAD']),
    branch: git(gameRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: (git(gameRoot, ['status', '--porcelain']) || '') !== '',
  };
}

/**
 * Assemble the standalone client payload.
 * @param {{
 *   gameRoot?: string, server?: string, out?: string, patchFile?: string, skipPatches?: boolean, offline?: boolean,
 *   log?: (...a: any[]) => void, warn?: (...a: any[]) => void,
 * }} [opts]
 * @returns {{ out: string, gameRoot: string, server: string, game: object, files: number, bytes: number, copied: number, removed: number, patched: object[], missingAssets: boolean }}
 */
export function assembleClient(opts = {}) {
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.warn;
  const config = loadConfig();
  const gameRoot = path.resolve(opts.gameRoot ?? findGameRoot({ clientRoot: CLIENT_ROOT, config }));
  const server = String(opts.server ?? config.defaultServer ?? DEFAULT_SERVER).trim() || DEFAULT_SERVER;
  // The update feed the shell may poll (docs/PACKAGING.md §10). Empty = the clients make no update request at all,
  // which is the default for a fork that publishes nowhere.
  const feed = String(opts.feed ?? config.update?.feed ?? '').trim();
  // This build's number. Normally release.json (the last release); a release in progress passes its own, because
  // release.json is only advanced once the artifacts exist — without this the payload would be stamped with the
  // *previous* build and the client would keep offering itself as an update.
  const release = readRelease();
  const build = Number.isInteger(opts.build) && opts.build > 0 ? opts.build : release.build;
  const offline = !!opts.offline;
  const out = path.resolve(opts.out ?? DEFAULT_OUT);

  verifyGameContract(gameRoot);
  fs.mkdirSync(out, { recursive: true });
  const expected = new Set();
  let copied = 0;
  // Files the payload does not mirror but *derives*: the generated ones (shim, server address, provenance) and the
  // patched ones (see tools/payload-patches.mjs). Skipping them here keeps the patch from stacking on itself.
  const DERIVED = new Set(['data.js', 'server/data.js', 'js/runtime-config.js', 'build.json', PACK_INDEX_FILE, ...PATCHED_FILES]);

  /** Mirror one source tree into the payload; every mirrored path is recorded in `expected`. */
  const mirror = (relSrc, relDst, keep = null) => {
    const srcRoot = path.join(gameRoot, relSrc);
    if (!fs.existsSync(srcRoot)) {
      warn(`package-client: ${relSrc}/ 不存在 —— payload 会不完整`);
      return;
    }
    const stack = [''];
    while (stack.length) {
      const rel = stack.pop();
      for (const e of fs.readdirSync(path.join(srcRoot, rel), { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { stack.push(childRel); continue; }
        if (!e.isFile()) continue;
        if (keep && !keep(childRel)) continue;
        const relOut = relDst ? `${relDst}/${childRel}` : childRel;
        if (DERIVED.has(relOut)) continue;
        const src = path.join(srcRoot, childRel);
        const dst = path.join(out, relDst, childRel);
        const st = fs.statSync(src);
        expected.add(path.resolve(dst));
        let dstStat = null;
        try { dstStat = fs.statSync(dst); } catch { /* not copied yet */ }
        // 2 ms slack: utimes/mtime round-tripping through the file system loses sub-millisecond precision
        if (dstStat && dstStat.size === st.size && dstStat.mtimeMs >= st.mtimeMs - 2) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        fs.utimesSync(dst, st.atime, st.mtime); // keep mtimes so the next run can skip this file
        copied++;
      }
    }
  };

  for (const m of GAME_MOUNTS) mirror(m.src, m.dst, MOUNT_KEEP[m.dst] ?? null);
  // The in-page server (offline/bootstrap.js) imports the real game server code; mirror it for the offline layer.
  mirror(SERVER_MOUNT.src, SERVER_MOUNT.dst, MOUNT_KEEP.server);
  assertServerNeedsOnlyShims(out);

  /** Write a generated file (only when its content changed, so mtimes stay stable across rebuilds). */
  const writeGenerated = (relDst, body) => {
    const dst = path.join(out, relDst);
    expected.add(path.resolve(dst));
    let cur = null;
    try { cur = fs.readFileSync(dst, 'utf8'); } catch { /* new file */ }
    if (cur === body) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, body);
    copied++;
  };

  // /data.js — the browser stand-in for server/data.js (the sim's content modules import '../../../data.js').
  writeGenerated('data.js', DATA_SHIM_JS);
  // /server/data.js — the in-page server's data source (the lobby / match engine import it as `../data.js`).
  writeGenerated('server/data.js', serverDataSource(dataFileNames(gameRoot)));
  // The offline runtime layer: import-map shims, the browser data provider, the loopback socket and the boot module
  // (loaded by the patched index.html before main.js; a no-op unless the launch mode is 'solo').
  for (const [name, rel] of OFFLINE_FILES) writeGenerated(rel, offlineSource(name));
  // Optional local-client art: a static server can't synthesise the empty manifest, so materialise it.
  const localArt = path.join(out, 'data', 'local-assets.json');
  if (fs.existsSync(localArt)) expected.add(path.resolve(localArt));
  else writeGenerated(path.join('data', 'local-assets.json'), EMPTY_LOCAL_ART + '\n');
  // The packaged client's server address (read by public/js/net.js), the offline flag (read by /offline/bootstrap.js)
  // and the update feed (read by /js/shell/picker.js).
  writeGenerated('js/runtime-config.js', runtimeConfigSource(server, offline, feed));
  // /packs/index.json — the content-pack list (0.2.0). The real server answers it from a live registry
  // (server/packs.js, re-read when a pack changes); a static host cannot, so the game's own tool writes the same
  // JSON here — exactly what its release zip does (see tools/packs.mjs / docs/PACKS.md). A checkout too old to have
  // the tool simply ships no index, and the client falls back to its built-in strings.
  writePackIndex({ gameRoot, out, writeGenerated, warn });
  // The shell's pre-game server picker, its pure rules, and the display tweaks for short screens (see shell/).
  // Client-repo only: the browser build has neither file, its server is always its own origin and its HUD is the
  // one the game repo ships.
  for (const [name, rel] of SHELL_FILES) writeGenerated(rel, shellSource(name));
  // What this payload was built from — the packaged clients report it (update checks, bug reports). Deliberately
  // free of timestamps so an unchanged payload stays byte-identical (and therefore incremental). `client` is *this*
  // repo's release identity: the build counter is what an update check compares (see tools/release-meta.mjs).
  const game = gameInfo(gameRoot);
  const version = String(JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8')).version || '');
  const client = { version, build, versionCode: androidVersionCode(version, build) };
  writeGenerated('build.json', JSON.stringify({ server, game, client, feed }, null, 2) + '\n');

  // Derive the patched files into the payload (from the pristine source — never touches the game checkout).
  const patched = opts.skipPatches ? [] : applyPayloadPatch({ gameRoot, payloadRoot: out, patchFile: opts.patchFile });
  if (!opts.skipPatches) assertPatched(out);
  copied += patched.length;
  for (const f of PATCHED_FILES) expected.add(path.resolve(out, f));

  // Drop payload files whose source is gone (a stale module would otherwise keep loading after an update).
  let removed = 0;
  const sweep = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { sweep(p); continue; }
      if (expected.has(path.resolve(p))) continue;
      fs.rmSync(p, { force: true });
      removed++;
    }
  };
  sweep(out);

  // Count what actually landed in the payload (mirrored + generated files).
  let files = 0;
  let bytes = 0;
  const count = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { count(p); continue; }
      files++;
      bytes += fs.statSync(p).size;
    }
  };
  count(out);

  const missingAssets = !fs.existsSync(path.join(out, 'assets', 'char'));
  if (missingAssets) warn('package-client: public/assets 不完整 —— 先跑 `npm run assets`（打包客户端从本地读素材）');
  fs.writeFileSync(path.join(path.dirname(out), 'manifest.json'), JSON.stringify({
    server, game, client, out: path.relative(CLIENT_ROOT, out).split(path.sep).join('/'), files, bytes, generatedAt: new Date().toISOString(),
  }, null, 2) + '\n');

  const commit = game.commit ? game.commit.slice(0, 8) : '(no git)';
  log(`package-client: ${path.relative(CLIENT_ROOT, out) || out} —— ${files} 个文件, ${(bytes / 1048576).toFixed(1)} MB, 服务器 ${server}, 游戏 ${game.describe || game.app || '?'} (${commit}${game.dirty ? ', dirty' : ''}), 客户端 build ${client.build}, 补丁 ${patched.length} 文件 (${copied} written, ${removed} removed)`);
  return { out, gameRoot, server, game, client, feed, files, bytes, copied, removed, patched, missingAssets };
}

/**
 * Body of the rewritten /js/runtime-config.js. `__SP_SERVER__` is the packaged client's server address (read by
 * public/js/net.js); `__SP_OFFLINE__` makes a browser build boot into the in-page single-player server by default
 * (read by offline/bootstrap.js — the shell picker's `sp.shell.mode` overrides it); `__SP_UPDATE_FEED__` is the
 * update feed the picker may poll (read by shell/picker.js — empty means the client never asks).
 */
export function runtimeConfigSource(server, offline = false, feed = '') {
  return `// Generated by tools/package-client.mjs — do not edit (the game repo ships no such file).
globalThis.__SP_SERVER__ = ${JSON.stringify(server)};
globalThis.__SP_OFFLINE__ = ${offline ? 'true' : 'false'};
globalThis.__SP_UPDATE_FEED__ = ${JSON.stringify(feed)};
`;
}

/**
 * Write the payload's /packs/index.json by running the game repo's own pack indexer (`node tools/packs.mjs index`).
 * The index is generated against the payload's *contents* only in the sense that it lists what the checkout holds —
 * public/i18n/<code>.json and packs/<id>/pack.json — and the payload mirrors both mounts, so every URL it names
 * resolves. A checkout without the tool (0.1.x) gets no index and a warning; the client falls back.
 */
function writePackIndex({ gameRoot, out, writeGenerated, warn }) {
  const tool = path.join(gameRoot, 'tools', 'packs.mjs');
  if (!fs.existsSync(tool)) {
    warn('package-client: 游戏仓库没有 tools/packs.mjs —— 跳过 packs/index.json（语言包列表会退回内置文案）');
    return null;
  }
  const dst = path.join(out, PACK_INDEX_FILE);
  const r = spawnSync(process.execPath, [tool, 'index', '--out', dst], { cwd: gameRoot, encoding: 'utf8' });
  if (r.error || r.status !== 0 || !fs.existsSync(dst)) {
    warn(`package-client: 生成 packs/index.json 失败（${(r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').pop()}）`);
    return null;
  }
  // Read it back so it goes through writeGenerated like every other generated file (mtime-stable rebuilds).
  writeGenerated(PACK_INDEX_FILE, fs.readFileSync(dst, 'utf8'));
  return dst;
}

/** Payload paths of the shell sources: the picker (loaded by the patched index.html before main.js) and the
 * display tweaks (linked as a stylesheet after the game's own CSS). */export const SHELL_FILES = [
  ['picker.js', 'js/shell/picker.js'],
  ['picker-core.js', 'js/shell/picker-core.js'],
  ['display.css', 'css/shell-display.css'],
];

/** Body of a payload shell file — shell/<name>, copied verbatim. */
export function shellSource(name) {
  return fs.readFileSync(path.join(CLIENT_ROOT, 'shell', name), 'utf8');
}

/** Payload paths of the offline runtime layer — offline/<name>, copied verbatim (imported by the in-page server). */
export const OFFLINE_FILES = [
  ['node-crypto.js', 'offline/node-crypto.js'],
  ['node-net.js', 'offline/node-net.js'],
  ['data-provider.js', 'offline/data-provider.js'],
  ['loopback.js', 'offline/loopback.js'],
  ['game-server.js', 'offline/game-server.js'],
  ['bootstrap.js', 'offline/bootstrap.js'],
  ['host-mobile.js', 'offline/host-mobile.js'],
];

/** Body of a payload offline-layer file — offline/<name>, copied verbatim. */
export function offlineSource(name) {
  return fs.readFileSync(path.join(CLIENT_ROOT, 'offline', name), 'utf8');
}

/** Data file basenames the payload mirrors (data/*.json) — what /server/data.js fetches. */
export function dataFileNames(gameRoot) {
  try {
    return fs.readdirSync(path.join(gameRoot, 'data'))
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

/** Body of the generated /server/data.js — the in-page server's data source (browser stand-in for server/data.js). */
export function serverDataSource(files) {
  return `// Generated by tools/package-client.mjs — browser/Node stand-in for the game's server/data.js.
// The lobby / match engine import this module (as \`../data.js\`): in the browser (in-page offline server) it fetches
// /data/*.json; in the Electron main process (the "open to LAN" host) globalThis.__SP_DATA__ is the pre-parsed data
// read from disk (desktop/host-server.mjs). The import is relative so the same file resolves in both.
import { createDataModule } from '../offline/data-provider.js';

const mod = createDataModule({
  base: '/data/',
  files: ${JSON.stringify(files)},
  preloaded: (typeof globalThis !== 'undefined' && globalThis.__SP_DATA__) || null,
});

export const {
  getData, resetData, loadData, setData, lookup, getConfig, getMode,
  getChess, getBond, getGarrison, getItem, getBand, getEffect,
  getEnemy, getWave, getStage, getBoss, getToken,
} = mod;
export const DATA_FILES = mod.DATA_FILES;
export const DATA_DIR = mod.DATA_DIR;
export const ROOT = mod.ROOT;
export const deepFreeze = mod.deepFreeze;
export const INDEXED_FILES = mod.INDEXED_FILES;
`;
}

/**
 * The in-page server runs the game's server code, so it may only import the node builtins the payload ships shims
 * for (SERVER_NODE_BUILTINS, mapped in index.html). If upstream adds another `node:` import it would break at
 * runtime in the WebView; fail the build instead.
 * @param {string} payloadRoot
 */
export function assertServerNeedsOnlyShims(payloadRoot) {
  const dir = path.join(payloadRoot, 'server');
  if (!fs.existsSync(dir)) return;
  const allowed = new Set(SERVER_NODE_BUILTINS);
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { stack.push(childRel); continue; }
      if (!e.isFile() || !e.name.endsWith('.js')) continue;
      // Strip comments first: JSDoc type references like `import('node:http').IncomingMessage` are not real imports.
      const body = fs.readFileSync(path.join(dir, childRel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      for (const m of body.matchAll(/['"](node:[a-z_/]+)['"]/g)) {
        if (!allowed.has(m[1])) {
          throw new Error(`server/${childRel} imports ${m[1]}, which the offline shims do not provide — `
            + `add a shim in offline/ and map it in patches/game-client.patch (allowed: ${[...allowed].join(', ')})`);
        }
      }
    }
  }
}

/** CLI arguments shared by package-client / package-desktop / package-android. */
export function parseCommonArgs(argv) {
  const o = { server: undefined, game: undefined, out: undefined, feed: undefined, build: undefined, quiet: false, release: false, dir: false, portable: false, skipInstall: false, offline: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const val = () => (eq === -1 ? argv[++i] : a.slice(eq + 1));
    if (key === '--server') o.server = val();
    else if (key === '--game') o.game = val();
    else if (key === '--out') o.out = val();
    // Override the update feed from client.config.json (docs/PACKAGING.md §10): a staging feed, or a local one.
    else if (key === '--feed') o.feed = val();
    // The build number to stamp into the payload (package-release passes the one it is producing).
    else if (key === '--build') o.build = Number(val());
    else if (key === '--quiet') o.quiet = true;
    else if (key === '--release') o.release = true;
    // `--dir` is the desktop default now; still accepted so older command lines keep working.
    else if (key === '--dir') o.dir = true;
    else if (key === '--portable') o.portable = true;
    else if (key === '--skip-install') o.skipInstall = true;
    // A web build that boots into the in-page single-player server (packaged clients pick it from the shell menu).
    else if (key === '--offline') o.offline = true;
    else if (key === '-h' || key === '--help') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseCommonArgs(process.argv.slice(2));
  if (o.help) console.log('usage: node tools/package-client.mjs [--server <address>] [--game <checkout>] [--out <dir>] [--feed <url>] [--build <n>] [--offline] [--quiet]');
  else assembleClient({ server: o.server, gameRoot: o.game, out: o.out, feed: o.feed, build: o.build, offline: o.offline, log: o.quiet ? () => {} : console.log });
}
