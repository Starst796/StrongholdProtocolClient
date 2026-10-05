// Regenerates patches/game-client.patch from the game checkout.
//
// The client hooks live as a patch *against the payload copy*, so they never touch the game repo (see
// tools/payload-patches.mjs). A `git diff` is positional: when upstream edits a patched file (0.1.3 renamed the
// store import in js/screens/room.js), the recorded context no longer matches and the build fails. This tool
// applies the hooks as *anchored string replacements* to the checkout's current files, then diffs the result, so
// regenerating after an upstream bump is one command:
//
//   node tools/regen-patch.mjs            # rewrite patches/game-client.patch
//   node tools/regen-patch.mjs --check     # fail if the current patch would not apply (CI)
//
// Besides the client hooks it also carries small upstream fixes the packaged client depends on (e.g. lobby.js'
// missing ERR import) — the game repo is a fork we must not commit to, so those ride the payload patch too.
//
// Anchors are exact upstream lines; if upstream rewrites one, the replacement throws here (with the anchor), which
// is the signal to update the hook below. The large defaultWsUrl replacement body lives in
// tools/patch-hooks/net-ws-url.txt (plain text, so it needs no escaping).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGameRoot } from './game-contract.mjs';
import { PATCH_FILE, PATCHED_FILES } from './payload-patches.mjs';

export const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const L = (...lines) => lines.join('\n');
const hook = (file) => fs.readFileSync(path.join(CLIENT_ROOT, 'tools', 'patch-hooks', file), 'utf8').replace(/\n+$/, '');

/** Replace exactly one occurrence of `search` in `text`, or throw with the anchor (an upstream edit moved it). */
function replaceOnce(text, search, replace, label) {
  const at = text.indexOf(search);
  if (at === -1) throw new Error(`${label}: anchor not found in the checkout — upstream changed it, update the hook in tools/regen-patch.mjs:\n    ${search.split('\n')[0]}`);
  if (text.indexOf(search, at + 1) !== -1) throw new Error(`${label}: anchor is not unique — make it more specific`);
  return text.slice(0, at) + replace + text.slice(at + search.length);
}

/**
 * The intended content of each patched file (upstream + the client hooks).
 * @param {Record<string, string>} src pristine file text by payload-relative path
 * @returns {Record<string, string>} modified text
 */
export function applyHooks(src) {
  const out = { ...src };

  // index.html — shell stylesheet, the offline import-map entries, and the pre-game scripts.
  let html = out['index.html'];
  html = replaceOnce(html,
    '  <link rel="stylesheet" href="/css/devices.css" />',
    L('  <link rel="stylesheet" href="/css/devices.css" />',
      '  <!-- Packaged clients: HUD scale on short landscape screens (see shell/display.css). -->',
      '  <link rel="stylesheet" href="/css/shell-display.css" />'),
    'index.html shell-display');
  html = replaceOnce(html,
    '    { "imports": { "preact": "/vendor/preact.module.js", "preact/hooks": "/vendor/hooks.module.js", "htm": "/vendor/htm.module.js" } }',
    '    { "imports": { "preact": "/vendor/preact.module.js", "preact/hooks": "/vendor/hooks.module.js", "htm": "/vendor/htm.module.js", "node:crypto": "/offline/node-crypto.js", "node:net": "/offline/node-net.js" } }',
    'index.html importmap');
  html = replaceOnce(html,
    `  <script type="module" src="/js/main.js" onerror="window.__spBootFail && window.__spBootFail('load')"></script>`,
    L('  <!-- Packaged-client server address (empty in the web build → the page\'s own origin). Must run before /js/main.js. -->',
      '  <script src="/js/runtime-config.js"></script>',
      '  <!-- Phone-side LAN host (Android): a CLASSIC script, so window.__SP_HOST__ exists before any module script',
      '       (the picker) runs — a module here would be deferred and could execute after it. No-op elsewhere. -->',
      '  <script src="/offline/host-mobile.js"></script>',
      '  <script type="module" src="/js/shell/picker.js"></script>',
      '  <script type="module" src="/offline/bootstrap.js"></script>',
      `  <script type="module" src="/js/main.js" onerror="window.__spBootFail && window.__spBootFail('load')"></script>`),
    'index.html scripts');
  out['index.html'] = html;

  // js/net.js — the header note and the server-override-aware defaultWsUrl().
  let net = out['js/net.js'];
  net = replaceOnce(net,
    '// - One socket at ws(s)://<host>/ws, JSON text frames `{ t, ...payload }`.',
    L("// - One socket at ws(s)://<host>/ws, JSON text frames `{ t, ...payload }`. The host is the page's own origin",
      '//   unless the client is packaged (Electron / Android): `/js/runtime-config.js` then sets `globalThis.__SP_SERVER__`',
      '//   to the game server it was built for (default `localhost:3000`), and `?server=host` overrides it for one session.'),
    'net.js header');
  net = replaceOnce(net,
    L('/**',
      ' * WebSocket URL for the current page (`ws(s)://host/ws`).',
      ' * @param {{protocol: string, host: string}} [loc]',
      ' * @returns {string}',
      ' */',
      'export function defaultWsUrl(loc = globalThis.location) {',
      "  if (!loc || !loc.host) return 'ws://localhost:3000/ws';",
      "  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;",
      '}'),
    hook('net-ws-url.txt'),
    'net.js defaultWsUrl');
  out['js/net.js'] = net;

  // js/screens/room.js — invitation links point at the remote web client.
  let room = out['js/screens/room.js'];
  room = replaceOnce(room,
    "import { net } from '../net.js';",
    "import { net, resolveServerTarget, toHttpUrl } from '../net.js';",
    'room.js net import');
  room = replaceOnce(room,
    L('/** Invite link for a room code (current page URL with ?room=CODE). */',
      'export function inviteLink(code) {',
      '  const loc = globalThis.location;',
      "  const base = loc ? `${loc.origin}${loc.pathname}` : '';",
      '  return `${base}?room=${encodeURIComponent(code)}`;',
      '}'),
    L("/** Invite link for a room code: the web client's URL with `?room=CODE` (the remote site in a packaged client). */",
      'export function inviteLink(code) {',
      '  const loc = globalThis.location;',
      '  const target = resolveServerTarget(loc);',
      "  const base = target ? `${toHttpUrl(target)}/` : (loc ? `${loc.origin}${loc.pathname}` : '');",
      '  return `${base}?room=${encodeURIComponent(code)}`;',
      '}'),
    'room.js inviteLink');
  out['js/screens/room.js'] = room;

  // js/screens/lobby.js — the spectator error path uses ERR.ROOM_NOT_FOUND / ERR.ALREADY but upstream never imports
  // ERR, so a failed 观战 throws `ERR is not defined` instead of the friendlier toast. (The game repo is a fork we
  // must not edit, so the one-line fix rides the payload patch like the other client hooks.)
  let lobby = out['js/screens/lobby.js'];
  lobby = replaceOnce(lobby,
    "import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, ROOM_CODE_LEN, MAX_SEATS, MAX_SPECTATORS, modeIdFor } from '../../../shared/constants.js';",
    "import { ERR, DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, ROOM_CODE_LEN, MAX_SEATS, MAX_SPECTATORS, modeIdFor } from '../../../shared/constants.js';",
    'lobby.js ERR import');
  out['js/screens/lobby.js'] = lobby;

  return out;
}

/** `git diff` of pristine → hooked, in a throwaway repo so the paths read `a/public/…` / `b/public/…`. */
export function buildPatch(gameRoot) {
  /** File text with LF endings: the patch must be LF-only (repo policy / test), whatever a checkout's EOL is. */
  const lf = (s) => s.replace(/\r\n?/g, '\n');
  const src = {};
  for (const rel of PATCHED_FILES) src[rel] = lf(fs.readFileSync(path.join(gameRoot, 'public', rel), 'utf8'));
  const modified = applyHooks(src);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-regen-'));
  try {
    fs.writeFileSync(path.join(tmp, '.gitattributes'), '* text eol=lf\n');
    for (const rel of PATCHED_FILES) {
      const p = path.join(tmp, 'public', rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, src[rel], 'utf8');
    }
    const git = (...args) => spawnSync('git', ['-C', tmp, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.safecrlf=false', ...args], { encoding: 'utf8' });
    if (git('init', '-q').status !== 0) throw new Error('git init failed (git is required to regenerate the patch)');
    if (git('add', '-A').status !== 0) throw new Error('git add failed');
    for (const rel of PATCHED_FILES) fs.writeFileSync(path.join(tmp, 'public', rel), modified[rel], 'utf8');
    const diff = git('--no-pager', 'diff', '--no-color');
    if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
    if (!diff.stdout.trim()) throw new Error('the hooks produced no change — nothing to write');
    // even with core.autocrlf=false some Windows setups re-wrap the diff: the patch is LF-only by policy
    return diff.stdout.replace(/\r\n?/g, '\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const gi = argv.indexOf('--game');
  const gameRoot = path.resolve(gi !== -1 ? argv[gi + 1] : findGameRoot({ clientRoot: CLIENT_ROOT }));
  const patch = buildPatch(gameRoot);
  if (check) {
    const current = fs.existsSync(PATCH_FILE) ? fs.readFileSync(PATCH_FILE, 'utf8') : '';
    if (current === patch) console.log('regen-patch: patches/game-client.patch is up to date');
    else { console.error('regen-patch: patches/game-client.patch is stale — run `node tools/regen-patch.mjs`'); process.exit(1); }
  } else {
    fs.writeFileSync(PATCH_FILE, patch);
    console.log(`regen-patch: wrote ${path.relative(CLIENT_ROOT, PATCH_FILE)} (${patch.split('\n').length - 1} lines) from ${gameRoot}`);
  }
}
