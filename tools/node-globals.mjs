// The browser-missing Node globals guard for the payload's in-page server.
//
// The payload runs the game's *server* modules in a page (single-player, and the phone-side LAN host) — a browser has
// no `process`, no `setImmediate`, no `Buffer`. 0.2.3 added `process.env.SP_BOT_EMOTES` to server/match/botEmotes.js
// and it broke every offline boot: the ReferenceError aborted /offline/bootstrap.js' static import chain, so the
// in-page server never started and the client dialled a real server instead. `assertServerNeedsOnlyShims` did not
// catch it: that check looks at `import` specifiers, and `process` is a *global*, not an import.
//
// This is the missing half. It runs at packaging time over the modules the page will import:
//
//   * references guarded by `typeof x !== 'undefined'` are fine — that is how Match.js / simdata.js already do it;
//   * references to a global that /offline/node-globals.js provides are fine (SHIMMED);
//   * anything else fails the build, naming the file, the line and the global.
//
// It is deliberately strict: a false positive is a five-second fix in a shim, a false negative is a broken release.
//
// Comments are stripped first (a JSDoc "the process of …" and `Int32Array.buffer` are not globals), and string
// literals are ignored, because `'global:'` appears as a *key* in the game's effect registry.

import fs from 'node:fs';
import path from 'node:path';

/** Globals /offline/node-globals.js defines when the page is not Node. */
export const SHIMMED_GLOBALS = Object.freeze(['process', 'setImmediate', 'clearImmediate']);

/**
 * Node globals that do not exist in a browser and are NOT shimmed: a module using one of these will throw when the
 * page imports it. Kept separate from the shimmed list so the error message can say which one is missing.
 */
export const UNSHIMMED_GLOBALS = Object.freeze(['Buffer', 'require', '__dirname', '__filename', 'module', 'exports']);

/** Directories of the payload whose modules the page imports (the in-page server lives under server/ and sim/). */
const SCANNED_DIRS = Object.freeze(['server', 'sim']);

/** Strip comments and string literals: neither can hold a global reference, and both produce false positives. */
export function stripNonCode(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // block comments / JSDoc
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')    // line comments (not http://)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")      // single-quoted strings
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')      // double-quoted strings
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');       // template literals
}

/** Is `name` referenced on this line in a way that would throw in a browser? */
function isUnguarded(line, name) {
  // `typeof process !== 'undefined'`, `globalThis.process`, `process?.env` guards are all fine.
  if (new RegExp(`typeof\\s+${name}\\b`).test(line)) return false;
  if (new RegExp(`\\bglobalThis\\.${name}\\b`).test(line)) return false;
  if (new RegExp(`\\bself\\.${name}\\b`).test(line)) return false;
  // a declaration of a *different* identifier that merely contains the name (const processEnv = …) is not a reference
  if (new RegExp(`\\b(const|let|var|function|class)\\s+${name}\\b`).test(line)) return false;
  if (new RegExp(`\\bimport\\b.*\\bas\\s+${name}\\b`).test(line)) return false;
  // an object *key* of that name is not a reference (`global: addOverrides(…)`, `{ module: … }`)
  if (new RegExp(`(^|[{,(])\\s*${name}\\s*:`).test(line)) return false;
  if (!new RegExp(`(?<![\\w.$])${name}(?![\\w$])`).test(line)) return false;
  // `module` / `exports` / `require` only matter in their CommonJS shapes — elsewhere they are ordinary names.
  if (name === 'require') return /\brequire\s*\(/.test(line);
  if (name === 'module') return /\bmodule\s*\.\s*exports\b/.test(line);
  if (name === 'exports') return /(^|[^\w.$])exports\s*\./.test(line);
  return true;
}

/**
 * Scan one module body for unguarded references to browser-missing globals.
 * @param {string} src
 * @param {string[]} globals
 * @returns {{ line: number, name: string, text: string }[]}
 */
export function findNodeGlobals(src, globals = [...SHIMMED_GLOBALS, ...UNSHIMMED_GLOBALS]) {
  const out = [];
  stripNonCode(src).split('\n').forEach((line, i) => {
    for (const name of globals) {
      if (!isUnguarded(line, name)) continue;
      out.push({ line: i + 1, name, text: line.trim().slice(0, 120) });
    }
  });
  return out;
}

/**
 * Scan the payload's page-imported modules.
 *
 * `hits` are the offenders — references to globals the browser lacks and the shim does **not** provide; those fail
 * the build. `shimmed` are references that /offline/node-globals.js already covers: harmless, but reported so the
 * shim's real coverage is visible in the build log (and so a *new* global shows up as a diff in that list).
 *
 * @param {string} payloadRoot the assembled payload (build/client/www)
 * @param {{ allow?: string[], scannedDirs?: string[], globals?: string[] }} [opts]
 *   `allow` is `file:global` (or bare `global`) entries for a *justified* exception; prefer a shim instead.
 * @returns {{ checked: number, hits: object[], shimmed: object[] }}
 */
export function findNodeGlobalHits(payloadRoot, { allow = [], scannedDirs = SCANNED_DIRS, globals = null, sources = null } = {}) {
  const allowed = new Set(allow);
  const wanted = globals ?? [...SHIMMED_GLOBALS, ...UNSHIMMED_GLOBALS];
  const shimmed = new Set(SHIMMED_GLOBALS);
  const hits = [];
  const covered = [];
  let checked = 0;
  /**
   * Scan exactly these files instead of walking the tree. The caller passes the page's own reachable set (see
   * tools/page-graph.mjs): the payload now also carries files only the *shell* loads (the plugin registry, the HTTP
   * layer), and those are Node code — checking them here would flag every legitimate `process`/`Buffer` use.
   */
  if (sources) {
    for (const [rel, text] of sources) {
      if (!rel.endsWith('.js')) continue;
      checked++;
      scanSource(text, rel, { wanted, allowed, shimmed, hits, covered });
    }
    return { checked, hits, shimmed: covered };
  }
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(p, r); continue; }
      if (!e.isFile() || !e.name.endsWith('.js')) continue;
      checked++;
      scanSource(fs.readFileSync(p, 'utf8'), r, { wanted, allowed, shimmed, hits, covered });
    }
  };
  for (const d of scannedDirs) walk(path.join(payloadRoot, d), d);
  return { checked, hits, shimmed: covered };
}

/** One module's globals: a shimmed one is "covered" (reported as info), an unshimmed one is a finding. */
function scanSource(text, rel, { wanted, allowed, shimmed, hits, covered }) {
  for (const hit of findNodeGlobals(text, wanted)) {
    if (allowed.has(hit.name) || allowed.has(`${rel}:${hit.name}`)) continue;
    (shimmed.has(hit.name) ? covered : hits).push({ file: rel, ...hit });
  }
}

/**
 * The packaging gate: throw with a message that says what to do.
 *
 * Only globals the shim does *not* provide are fatal — `process` / `setImmediate` are exactly what
 * offline/node-globals.js exists for. An unshimmed one means the module needs a real browser replacement first.
 *
 * @param {string} payloadRoot
 * @param {{ allow?: string[], log?: (...a: any[]) => void }} [opts]
 */
export function assertNoNodeGlobals(payloadRoot, opts = {}) {
  const { checked, hits, shimmed } = findNodeGlobalHits(payloadRoot, opts);
  if (opts.log && shimmed.length) {
    opts.log(`package-client: 页内引擎用到 ${shimmed.length} 处 Node 全局（已由 offline/node-globals.js 提供）：${[...new Set(shimmed.map((h) => h.name))].join('、')}`);
  }
  if (!hits.length) return { checked, shimmed: shimmed.length };
  const lines = hits.map((h) => `  ${h.file}:${h.line}  [${h.name}]  ${h.text}`);
  const names = [...new Set(hits.map((h) => h.name))];
  throw new Error(
    `payload 里有 ${hits.length} 处引用了浏览器没有、shim 也没提供的 Node 全局（已检查 ${checked} 个模块）：\n${lines.join('\n')}\n`
    + `  涉及：${names.join('、')}\n`
    + '  这类引用会在页面 import 该模块时抛 ReferenceError（页内服务器起不来、客户端转去连真实服务器）。\n'
    + '  修法：offline/node-globals.js 里补最小实现（或把调用点改成浏览器安全的写法），别用 allow 绕过。',
  );
}
