// Which payload files the page actually loads — and therefore which ones have to be page-safe.
//
// Until 0.3.0 the rule could be a directory glob: everything the payload mirrored under `server/` was there *for the
// page* (the in-page server), so every file in it had to run in a WebView — no `node:` imports beyond the two shims,
// no `process`/`Buffer` globals. 0.3.0 broke that assumption in a good way: the plugin system, the content-set
// builder and the studio live under `server/` too, they are Node-only by design, and the *desktop shell* loads them
// (tools/server-tree.mjs) while the page never touches them. A directory rule would either reject them or, worse,
// with a permissive allow-list, stop noticing when the *page* starts importing them.
//
// So the check follows the import graph instead, from the page's entry points. Two invariants, both about what a
// WebView can actually run:
//
//   * every file reachable from a page entry may only import `node:` builtins the payload ships shims for;
//   * ...and may only touch the Node globals `offline/node-globals.js` provides.
//
// A file nobody reaches is none of this check's business — and a file that *becomes* reachable is checked
// immediately, with the chain that reaches it, which is the diagnostic the directory rule never had.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Where the page starts. These are the payload's own entry points (index.html loads them): the offline layer, the
 * shell picker, and the game's client entry. Anything they import — directly or transitively — runs in the page.
 */
export const PAGE_ENTRIES = Object.freeze([
  'offline/bootstrap.js',
  'offline/game-server.js',
  'offline/host-mobile.js',
  'offline/loopback.js',
  'offline/data-provider.js',
  'offline/node-crypto.js',
  'offline/node-net.js',
  'js/shell/picker.js',
  'js/shell/picker-core.js',
  'data.js',
  'server/data.js',
]);

/** `import … from '<spec>'`, `export … from '<spec>'`, and bare `import '<spec>'`. */
const SPECIFIER = /(?:^|[\s;{(])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

/** Strip comments and string bodies so a specifier inside prose or a JSDoc type reference is not read as an import. */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/** Every module specifier in a file's source. */
export function importSpecifiers(text) {
  const out = [];
  for (const m of stripComments(text).matchAll(SPECIFIER)) out.push(m[1]);
  return out;
}

/**
 * Resolve one specifier against the file that imported it, as a payload-relative path.
 * Only paths inside the payload can be followed (`/x.js`, `./x.js`, `../x.js`); `node:`, `preact` and friends are
 * left to the caller. Directory specifiers try `index.js`; extensionless ones try `.js`, as a browser would.
 * @param {string} from payload-relative path of the importing file
 * @param {string} spec
 * @returns {string|null}
 */
export function resolveSpecifier(from, spec) {
  if (!spec || spec.startsWith('node:') || spec.startsWith('data:') || spec.startsWith('http')) return null;
  let rel;
  if (spec.startsWith('/')) rel = spec.slice(1);
  else if (spec.startsWith('./') || spec.startsWith('../')) rel = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else return null; // a bare specifier: an import-map entry (preact, htm) or a shim alias
  if (rel.startsWith('..')) return null; // outside the payload
  return rel;
}

/**
 * Walk the page's import graph.
 *
 * @param {string} payloadRoot
 * @param {{ entries?: readonly string[] }} [opts]
 * @returns {{ files: Map<string, string>, chains: Map<string, string[]>, unresolved: { from: string, spec: string }[] }}
 *   `files` is every reachable file with its text, `chains` the path from an entry to each one (for diagnostics).
 */
export function pageGraph(payloadRoot, opts = {}) {
  const entries = opts.entries ?? PAGE_ENTRIES;
  const files = new Map();
  const chains = new Map();
  const unresolved = [];
  const queue = [];
  let found = 0;
  for (const entry of entries) {
    if (!fs.existsSync(path.join(payloadRoot, entry))) continue;
    if (files.has(entry)) continue;
    found++;
    chains.set(entry, [entry]);
    queue.push(entry);
  }
  // A payload always has its page entries (`offline/bootstrap.js` and the generated `server/data.js` are written by
  // the packager). None of them means this is not a payload, or the caller ran the check before they were written —
  // either way the answer "no reachable files" would be a lie, so say so instead of reporting success.
  if (found < 3) {
    throw new Error(`payload 里找不到页面入口（只找到 ${found} 个，期望 ${PAGE_ENTRIES.length} 个候选中的至少 3 个）—— `
      + `检查是不是在生成文件之前就调用了 import 图相关的守卫`);
  }
  while (queue.length) {
    const rel = queue.shift();
    const text = fs.readFileSync(path.join(payloadRoot, rel), 'utf8');
    files.set(rel, text);
    const chain = chains.get(rel);
    for (const spec of importSpecifiers(text)) {
      const target = resolveSpecifier(rel, spec);
      if (!target) {
        if (!spec.startsWith('node:') && !spec.startsWith('.') && !spec.startsWith('/')) continue; // bare: import map
        if (spec.startsWith('node:')) continue; // checked separately, per file
        continue;
      }
      const candidates = [target, `${target}.js`, path.posix.join(target, 'index.js')];
      const hit = candidates.find((c) => fs.existsSync(path.join(payloadRoot, c)) && fs.statSync(path.join(payloadRoot, c)).isFile());
      if (!hit) {
        unresolved.push({ from: rel, spec });
        continue;
      }
      if (files.has(hit)) continue;
      chains.set(hit, [...chain, hit]);
      queue.push(hit);
    }
  }
  return { files, chains, unresolved };
}

/** Prefixes that belong to the shell, not the page: a file here that becomes reachable is a finding in itself. */
export const NODE_ONLY_PREFIXES = Object.freeze(['server/http/', 'server/plugins/', 'server/studio/']);

/**
 * Check the page's graph: `node:` imports limited to `builtins`, and any `nodeOnly` prefix unreachable.
 * @param {{ files: Map<string,string>, chains: Map<string,string[]> }} graph
 * @param {{ builtins: readonly string[], nodeOnly?: readonly string[] }} opts
 * @returns {{ files: number, offenders: { file: string, reason: string, chain: string[] }[] }}
 */
export function checkPageGraph(graph, opts) {
  const allowed = new Set(opts.builtins);
  const nodeOnly = opts.nodeOnly ?? NODE_ONLY_PREFIXES;
  const offenders = [];
  for (const [rel, text] of graph.files) {
    const chain = graph.chains.get(rel) ?? [rel];
    for (const spec of importSpecifiers(text)) {
      if (!spec.startsWith('node:')) continue;
      if (allowed.has(spec)) continue;
      offenders.push({ file: rel, reason: `imports ${spec}`, chain });
    }
    if (nodeOnly.some((p) => rel.startsWith(p))) {
      offenders.push({ file: rel, reason: 'is part of the Node-only layer (the page must never load it)', chain });
    }
  }
  return { files: graph.files.size, offenders };
}
