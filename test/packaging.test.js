// Pins the contracts this repo has with the game repo (Stronghold-Protocol) and with its own build output:
//
//   * the payload patch (patches/game-client.patch) is applied by tools/unified-diff.mjs, not by git �?its format
//     assumptions are asserted here, and the patch is re-applied to a pristine copy of the real checkout so that
//     upstream drift fails the tests instead of shipping a client that connects to the wrong server;
//   * DATA_SHIM_JS / SIM_PRIVATE are duplicated in tools/game-contract.mjs (so the build needs no `npm install` in
//     the game checkout) and must still match server/index.js;
//   * assembling a payload flattens exactly the mounts server/index.js exposes, into an incremental directory.
//
// Tests that need a game checkout skip themselves when it is absent (a fresh clone without the sibling checkout).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyPatch, parsePatch, stripPath } from '../tools/unified-diff.mjs';
import { DATA_SHIM_JS, SIM_PRIVATE, findGameRoot, isGameRoot, readGameContract, verifyGameContract, readProtocolVersion } from '../tools/game-contract.mjs';
import { PATCHED_FILES, applyPayloadPatch, assertPatched } from '../tools/payload-patches.mjs';
import { buildPatch, applyHooks } from '../tools/regen-patch.mjs';
import { assembleClient, runtimeConfigSource, DEFAULT_SERVER, CLIENT_ROOT, SHELL_FILES, OFFLINE_FILES, assertServerNeedsOnlyShims, parseCommonArgs } from '../tools/package-client.mjs';
import { desktopTargets } from '../tools/package-desktop.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The game checkout, or null (then the contract tests skip themselves). */
const GAME_ROOT = (() => {
  try {
    return findGameRoot({ clientRoot: ROOT });
  } catch {
    return null;
  }
})();

const write = (root, rel, body) => {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
};

/** A tiny game checkout: only the files the assembler / contract reader looks at. */
function makeGameFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'sp-game-'));
  const patch = mkdtempSync(path.join(tmpdir(), 'sp-patch-'));
  // public/ �?payload root
  write(root, 'public/index.html', '<html>\n<script type="module" src="/js/main.js"></script>\n</html>\n');
  write(root, 'public/js/net.js', "// net\n/** WebSocket URL. */\nexport function defaultWsUrl() { return 'ws://x/ws'; }\n");
  write(root, 'public/js/screens/room.js', '// room\n/** Invite link. */\nexport function inviteLink(code) { return `?room=${code}`; }\n');
  write(root, 'public/js/screens/lobby.js', '// lobby\nimport { A } from "../../../shared/constants.js";\nexport const L = 1;\n');
  write(root, 'public/js/main.js', 'export {};\n');
  write(root, 'public/assets/char/x.png', 'png');
  // data/, shared/, server/
  write(root, 'data/chess.json', '{"a":1}');
  write(root, 'shared/constants.js', "export const PROTOCOL_VERSION = 1;\nexport const APP_VERSION = '0.1.0';\n");
  write(root, 'server/sim/simdata.js', 'export function getSimData() { return null; }\n');
  write(root, 'server/sim/units.js', 'export const U = 1;\n');
  write(root, 'server/sim/content/support/index.js', 'export const S = 1;\n');
  write(root, 'server/sim/nodeData.js', 'node only\n');
  // server/ mirror: the in-page server (only .js, no sim/ child, no Node-only / replaced files)
  write(root, 'server/net.js', "import { randomBytes } from 'node:crypto';\nimport { isIP } from 'node:net';\nexport const N = 1;\n");
  write(root, 'server/lobby.js', "import { randomInt } from 'node:crypto';\nexport const L = 1;\n");
  write(root, 'server/match/Match.js', 'export const M = 1;\n');
  write(root, 'server/match/StubMatch.js', 'stub\n');
  // the two declarations tools/game-contract.mjs mirrors (kept byte-identical to the real values)
  write(root, 'server/index.js', `export const DATA_SHIM_JS = \`${DATA_SHIM_JS}\`;\nconst SIM_PRIVATE = new Set(['nodedata.js']);\n`);
  // a stand-in for patches/game-client.patch, against the three files above
  const patchFile = path.join(patch, 'game-client.patch');
  writeFileSync(patchFile, [
    'diff --git a/public/index.html b/public/index.html',
    '--- a/public/index.html',
    '+++ b/public/index.html',
    '@@ -1,3 +1,6 @@',
    ' <html>',
    '+<link rel="stylesheet" href="/css/shell-display.css">',
    '+<script src="/js/runtime-config.js"></script>',
    '+<script type="module" src="/js/shell/picker.js"></script>',
    ' <script type="module" src="/js/main.js"></script>',
    ' </html>',
    'diff --git a/public/js/net.js b/public/js/net.js',
    '--- a/public/js/net.js',
    '+++ b/public/js/net.js',
    '@@ -1,3 +1,4 @@',
    ' // net',
    '+// patched: resolveServerTarget reads globalThis.__SP_SERVER__ and ?server=',
    ' /** WebSocket URL. */',
    " export function defaultWsUrl() { return 'ws://x/ws'; }",
    'diff --git a/public/js/screens/room.js b/public/js/screens/room.js',
    '--- a/public/js/screens/room.js',
    '+++ b/public/js/screens/room.js',
    '@@ -1,3 +1,4 @@',
    ' // room',
    '+// patched: invite links use toHttpUrl()',
    ' /** Invite link. */',
    ' export function inviteLink(code) { return `?room=${code}`; }',
    'diff --git a/public/js/screens/lobby.js b/public/js/screens/lobby.js',
    '--- a/public/js/screens/lobby.js',
    '+++ b/public/js/screens/lobby.js',
    '@@ -1,3 +1,3 @@',
    ' // lobby',
    '-import { A } from "../../../shared/constants.js";',
    '+import { ERR, A } from "../../../shared/constants.js";',
    ' export const L = 1;',
    '',
  ].join('\n'));
  return { root, patchFile };
}

describe('unified diff applier', () => {
  test('parses files and hunks', () => {
    const files = parsePatch(readFileSync(path.join(ROOT, 'patches', 'game-client.patch'), 'utf8'));
    assert.equal(files.length, PATCHED_FILES.length);
    assert.deepEqual(files.map((f) => stripPath(f.newPath, 2)).sort(), [...PATCHED_FILES].sort());
    // index.html 2 + net.js 2 + room.js 2 + lobby.js 1
    assert.equal(files.reduce((n, f) => n + f.hunks.length, 0), 7);
  });

  test('applies a patch, and refuses to apply it where the context no longer matches', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sp-diff-'));
    try {
      write(dir, 'a.txt', 'one\ntwo\nthree\n');
      const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n one\n+inserted\n two\n three\n';
      applyPatch(dir, patch, { strip: 1 });
      assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\ninserted\ntwo\nthree\n');
      // the context is gone now ("one / two / three" are no longer consecutive) �?the applier must fail, not guess
      assert.throws(() => applyPatch(dir, patch, { strip: 1 }), /does not match/);
      write(dir, 'b.txt', 'nothing\nlike\nthis\n');
      assert.throws(() => applyPatch(dir, '--- a/b.txt\n+++ b/b.txt\n@@ -1,3 +1,4 @@\n one\n+inserted\n two\n three\n', { strip: 1 }), /does not match/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses paths that escape the root', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sp-diff-'));
    try {
      assert.throws(() => applyPatch(dir, '--- a/../../evil.txt\n+++ b/../../evil.txt\n@@ -1 +1 @@\n-x\n+y\n', { strip: 1 }), /escapes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps CRLF line endings', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sp-diff-'));
    try {
      write(dir, 'c.txt', 'one\r\ntwo\r\n');
      applyPatch(dir, '--- a/c.txt\n+++ b/c.txt\n@@ -1,2 +1,3 @@\n one\n+mid\n two\n', { strip: 1 });
      assert.equal(readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'one\r\nmid\r\ntwo\r\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('game-repo contract', { skip: GAME_ROOT ? false : 'no Stronghold-Protocol checkout next to this repo' }, () => {
  test('the patch is plain `git diff` output (what the applier supports)', () => {
    const text = readFileSync(path.join(ROOT, 'patches', 'game-client.patch'), 'utf8');
    assert.ok(!/\r/.test(text), 'no CRLF');
    assert.ok(!/\\ No newline/.test(text), 'no "\\ No newline at end of file" markers');
    assert.ok(!/^(rename|copy|new file|deleted file|old mode|new mode|similarity)/m.test(text), 'no renames/mode changes');
    assert.ok(!text.includes('\uFEFF'), 'no BOM');
  });

  test('DATA_SHIM_JS / SIM_PRIVATE match server/index.js', () => {
    assert.doesNotThrow(() => verifyGameContract(GAME_ROOT));
    const { shim, simPrivate } = readGameContract(readFileSync(path.join(GAME_ROOT, 'server', 'index.js'), 'utf8'));
    assert.equal(shim, DATA_SHIM_JS);
    assert.deepEqual(simPrivate, [...SIM_PRIVATE]);
    assert.equal(typeof readProtocolVersion(GAME_ROOT), 'number');
    assert.ok(isGameRoot(GAME_ROOT));
  });

  test('the shell serves the payload with the game server"s MIME table', async () => {
    const { MIME } = await import('../desktop/serve.mjs');
    const src = readFileSync(path.join(GAME_ROOT, 'server', 'index.js'), 'utf8');
    const block = /export const MIME = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(src);
    assert.ok(block, 'MIME 表解析失败：游戏仓库 server/index.js 的 MIME 写法变了');
    const pairs = [...block[1].matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
    assert.ok(pairs.length > 20, `MIME 表只解析出 ${pairs.length} 条，解析可能失效`);
    assert.deepEqual({ ...MIME }, Object.fromEntries(pairs));
  });

  test('patches/game-client.patch is in sync with the hooks (regenerate with tools/regen-patch.mjs)', () => {
    // buildPatch() re-derives the patch from the checkout's current files, so a stale committed patch (upstream
    // bumped room.js and the recorded context rotted) fails here in `npm test`, not only at packaging time.
    const committed = readFileSync(path.join(ROOT, 'patches', 'game-client.patch'), 'utf8');
    assert.equal(committed, buildPatch(GAME_ROOT), 'run `node tools/regen-patch.mjs` and commit the result');
    assert.ok(!/\r/.test(committed), 'the patch is LF-only');
  });

  test('the hooks are anchored string replacements (no full-file copy)', () => {
    const src = {};
    for (const f of PATCHED_FILES) src[f] = readFileSync(path.join(GAME_ROOT, 'public', f), 'utf8');
    const out = applyHooks(src);
    for (const f of PATCHED_FILES) assert.notEqual(out[f], src[f], `${f} must be changed by the hooks`);
  });

  test('the payload patch still applies to this checkout (upstream drift fails the build)', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'sp-payload-'));
    try {
      for (const f of PATCHED_FILES) {
        write(out, f, readFileSync(path.join(GAME_ROOT, 'public', f), 'utf8'));
      }
      const applied = applyPayloadPatch({ gameRoot: GAME_ROOT, payloadRoot: out });
      assert.deepEqual([...applied].sort(), [...PATCHED_FILES].sort());
      assert.doesNotThrow(() => assertPatched(out));
      const net = readFileSync(path.join(out, 'js', 'net.js'), 'utf8');
      assert.match(net, /export function toWsUrl\(raw\)/);
      assert.match(net, /export function toHttpUrl\(raw\)/);
      // the patched defaultWsUrl must consult the override before falling back to the page's own origin
      assert.match(net, /const target = resolveServerTarget\(loc\);/);
      assert.match(readFileSync(path.join(out, 'js', 'screens', 'room.js'), 'utf8'), /toHttpUrl\(target\)/);
      assert.match(readFileSync(path.join(out, 'index.html'), 'utf8'), /<script src="\/js\/runtime-config\.js"><\/script>/);
      // the picker must be an ES module and come *before* main.js: module scripts run in document order
      const html = readFileSync(path.join(out, 'index.html'), 'utf8');
      const pickerAt = html.indexOf('<script type="module" src="/js/shell/picker.js">');
      assert.ok(pickerAt !== -1, 'index.html must load /js/shell/picker.js');
      assert.ok(pickerAt < html.indexOf('<script type="module" src="/js/main.js"'), 'the picker runs before the game boots');
      // the offline bootstrap runs before the game too, and the import map maps the node builtins its server imports
      const bootstrapAt = html.indexOf('<script type="module" src="/offline/bootstrap.js">');
      assert.ok(bootstrapAt !== -1, 'index.html must load /offline/bootstrap.js');
      assert.ok(bootstrapAt < html.indexOf('<script type="module" src="/js/main.js"'), 'the offline bootstrap runs before the game boots');
      // the picker must load *before* the offline layer: it captures the real WebSocket constructor at module load
      assert.ok(pickerAt < bootstrapAt, 'the picker loads before /offline/bootstrap.js (it captures the native WebSocket)');
      // the phone-side LAN host defines window.__SP_HOST__ before the picker reads it. It must be a CLASSIC script:
      // a module would be deferred, and a module still fetching its graph does not block the next one — measured on
      // a real WebView, picker.js ran ~140 ms first and the 创建服务器 entry disappeared.
      const hostMobileAt = html.indexOf('<script src="/offline/host-mobile.js"></script>');
      assert.ok(hostMobileAt !== -1, 'index.html must load /offline/host-mobile.js as a classic script');
      assert.ok(!html.includes('<script type="module" src="/offline/host-mobile.js">'), 'as a module script it could run after the picker');
      assert.ok(hostMobileAt < pickerAt, '/offline/host-mobile.js defines window.__SP_HOST__ before the picker reads it');
      assert.match(html, /"node:crypto": "\/offline\/node-crypto\.js"/);
      assert.match(html, /"node:net": "\/offline\/node-net\.js"/);
      // ...and the shell stylesheet must come after every game stylesheet, so it wins on equal specificity
      const cssAt = html.indexOf('/css/shell-display.css');
      assert.ok(cssAt !== -1, 'index.html must link /css/shell-display.css');
      assert.ok(cssAt > html.lastIndexOf('/css/devices.css'), 'the shell stylesheet is loaded last');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('open to LAN wiring (desktop shell ↔ picker)', () => {
  const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
  const main = read('desktop/main.mjs');
  const preload = read('desktop/preload.cjs');
  const picker = read('shell/picker.js');

  test('the preload bridge and the main handlers agree on the IPC channels', () => {
    for (const ch of ['host:start', 'host:stop', 'host:status']) {
      assert.ok(preload.includes(`'${ch}'`), `preload.cjs must invoke ${ch}`);
      assert.ok(main.includes(`ipcMain.handle('${ch}'`), `main.mjs must handle ${ch}`);
    }
    // the window must actually load the preload, or window.__SP_HOST__ never appears
    assert.match(main, /preload:\s*path\.join\(HERE, 'preload\.cjs'\)/);
  });

  test('the picker uses the bridge and degrades when it is absent (web / Android)', () => {
    assert.match(picker, /globalThis\.__SP_HOST__/, 'the picker reads the host bridge');
    assert.match(picker, /host\.start\(hostPortValue\(typed\)\)/, 'the LAN panel passes the typed port to the host');
    assert.match(picker, /host\.stop\(\)/, 'and can stop it');
    assert.match(picker, /hostPortError\(typed\)/, 'the typed port is validated before the shell sees it');
    assert.match(picker, /if \(!host\) \{ el\.style\.display = 'none'/, 'the panel hides without a bridge');
  });

  test('the home menu is 单人游戏 / 创建服务器 / 加入服务器', () => {
    // 单人游戏 and 加入服务器 are always present; 创建服务器 is injected only when the shell exposes the bridge.
    assert.match(picker, /id="sp-solo"/);
    assert.match(picker, /id="sp-join"/);
    assert.match(picker, /id="sp-host"/);
    assert.match(picker, /const hostButton = host\s*\n?\s*\?/, 'the host entry is desktop-only');
    assert.match(picker, /screen === 'host' \? HOST_HTML : MULTI_HTML/, 'the host screen exists');
    assert.match(picker, /id="sp-lan"/, 'the LAN panel lives on the host screen');
    // Escape returns to the mode menu from any sub-screen, then leaves the picker (F2 over a running game)
    assert.match(picker, /else if \(screen !== 'home'\) \{ screen = 'home'/);
    assert.match(picker, /else hidePicker\(\);/);
    // the listener must be on document (the picker never holds focus), and be removed on destroy
    assert.match(picker, /document\.addEventListener\('keydown', onKeyDown\)/);
    assert.match(picker, /document\.removeEventListener\('keydown', onKeyDown\)/);
    assert.ok(!/root\.addEventListener\('keydown'/.test(picker), 'a root-level listener would never fire');
  });

  test('the payload patch fixes upstream lobby.js (spectator ERR import)', () => {
    const patch = read('patches/game-client.patch');
    assert.match(patch, /diff --git a\/public\/js\/screens\/lobby\.js/);
    assert.match(patch, /^\+import \{ ERR,/m, 'the ERR import is added');
    assert.ok(PATCHED_FILES.includes('js/screens/lobby.js'));
  });

  test('a LAN guest skips the picker and stays on its own origin', () => {
    assert.match(picker, /globalThis\.__SP_LAN_CLIENT__/, 'the picker reads the LAN-guest flag');
    assert.match(picker, /const savedAddress = lanClient \? null :/, 'a remembered server must not hijack a guest');
    assert.match(picker, /if \(!lanClient && shouldShowPicker/, 'a guest never sees the picker');
    // the host serves the guest its own runtime-config (host.test.js covers the response body)
    assert.match(read('desktop/host-server.mjs'), /__SP_LAN_CLIENT__ = true/);
  });

  test('the desktop shell ships the host files and the ws dependency', () => {
    const pkg = JSON.parse(read('desktop/package.json'));
    for (const f of ['host-server.mjs', 'preload.cjs']) assert.ok(pkg.build.files.includes(f), `${f} must ship in the app`);
    assert.ok(pkg.dependencies && pkg.dependencies.ws, 'ws is a runtime dependency of the shell');
  });
});

describe('shell picker latency probe', () => {
  // In single-player the offline layer replaces globalThis.WebSocket with the in-page loopback; probing through it
  // made every listed server report "可连接 · 0ms" (and 刷新 could not tell them apart). The picker must keep the
  // real constructor captured at module load (before /offline/bootstrap.js) and probe with that.
  const src = readFileSync(path.join(ROOT, 'shell', 'picker.js'), 'utf8');

  test('captures the real WebSocket at module load', () => {
    assert.match(src, /const NativeWebSocket = globalThis\.WebSocket;/);
  });

  test('the probe constructs the captured constructor, never the (overridable) global', () => {
    assert.match(src, /socket = new NativeWebSocket\(wsUrl\);/);
    assert.ok(!/new WebSocket\(/.test(src), 'a bare `new WebSocket(` would use the offline loopback in single-player');
  });

  test('the override can only ever see the loopback', () => {
    const off = readFileSync(path.join(ROOT, 'offline', 'bootstrap.js'), 'utf8');
    assert.match(off, /globalThis\.WebSocket = function OfflineWebSocket/);
  });
});

describe('offline server node-builtin guard', () => {
  test('allows the shimmed builtins, ignores comments, rejects anything else', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sp-offline-'));
    try {
      // node:http appears only in a JSDoc type position — not a real import, must not trip the guard
      write(dir, 'server/net.js', "import { randomBytes } from 'node:crypto';\nimport { isIP } from 'node:net';\n/** @param {import('node:http').IncomingMessage} r */\nexport const N = 1;\n");
      write(dir, 'server/lobby.js', "import { randomInt } from 'node:crypto';\nexport const L = 1;\n");
      assert.doesNotThrow(() => assertServerNeedsOnlyShims(dir));
      write(dir, 'server/match/M.js', "import fs from 'node:fs';\n");
      assert.throws(() => assertServerNeedsOnlyShims(dir), /node:fs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('client payload assembly', () => {
  let game;
  before(() => { game = makeGameFixture(); });
  after(() => {
    rmSync(game.root, { recursive: true, force: true });
    rmSync(path.dirname(game.patchFile), { recursive: true, force: true });
  });

  test('flattens the server mounts, writes the generated files and applies the patch', () => {
    const out = path.join(game.root, 'build', 'client', 'www');
    const r = assembleClient({ gameRoot: game.root, patchFile: game.patchFile, out, log: () => {} });
    assert.equal(r.server, DEFAULT_SERVER);
    assert.equal(r.missingAssets, false);
    assert.equal(r.patched.length, PATCHED_FILES.length);
    for (const rel of ['index.html', 'js/main.js', 'assets/char/x.png', 'data/chess.json', 'shared/constants.js', 'sim/units.js', 'sim/content/support/index.js', 'data.js', 'build.json', 'js/runtime-config.js', 'js/shell/picker.js', 'js/shell/picker-core.js', 'data/local-assets.json', 'offline/node-crypto.js', 'offline/node-net.js', 'offline/data-provider.js', 'offline/loopback.js', 'offline/game-server.js', 'offline/bootstrap.js', 'offline/host-mobile.js', 'server/data.js', 'server/net.js', 'server/lobby.js', 'server/match/Match.js', 'server/sim/units.js']) {
      assert.ok(existsSync(path.join(out, rel)), `${rel} must be in the payload`);
    }
    // the offline layer is copied verbatim (its /offline/* imports must resolve)
    for (const [name, rel] of OFFLINE_FILES) {
      assert.equal(readFileSync(path.join(out, rel), 'utf8'), readFileSync(path.join(ROOT, 'offline', name), 'utf8'));
    }
    // the in-page server's data source lists the data files the payload mirrors
    assert.match(readFileSync(path.join(out, 'server', 'data.js'), 'utf8'), /files: \["chess"\]/);
    // ...and server/ ships the runtime modules only: no entry point, no fs data loader, no Node-only / stub files
    assert.ok(!existsSync(path.join(out, 'server', 'index.js')));
    assert.ok(!existsSync(path.join(out, 'server', 'nodeData.js')));
    assert.ok(!existsSync(path.join(out, 'server', 'sim', 'nodeData.js')));
    assert.ok(!existsSync(path.join(out, 'server', 'match', 'StubMatch.js')));
    // the picker and the display tweaks are copied verbatim, so /js/shell/picker.js can import ../net.js and
    // ./picker-core.js, and css/shell-display.css overrides css/devices.css by load order
    for (const [name, rel] of SHELL_FILES) {
      assert.equal(readFileSync(path.join(out, rel), 'utf8'), readFileSync(path.join(ROOT, 'shell', name), 'utf8'));
    }
    // Node-only sim loader is never shipped
    assert.ok(!existsSync(path.join(out, 'sim', 'nodeData.js')));
    // /data.js is the game's shim, byte for byte
    assert.equal(readFileSync(path.join(out, 'data.js'), 'utf8'), DATA_SHIM_JS);
    // the empty local-art manifest stands in for the server's synthesised response
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'data', 'local-assets.json'), 'utf8')).groups, {});
    // the packaged client's server address + build provenance
    assert.equal(readFileSync(path.join(out, 'js', 'runtime-config.js'), 'utf8'), runtimeConfigSource(DEFAULT_SERVER));
    const build = JSON.parse(readFileSync(path.join(out, 'build.json'), 'utf8'));
    assert.equal(build.server, DEFAULT_SERVER);
    assert.equal(build.game.app, '0.1.0');
    assert.equal(build.game.protocol, 1);
    // the patch landed on the payload copy, not on the checkout
    assert.doesNotThrow(() => assertPatched(out));
    assert.match(readFileSync(path.join(out, 'js', 'net.js'), 'utf8'), /__SP_SERVER__/);
    assert.ok(!readFileSync(path.join(game.root, 'public', 'js', 'net.js'), 'utf8').includes('__SP_SERVER__'), 'the checkout is never modified');
    // manifest.json lands next to www/ for the build scripts
    assert.equal(JSON.parse(readFileSync(path.join(game.root, 'build', 'client', 'manifest.json'), 'utf8')).server, DEFAULT_SERVER);
  });

  test('is incremental and drops payload files whose source is gone', () => {
    const out = path.join(game.root, 'build', 'client', 'www');
    const second = assembleClient({ gameRoot: game.root, patchFile: game.patchFile, out, log: () => {} });
    assert.equal(second.copied, 0, 'nothing is rewritten when nothing changed');
    const stale = path.join(out, 'js', 'deleted.js');
    writeFileSync(stale, 'export {};\n');
    const third = assembleClient({ gameRoot: game.root, patchFile: game.patchFile, out, log: () => {} });
    assert.equal(third.removed, 1);
    assert.ok(!existsSync(stale));
  });

  test('a custom --server address is what the payload connects to', () => {
    const out = path.join(game.root, 'build', 'other', 'www');
    const r = assembleClient({ gameRoot: game.root, patchFile: game.patchFile, server: '192.168.1.9:3000', out, log: () => {} });
    assert.equal(r.server, '192.168.1.9:3000');
    assert.match(readFileSync(path.join(r.out, 'js', 'runtime-config.js'), 'utf8'), /"192\.168\.1\.9:3000"/);
  });
});

test('the packaged clients default to a server the player runs locally', () => {
  assert.equal(DEFAULT_SERVER, 'localhost:3000');
  assert.match(runtimeConfigSource(DEFAULT_SERVER), /globalThis\.__SP_SERVER__ = "localhost:3000";/);
  assert.match(runtimeConfigSource(DEFAULT_SERVER), /globalThis\.__SP_OFFLINE__ = false;/, 'packaged clients default to the shell picker');
  assert.match(runtimeConfigSource(DEFAULT_SERVER, true), /globalThis\.__SP_OFFLINE__ = true;/, '--offline boots the web build into single-player');
  // client.config.json points at the sibling checkout and the local server
  const config = JSON.parse(readFileSync(path.join(CLIENT_ROOT, 'client.config.json'), 'utf8'));
  assert.equal(config.gameRoot, '../Stronghold-Protocol');
  assert.equal(config.defaultServer, DEFAULT_SERVER);
  // ...and the shells ship the same defaults
  assert.equal(JSON.parse(readFileSync(path.join(ROOT, 'mobile', 'capacitor.config.json'), 'utf8')).appId, 'site.starst.stronghold');
  assert.equal(JSON.parse(readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8')).build.appId, 'site.starst.stronghold');
});

describe('mobile (Android) shell', () => {
  const android = (rel) => readFileSync(path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', rel), 'utf8');

  test('the window fills the display: cutout allowed, system bars hidden, landscape locked', () => {
    const manifest = android('AndroidManifest.xml');
    assert.match(manifest, /android:screenOrientation="sensorLandscape"/, 'the game is landscape-only (see its rotate hint)');

    // both themes the activity can be created with must let the window draw into the cutout strip, otherwise the
    // system letterboxes it in landscape and that strip is the black bar along the edge
    const styles = android('res/values/styles.xml');
    assert.equal((styles.match(/>shortEdges</g) || []).length, 2, 'AppTheme.NoActionBar + AppTheme.NoActionBarLaunch');

    const activity = android('java/site/starst/stronghold/MainActivity.java');
    assert.match(activity, /WindowCompat\.setDecorFitsSystemWindows\(getWindow\(\), false\)/, 'the WebView draws under the bars');
    assert.match(activity, /hide\(WindowInsetsCompat\.Type\.systemBars\(\)\)/, 'the bars are hidden (immersive)');
    assert.match(activity, /onWindowFocusChanged/, 'a swipe or dialog must not leave the bars on screen');
  });

  test('the shell stylesheet rescales the HUD on short landscape screens only', () => {
    const css = readFileSync(path.join(ROOT, 'shell', 'display.css'), 'utf8');
    assert.match(css, /@media \(orientation: landscape\) and \(max-height: 480px\)/);
    // the same formula as css/theme.css, minus the 40 px floor that made the prep camera zoom the scene out
    assert.match(css, /clamp\(28px, min\(calc\(100vw \/ 19\.2\), calc\(100svh \/ 10\.8\)\), 240px\)/);
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, ''); // prose mentions the old formula
    assert.ok(!/clamp\(40px/.test(declarations), 'the 40 px floor is exactly what the override removes');
  });
});

describe('desktop packaging layout', () => {
  test('the default build is the folder, not the self-extracting single file', () => {
    // The portable exe unpacks the whole app to %TEMP% on every launch (~24 s to the first screen vs ~0.5 s),
    // so the folder is the default and the single file is opt-in.
    assert.deepEqual(desktopTargets(), ['dir']);
    assert.deepEqual(desktopTargets({}), ['dir']);
  });

  test('--portable is the opt-in for the single self-extracting file', () => {
    assert.deepEqual(desktopTargets({ portable: true }), ['portable']);
  });

  test('electron-builder config agrees: folder target, trimmed locales, payload as resources/www', () => {
    const build = JSON.parse(readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8')).build;
    assert.deepEqual(build.win.target, ['dir']);
    // Electron ships ~48 locales (~48 MB); a Chinese/English game only needs these two.
    assert.deepEqual(build.electronLanguages, ['zh-CN', 'en-US']);
    assert.deepEqual(build.extraResources, [{ from: '../build/client/www', to: 'www' }]);
    assert.equal(build.directories.output, '../build/desktop');
  });

  test('the packager reads those flags from the command line', () => {
    const o = parseCommonArgs(['--server', 'x:1', '--portable']);
    assert.equal(o.server, 'x:1');
    assert.equal(o.portable, true);
    assert.equal(parseCommonArgs([]).portable, false);
    assert.equal(parseCommonArgs(['--dir']).dir, true, '--dir is still accepted (it is the default now)');
    assert.equal(parseCommonArgs(['--offline']).offline, true, '--offline builds a web client that boots single-player');
    assert.equal(parseCommonArgs([]).offline, false);
    assert.throws(() => parseCommonArgs(['--nope']), /unknown option/);
  });
});

describe('desktop shell: a stable loopback origin keeps localStorage', () => {
  // Chromium scopes localStorage/sessionStorage by origin. The shell serves the payload over http://127.0.0.1:<port>,
  // so an OS-assigned port every launch (the old `port: 0`) is a different origin every time — the game's identity
  // token (sp.tokens), loadout (sp.pref.loadout), settings and the picker's saved server all read back empty, i.e.
  // "restarting loses the loadout / login". Binding a pinned port is the whole fix; these tests keep it pinned.
  const HTML = '<!doctype html><title>t</title>';

  /** Bind an http server to a free port low enough that PORT_SEARCH ports above it also exist. */
  async function occupyPortAbove(port) {
    for (let p = port; p <= 65535 - 32; p++) {
      const s = http.createServer();
      try {
        await new Promise((resolve, reject) => { s.once('error', reject); s.listen(p, '127.0.0.1', resolve); });
        return { server: s, port: p };
      } catch { s.close(); }
    }
    return null;
  }

  test('serve.mjs pins a concrete port and exports the fallback width', async () => {
    const { DEFAULT_PORT, PORT_SEARCH } = await import('../desktop/serve.mjs');
    assert.ok(Number.isInteger(DEFAULT_PORT) && DEFAULT_PORT > 1023 && DEFAULT_PORT < 65536, 'a concrete, non-privileged port');
    assert.ok(Number.isInteger(PORT_SEARCH) && PORT_SEARCH > 1);
  });

  test('the desktop window is pointed at that stable origin (never an ephemeral port)', () => {
    const src = readFileSync(path.join(ROOT, 'desktop', 'main.mjs'), 'utf8');
    assert.match(src, /import \{[^}]*DEFAULT_PORT[^}]*\} from '\.\/serve\.mjs'/, 'main.mjs must use the pinned port');
    assert.match(src, /createStaticServer\(\{[^}]*port:\s*DEFAULT_PORT/, 'the static server must be given the pinned port');
  });

  test('TLS: the shells ask once per server (trust-on-first-use) instead of verifying nothing', () => {
    const src = readFileSync(path.join(ROOT, 'desktop', 'main.mjs'), 'utf8');
    assert.match(src, /app\.on\('certificate-error'/, 'the desktop shell decides per certificate');
    assert.match(src, /event\.preventDefault\(\)/, 'it must take over Electron\'s default (reject) decision');
    assert.match(src, /process\.argv\.includes\('--insecure-tls'\)/, '--insecure-tls answers without asking');
    assert.ok(!/appendSwitch\('ignore-certificate-errors'\)/.test(src), 'verification is never disabled app-wide');
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
    assert.ok(pkg.build.files.includes('trust.mjs'), 'desktop/trust.mjs must ship with the shell');
    const android = readFileSync(path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'java', 'site', 'starst', 'stronghold', 'MainActivity.java'), 'utf8');
    assert.match(android, /onReceivedSslError/, 'the Android shell hooks SSL errors as well');
    assert.match(android, /setWebViewClient\(new BridgeWebViewClient\(bridge\)/, 'it keeps Capacitor\'s client (local payload + bridge)');
  });

  test('a busy port falls through to the next free one (deterministically) instead of failing', async () => {
    const { createStaticServer, PORT_SEARCH } = await import('../desktop/serve.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'sp-serve-'));
    writeFileSync(path.join(root, 'index.html'), HTML);
    const blocker = await occupyPortAbove(50000);
    if (!blocker) return; // no free port to occupy: nothing to assert on this machine
    let served;
    try {
      served = await createStaticServer({ root, port: blocker.port, log: { warn() {}, error() {} } });
      assert.notEqual(served.port, blocker.port, 'the busy port is skipped');
      assert.ok(served.port > blocker.port && served.port <= blocker.port + PORT_SEARCH, `landed on ${served.port}, searched from ${blocker.port}`);
      assert.equal(served.url, `http://127.0.0.1:${served.port}`, 'the origin is the loopback host + chosen port');
      // and the payload is actually served from that origin (200 + body)
      const got = await new Promise((resolve, reject) => {
        http.get(`${served.url}/index.html`, (r) => {
          let d = '';
          r.on('data', (c) => { d += c; });
          r.on('end', () => resolve({ status: r.statusCode, body: d }));
        }).on('error', reject);
      });
      assert.equal(got.status, 200);
      assert.match(got.body, /<title>t<\/title>/);
    } finally {
      await served?.close();
      await new Promise((resolve) => blocker.server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('two launches land on the same origin, so the next run sees the localStorage the last one wrote', async () => {
    const { createStaticServer } = await import('../desktop/serve.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'sp-serve-'));
    writeFileSync(path.join(root, 'index.html'), HTML);
    const blocker = await occupyPortAbove(50000);
    if (!blocker) return;
    try {
      const first = await createStaticServer({ root, port: blocker.port, log: { warn() {}, error() {} } });
      const firstUrl = first.url;
      await first.close();
      const second = await createStaticServer({ root, port: blocker.port, log: { warn() {}, error() {} } });
      try {
        assert.equal(second.url, firstUrl, 'the origin must be identical on the next launch (Chromium keys storage by origin)');
      } finally {
        await second.close();
      }
    } finally {
      await new Promise((resolve) => blocker.server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the shell relays a remote /healthz same-origin (the page cannot read it across origins)', async () => {
    const { createStaticServer, HEALTHZ_PROXY_PATH } = await import('../desktop/serve.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'sp-serve-'));
    writeFileSync(path.join(root, 'index.html'), HTML);
    // Stand-in for the game server: /healthz only, and no CORS header — exactly what the real one sends.
    const upstream = http.createServer((req, res) => {
      if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"version":1,"app":"0.1.3"}'); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    let served;
    try {
      served = await createStaticServer({ root, port: 0, proxy: true, log: { warn() {}, error() {} } });
      const target = `http://127.0.0.1:${upstream.address().port}/healthz`;
      const got = await new Promise((resolve, reject) => {
        http.get(`${served.url}${HEALTHZ_PROXY_PATH}?url=${encodeURIComponent(target)}`, (r) => {
          let d = '';
          r.on('data', (c) => { d += c; });
          r.on('end', () => resolve({ status: r.statusCode, body: d }));
        }).on('error', reject);
      });
      assert.equal(got.status, 200);
      assert.deepEqual(JSON.parse(got.body), { ok: true, version: 1, app: '0.1.3' });
    } finally {
      await served?.close();
      await new Promise((resolve) => upstream.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the relay only accepts this game\'s /healthz — it is never an open proxy', async () => {
    const { healthzProxyTarget, HEALTHZ_PROXY_PATH } = await import('../desktop/serve.mjs');
    const enc = encodeURIComponent;
    assert.equal(healthzProxyTarget(`${HEALTHZ_PROXY_PATH}?url=${enc('http://127.0.0.1:3000/healthz')}`), 'http://127.0.0.1:3000/healthz');
    assert.equal(healthzProxyTarget(`${HEALTHZ_PROXY_PATH}?url=${enc('http://127.0.0.1:3000/internal/secret')}`), null, 'other paths are refused');
    assert.equal(healthzProxyTarget(`${HEALTHZ_PROXY_PATH}?url=${enc('file:///etc/passwd')}`), null, 'non-http schemes are refused');
    assert.equal(healthzProxyTarget(`${HEALTHZ_PROXY_PATH}?url=${enc('http://127.0.0.1:3000/healthz')}&extra=1`), 'http://127.0.0.1:3000/healthz');
    assert.equal(healthzProxyTarget(HEALTHZ_PROXY_PATH), null, 'no url param');
    assert.equal(healthzProxyTarget('/js/main.js'), null, 'an ordinary file path is not intercepted');
  });
});
