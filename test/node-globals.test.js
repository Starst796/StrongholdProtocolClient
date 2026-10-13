// The Node-globals shim and the packaging guard that keeps it honest.
//
// The bug these exist for: 0.2.3 added `process.env.SP_BOT_EMOTES` to server/match/botEmotes.js. The payload runs
// the game's server modules in a page, so that line threw at import time, aborted /offline/bootstrap.js' static
// import chain, and every offline boot ended up dialling a real server instead ("连接中断，正在重连").
// `assertServerNeedsOnlyShims` could not see it — it inspects `import` specifiers, and `process` is a global.
//
// Two halves are tested here: the scanner must not fire on guards, comments, strings or object keys (a false
// positive fails a release build), and it must fire on a real reference to something the shim does not provide.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SHIMMED_GLOBALS, UNSHIMMED_GLOBALS, assertNoNodeGlobals, findNodeGlobalHits, findNodeGlobals, stripNonCode,
} from '../tools/node-globals.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIM = fs.readFileSync(path.join(ROOT, 'offline', 'node-globals.js'), 'utf8');

describe('what the shim provides', () => {
  test('process and the timer globals — the two the game actually uses', () => {
    assert.deepEqual([...SHIMMED_GLOBALS].sort(), ['clearImmediate', 'process', 'setImmediate']);
    assert.match(SHIM, /typeof g\.process === 'undefined'/);
    assert.match(SHIM, /typeof g\.setImmediate !== 'function'/);
    assert.match(SHIM, /g\.clearImmediate\s*=/);
  });

  test('it never clobbers a real implementation, and keeps versions empty', () => {
    // `versions` must stay empty: server/sim/simdata.js decides IS_NODE from process.versions.node, and the sim has
    // to keep seeing a browser or it takes Node-only paths.
    assert.match(SHIM, /versions:\s*\{\}/, 'empty versions');
    assert.match(SHIM, /^\s*env,\s*$/m, 'env object is exposed (SP_BOT_EMOTES reads process.env)');
    assert.match(SHIM, /const env = \{\};[\s\S]{0,200}?Object\.assign\(env, JSON\.parse/, 'localStorage "sp.env" overrides it');
    assert.ok(!/versions:\s*\{[^}]*node/.test(SHIM), 'versions must not claim to be Node');
  });

  test('it is a classic script: no import/export, and it ships in the payload', () => {
    // A module would be deferred, and bootstrap.js' static imports would already have thrown by then.
    assert.ok(!/^\s*(import|export)\b/m.test(SHIM), 'no static imports: it must run during parsing');
    const client = fs.readFileSync(path.join(ROOT, 'tools', 'package-client.mjs'), 'utf8');
    assert.match(client, /\['node-globals\.js', 'offline\/node-globals\.js'\]/, 'listed in OFFLINE_FILES');
    const patch = fs.readFileSync(path.join(ROOT, 'patches', 'game-client.patch'), 'utf8');
    assert.match(patch, /\+ *<script src="\/offline\/node-globals\.js"><\/script>/, 'index.html loads it');
    // ...and before the module scripts, or bootstrap.js' imports win the race
    const html = patch.split('\n').filter((l) => l.startsWith('+') && l.includes('<script'));
    const shimAt = html.findIndex((l) => l.includes('node-globals.js'));
    const firstModule = html.findIndex((l) => l.includes('type="module"'));
    assert.ok(shimAt !== -1 && firstModule !== -1 && shimAt < firstModule, 'shim before the first module script');
  });
});

describe('the scanner', () => {
  test('finds a bare reference to each kind of global', () => {
    const hits = findNodeGlobals([
      'const on = process.env.X !== "0";',
      'setTimeout(() => setImmediate(fn), 0);',
      'const b = Buffer.from(x);',
      'const dir = __dirname;',
      'module.exports = x;',
    ].join('\n'));
    assert.deepEqual(hits.map((h) => h.name).sort(), ['Buffer', '__dirname', 'module', 'process', 'setImmediate']);
    assert.equal(hits[0].line, 1, 'and reports the line');
  });

  test('ignores the guards the game already uses', () => {
    // Match.js:209 and simdata.js:497 are written this way on purpose: the same file must run in Node and in a page.
    assert.deepEqual(findNodeGlobals('const env = (k) => (typeof process !== "undefined" && process.env ? process.env[k] : undefined);'), []);
    assert.deepEqual(findNodeGlobals('const IS_NODE = typeof process !== "undefined" && !!(process && process.versions && process.versions.node);'), []);
    assert.deepEqual(findNodeGlobals('if (globalThis.process) use(globalThis.process);'), []);
  });

  test('ignores comments, strings, template literals and object keys', () => {
    // All four produced false positives while this was being written: a JSDoc "the process singleton", `'global:'`
    // as an effect-registry prefix, `global: addOverrides(…)` as an object key, and `X.buffer` on a TypedArray.
    const src = [
      '/** The process of loading data (registry: "global:" keys). */',
      'const KEY = /^(garrison|global):[A-Za-z0-9]+$/;',
      'const o = { global: addOverrides(new Map()) };',
      'const s = `Buffer ${x} setImmediate`;',
      '// process.env.SP_BOT_EMOTES in a comment',
      'const I32 = new Int32Array(f64.buffer);',
    ].join('\n');
    assert.deepEqual(findNodeGlobals(src), []);
  });

  test('stripNonCode removes the noise and keeps the code', () => {
    const stripped = stripNonCode('const a = "Buffer"; // process\nconst b = process.env.C;');
    assert.ok(!stripped.includes('Buffer'), 'string gone');
    assert.ok(!stripped.includes('// process'), 'comment gone');
    assert.ok(stripped.includes('process.env.C'), 'code kept');
  });

  test('require/module/exports only count in their CommonJS shapes', () => {
    assert.deepEqual(findNodeGlobals('import { x } from "./require-helper.js"; const m = modules.get(1);'), []);
    assert.equal(findNodeGlobals('const fs = require("fs");').length, 1);
    assert.equal(findNodeGlobals('module.exports = {};').length, 1);
    assert.equal(findNodeGlobals('export const probe = exports.ofThing;').length, 1);
  });
});

describe('the packaging gate', () => {
  /** A payload-shaped tree with one module under server/. */
  function payload(code) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-globals-'));
    fs.mkdirSync(path.join(dir, 'server', 'match'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server', 'match', 'x.js'), code);
    return dir;
  }

  test('passes when the module only uses what the shim provides', () => {
    const dir = payload('export const a = process.env.X !== "0";\nsetImmediate(() => go());\n');
    try {
      const { checked, shimmed } = assertNoNodeGlobals(dir);
      assert.equal(checked, 1);
      assert.equal(shimmed, 2, 'both are reported as covered, not as failures');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails on a global the shim does not provide, naming file, line and global', () => {
    const dir = payload('const b = Buffer.from("x");\n');
    try {
      assert.throws(() => assertNoNodeGlobals(dir), (e) => {
        assert.match(e.message, /server\/match\/x\.js:1/);
        assert.match(e.message, /\[Buffer\]/);
        assert.match(e.message, /涉及：Buffer/);
        return true;
      });
      // the scanner itself still reports it, so a caller can decide
      assert.equal(findNodeGlobalHits(dir).hits.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an allow entry silences a justified exception, and only that one', () => {
    const dir = payload('const b = Buffer.from("x");\nconst d = __dirname;\n');
    try {
      assert.throws(() => assertNoNodeGlobals(dir, { allow: ['__dirname'] }), /\[Buffer\]/);
      assert.doesNotThrow(() => assertNoNodeGlobals(dir, { allow: ['Buffer', 'server/match/x.js:__dirname'] }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('it is wired into the payload assembly, not only callable by hand', () => {
    const client = fs.readFileSync(path.join(ROOT, 'tools', 'package-client.mjs'), 'utf8');
    assert.match(client, /assertNoNodeGlobals\(out/, 'assembleClient runs it over the payload it just wrote');
    assert.match(client, /assertServerNeedsOnlyShims\(out\);[\s\S]{0,400}?assertNoNodeGlobals\(out/, 'next to the import guard');
  });
});
