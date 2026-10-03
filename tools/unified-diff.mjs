// Minimal unified-diff applier, used to patch the *assembled payload* with patches/game-client.patch.
//
// `git apply` cannot be used for this: the payload lives inside the client repo, so git would resolve patched paths
// against the repository root instead of the payload root (and `--out` may point anywhere). The patch is produced by
// `git diff` from the game checkout, so only that subset has to be understood — plain hunks, no renames, no mode
// changes, no "\ No newline at end of file" markers (test/packaging.test.js pins those assumptions).
//
// A hunk that matches nowhere throws: when upstream edits a patched file the build fails loudly instead of shipping
// a client that connects to the wrong server.

import fs from 'node:fs';
import path from 'node:path';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** How far a hunk may drift from its declared position before the patch is considered stale. */
const FUZZ = 200;

/**
 * Parse a `git diff` into `[{ oldPath, newPath, hunks: [{ oldStart, oldCount, newStart, newCount, body }] }]`,
 * where `body` is `[{ op: ' ' | '-' | '+', text }]`.
 * @param {string} text
 */
export function parsePatch(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      file = { oldPath: null, newPath: null, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!hunk) {
      // `---` starts a file too: `git apply` accepts a plain unified diff without the `diff --git` header.
      if (line.startsWith('--- ')) {
        if (!file || file.newPath) { file = { oldPath: null, newPath: null, hunks: [] }; files.push(file); }
        file.oldPath = line.slice(4).trim();
        continue;
      }
      if (line.startsWith('+++ ') && file) { file.newPath = line.slice(4).trim(); continue; }
    }
    const m = HUNK_RE.exec(line);
    if (m) {
      hunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        body: [],
      };
      oldLeft = hunk.oldCount;
      newLeft = hunk.newCount;
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (oldLeft <= 0 && newLeft <= 0) { hunk = null; continue; }
    const op = line[0];
    // An empty line inside a hunk is an empty context line (" " is often stripped by mailers / editors).
    const body = op === '+' || op === '-' || op === ' ' ? { op, text: line.slice(1) } : { op: ' ', text: line };
    if (body.op !== '+') oldLeft--;
    if (body.op !== '-') newLeft--;
    hunk.body.push(body);
  }
  return files;
}

/** Strip `n` leading path components (`a/public/js/net.js` with n=2 → `js/net.js`). */
export function stripPath(p, n) {
  const parts = String(p).split('/');
  return parts.slice(Math.min(n, parts.length - 1)).join('/');
}

/** Split into lines, remembering the EOL style and whether the file ended with a newline. */
function splitContent(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailing = text.endsWith(eol);
  const body = trailing ? text.slice(0, -eol.length) : text;
  return { lines: body === '' ? [] : body.split(eol), eol, trailing };
}

/** Apply one hunk at (or near) its declared position; returns the new line offset. */
function applyHunk(lines, hunk, offset) {
  const want = hunk.body.filter((b) => b.op !== '+').map((b) => b.text);
  const give = hunk.body.filter((b) => b.op !== '-').map((b) => b.text);
  const same = (at) => at >= 0 && at + want.length <= lines.length && want.every((t, i) => lines[at + i] === t);
  const declared = hunk.oldStart - 1 + offset;
  let at = -1;
  if (same(declared)) at = declared;
  else {
    for (let d = 1; d <= FUZZ && at === -1; d++) {
      if (same(declared - d)) at = declared - d;
      else if (same(declared + d)) at = declared + d;
    }
  }
  if (at === -1) {
    const snippet = want.slice(0, 3).map((l) => `    ${l}`).join('\n');
    throw new Error(`hunk @@ -${hunk.oldStart},${hunk.oldCount} @@ does not match (expected around line ${declared + 1}):\n${snippet}`);
  }
  lines.splice(at, want.length, ...give);
  return offset + give.length - want.length;
}

/**
 * Apply one parsed file entry to a text; returns the new text (and whether anything changed).
 * @param {string} text
 * @param {{ hunks: { oldStart: number, oldCount: number, newStart: number, newCount: number, body: { op: string, text: string }[] }[] }} file
 * @returns {{ text: string, changed: boolean }}
 */
export function applyFilePatch(text, file) {
  const { lines, eol, trailing } = splitContent(text);
  let offset = 0;
  for (const hunk of file.hunks) offset = applyHunk(lines, hunk, offset);
  const out = lines.join(eol) + (trailing ? eol : '');
  return { text: out, changed: out !== text };
}

/** The parsed entry for a stripped path (`js/net.js`), or null. */
export function filePatch(patchText, rel, strip = 2) {
  const file = parsePatch(patchText).find((f) => f.newPath && stripPath(f.newPath, strip) === rel);
  return file && file.hunks.length ? file : null;
}

/**
 * Apply a parsed patch to a directory (kept for tests and for patching whole trees).
 * @param {string} root directory the patched paths are relative to
 * @param {string} patchText
 * @param {{ strip?: number, only?: string[] }} [opts] `only` limits the patch to those (stripped) paths
 * @returns {{ file: string, hunks: number, changed: boolean }[]}
 */
export function applyPatch(root, patchText, opts = {}) {
  const strip = opts.strip ?? 2;
  const rootAbs = path.resolve(root);
  const done = [];
  for (const file of parsePatch(patchText)) {
    if (!file.newPath || !file.hunks.length) continue;
    const rel = stripPath(file.newPath, strip);
    if (opts.only && !opts.only.includes(rel)) continue;
    const abs = path.resolve(rootAbs, rel);
    if (!abs.startsWith(rootAbs + path.sep)) throw new Error(`patch path escapes the payload: ${rel}`);
    const original = fs.readFileSync(abs, 'utf8');
    const { text, changed } = applyFilePatch(original, file);
    if (changed) fs.writeFileSync(abs, text);
    done.push({ file: rel, hunks: file.hunks.length, changed });
  }
  return done;
}
