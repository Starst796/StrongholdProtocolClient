// A fake update feed, so the update row can be exercised without publishing anything.
//
//   node tools/fake-feed.mjs [--port 8199] [--build 1] [--version 9.9.9] [--dir <dir>] [flavour]
//
// Flavours (one at a time) reproduce what the client must *refuse* as much as what it must offer:
//
//   (default)   a well-formed feed + a small artifact whose sha256/size are correct
//   --build 0   an older build than any client (must read as "nothing newer")
//   --empty     `{}` (must stay silent)
//   --bad-json  truncated JSON (must stay silent)
//   --html      a captive-portal style HTML page (must stay silent)
//   --no-sha    an artifact without a sha256 (must be refused: nothing to verify the download with)
//   --http-url  an artifact on a plain-http non-local host (must be refused)
//   --delta     also advertise a manifest and an incremental pack, for the 0.2.5+ update row
//
// It prints the artifact path and the exact command to point a payload at it:
//
//   node tools/package-client.mjs --feed http://127.0.0.1:8199/latest.json
//
// then start the shell and look at `#sp-upd` (docs/PACKAGING.md §14.5).

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { deltaFileName } from './payload-delta.mjs';
import { sha256File } from './release-meta.mjs';

const BUILD_MAX = 4096;
const ARTIFACT_BYTES = 64 * 1024;

/**
 * The feed this server answers with, plus the files it must serve beside it.
 * @param {{ build?: number, version?: string, commit?: string, flavour?: string, dir: string, origin: string }} o
 * @returns {{ feed: object|string, files: {name: string, bytes: Buffer}[], note: string }}
 */
export function fakeFeed(o) {
  const flavour = o.flavour ?? '';
  const build = Number.isInteger(o.build) ? o.build : 1;
  const version = o.version ?? '9.9.9';
  if (flavour === 'empty') return { feed: {}, files: [], note: '{} —— 客户端应当静默' };
  if (flavour === 'bad-json') return { feed: '{"schema": 1, "build": ', files: [], note: '截断的 JSON —— 应当静默' };
  if (flavour === 'html') return { feed: '<!doctype html><html><body>请连接 WiFi</body></html>', files: [], note: '门户式 HTML —— 应当静默' };

  const artifact = (name, fill, bytes0 = ARTIFACT_BYTES) => {
    const bytes = Buffer.alloc(bytes0, fill);
    const file = path.join(o.dir, name);
    fs.writeFileSync(file, bytes);
    return { name, file, size: bytes.length, sha256: sha256File(file) };
  };
  const win = artifact(`StrongholdProtocol-${version}-win-x64.zip`, 7);
  const android = artifact(`StrongholdProtocol-${version}-android-debug.apk`, 3);
  const json = { version, build, versionCode: build, tag: `v${version}-b${build}`, protocol: 1, notes: 'fake feed（本地测试用）', publishedAt: new Date().toISOString() };
  const asset = (a) => ({
    name: a.name, url: `${o.origin}/files/${a.name}`, size: a.size,
    ...(flavour === 'no-sha' ? {} : { sha256: a.sha256 }),
    ...(flavour === 'http-url' ? { url: `http://example.com/${a.name}` } : {}),
  });
  // The artifact bytes are only served when the feed points at this origin (--http-url points somewhere else).
  const served = (list) => (flavour === 'http-url' ? [] : list.map((a) => ({ name: a.name, bytes: fs.readFileSync(a.file) })));

  if (flavour === 'delta') {
    // A pack is smaller than the installer — the client refuses one that is not (nothing to gain).
    const payload = artifact(`payload-${build}.json`, 5, 4096);
    const delta = artifact(deltaFileName(build - 1, build), 9, 8192);
    return {
      feed: {
        schema: 1, ...json,
        win: asset(win), android: asset(android),
        payload: { ...asset(payload), files: 100, bytes: 1024, schema: 1, base: build - 1 },
        delta: { ...asset(delta), base: build - 1, files: 3, bytes: 2048 },
      },
      files: served([win, android, payload, delta]),
      note: '带清单与增量包的 feed —— 客户端应显示「增量下载 …（全量 …）」',
    };
  }
  return {
    feed: { schema: 1, ...json, win: asset(win), android: asset(android) },
    files: served([win, android]),
    note: '正常 feed —— 客户端应显示「有新版本」',
  };
}

async function serve(o) {
  const dir = path.resolve(o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sp-fake-feed-')));
  fs.mkdirSync(dir, { recursive: true });
  let origin = `http://127.0.0.1:${o.port}`;
  const built = fakeFeed({ ...o, dir, origin });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin);
    if (url.pathname === '/latest.json') {
      const body = typeof built.feed === 'string' ? built.feed : JSON.stringify(built.feed, null, 2);
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(body);
      return;
    }
    const name = url.pathname.startsWith('/files/') ? decodeURIComponent(url.pathname.slice(7)) : '';
    const file = built.files.find((f) => f.name === name);
    if (file) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' });
      res.end(file.bytes);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  await new Promise((r) => server.listen(o.port, '127.0.0.1', r));
  return { server, dir, built, origin: `http://127.0.0.1:${o.port}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const argv = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  const flavours = ['empty', 'bad-json', 'html', 'no-sha', 'http-url', 'delta'];
  const flavour = flavours.find((f) => argv.includes(`--${f}`)) ?? '';
  const o = {
    port: Number(opt('--port', 8199)),
    build: Number(opt('--build', 1)),
    version: opt('--version', '9.9.9'),
    dir: opt('--dir'),
    flavour,
  };
  if (!Number.isInteger(o.build) || o.build < 0 || o.build > BUILD_MAX) throw new Error(`--build 要是 0–${BUILD_MAX}`);
  const { built, dir, origin } = await serve(o);
  console.log(`fake-feed: ${origin}/latest.json（${built.note}）`);
  console.log(`fake-feed: 假产物在 ${dir}`);
  console.log('fake-feed: 用它打一份 payload:');
  console.log(`  node tools/package-client.mjs --feed ${origin}/latest.json`);
  console.log('fake-feed: Ctrl+C 结束。');
}
