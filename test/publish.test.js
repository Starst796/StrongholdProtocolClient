// Publishing to GitHub Releases (tools/publish-release.mjs): the parts that cost a 483 MB upload to learn.
//
// Two failures this file exists for, both hit while publishing the first real release:
//
//   1. `HTTP 100, empty body` on the big zip. curl had negotiated `Expect: 100-continue` (it does for any body over
//      1 KB) and read the interim `100 Continue` back as the final status when the upload died. The fix is `-T`
//      (stream the file off disk instead of `--data-binary @file`, which loads all of it into memory first) plus an
//      empty `Expect:` header; a stalled transfer is now aborted by --speed-limit so the retry can start over.
//   2. Re-publishing an existing release died at the first asset: GitHub's `DELETE /releases/assets/<id>` answers
//      `204 No Content`, and the response parser demanded JSON. An empty body is a *success*.
//
// The unit tests pin the argument vector and the response parser; the integration test at the bottom runs the whole
// publish() against a fake GitHub API, because a rename inside it left a dead reference that no unit test could see
// (the module still parsed — an undefined call only throws when that branch runs).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { curlArgs, envProxy, expectResponse, parseCurlRoute } from '../tools/publish-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, 'tools');

describe('the curl invocation for an asset upload', () => {
  const args = curlArgs('https://uploads.github.com/repos/o/n/releases/1/assets?name=a.zip', {
    token: 't', method: 'POST', file: 'C:/tmp/a b.zip', timeoutMs: 3600000,
  });
  const at = (flag) => args.indexOf(flag);

  test('streams the file instead of buffering it into the argument list', () => {
    assert.ok(at('-T') !== -1, 'a file body must be streamed with -T');
    assert.equal(args[at('-T') + 1], 'C:/tmp/a b.zip', 'the path is passed verbatim (args go straight to the process)');
    assert.ok(!args.includes('--data-binary'), '--data-binary @file loads the whole 483 MB into memory first');
    assert.equal(args.filter((a) => a === '-T').length, 1);
  });

  test('never negotiates Expect: 100-continue', () => {
    // `-H 'Expect:'` (empty value) is what suppresses it — without this the interim 100 became the reported status.
    const i = args.indexOf('Expect:');
    assert.ok(i !== -1, 'the empty Expect header must be present');
    assert.equal(args[i - 1], '-H', 'Expect: is passed as a header value');
  });

  test('survives a slow link, but gives up on a dead one', () => {
    assert.equal(args[at('--max-time') + 1], '3600', 'an hour for the big artifacts');
    assert.ok(at('--speed-limit') !== -1 && at('--speed-time') !== -1, 'a stalled transfer must abort, not hang');
    assert.ok(at('--connect-timeout') !== -1);
    assert.ok(args.includes('--http1.1'), 'HTTP/1.1 for the upload endpoints');
  });

  test('a JSON call keeps the body inline (no -T, no Expect juggling)', () => {
    const json = curlArgs('https://api.github.com/repos/o/n/releases', { token: 't', method: 'POST', json: '{"a":1}' });
    const i = json.indexOf('--data-binary');
    assert.ok(i !== -1 && json[i + 1] === '{"a":1}');
    assert.ok(!json.includes('-T'));
    assert.equal(json[json.indexOf('--max-time') + 1], '60', 'small API calls do not get an hour');
  });

  test('the token is a header, never part of the URL', () => {
    assert.ok(args.includes('Authorization: Bearer t'));
    assert.ok(!args.some((a) => a.includes('token=t')), 'a token in a URL ends up in logs and proxies');
    // and it is the last argument that is the URL
    assert.equal(args[args.length - 1], 'https://uploads.github.com/repos/o/n/releases/1/assets?name=a.zip');
  });

  test('an explicit proxy is handed to curl as -x, on uploads too', () => {
    const proxied = curlArgs('https://uploads.github.com/x', { method: 'POST', file: 'f.zip', proxy: 'http://127.0.0.1:7892' });
    const i = proxied.indexOf('-x');
    assert.ok(i !== -1, 'the proxy must be passed as -x');
    assert.equal(proxied[i + 1], 'http://127.0.0.1:7892');
    // ...and it must not disturb the streaming setup
    assert.ok(proxied.includes('-T') && proxied.includes('Expect:'));
    assert.ok(!curlArgs('https://example/x').includes('-x'), 'no -x when nothing was asked for');
  });
});

describe('knowing which route curl took', () => {
  test('names the environment variable curl used', () => {
    // Real `curl -v` output (8.13 on Windows) for a proxied HTTPS request.
    const stderr = [
      "* Uses proxy env variable https_proxy == 'http://127.0.0.1:7892'",
      '*   Trying 127.0.0.1:7892...',
      '* CONNECT tunnel: HTTP/1.1 negotiated',
      '* Establish HTTP proxy tunnel to api.github.com:443',
    ].join('\n');
    const route = parseCurlRoute(stderr);
    assert.equal(route.viaProxy, true);
    assert.equal(route.proxy, 'http://127.0.0.1:7892');
    assert.match(route.source, /https_proxy/);
    assert.equal(route.target, 'api.github.com:443');
  });

  test('recognises an explicit -x (curl does not print the env line for it)', () => {
    const stderr = [
      '*   Trying 127.0.0.1:7892...',
      '* Establish HTTP proxy tunnel to uploads.github.com:443',
    ].join('\n');
    const route = parseCurlRoute(stderr);
    assert.equal(route.viaProxy, true, 'a tunnel means a proxy, however it was configured');
    assert.match(route.source, /-x/);
    assert.equal(route.target, 'uploads.github.com:443');
  });

  test('reports a direct connection as direct', () => {
    const stderr = '*   Trying 140.82.121.6:443...\n* Connected to api.github.com (140.82.121.6) port 443';
    const route = parseCurlRoute(stderr);
    assert.equal(route.viaProxy, false);
    assert.equal(route.source, '直连');
    assert.equal(route.target, 'api.github.com:443');
    assert.equal(parseCurlRoute('').viaProxy, false);
    assert.equal(parseCurlRoute(undefined).source, '未知');
  });

  test('envProxy reports what curl would read, and nothing when nothing is set', () => {
    // Only GitHub (HTTPS) matters here, so https_proxy is the first place to look.
    assert.deepEqual(envProxy({ https_proxy: 'http://127.0.0.1:7892' }), { url: 'http://127.0.0.1:7892', name: 'https_proxy' });
    assert.deepEqual(envProxy({ HTTPS_PROXY: 'http://a:1' }), { url: 'http://a:1', name: 'HTTPS_PROXY' });
    // https_proxy wins over the uppercase spelling (curl's rule), and all_proxy is the last resort
    assert.equal(envProxy({ https_proxy: 'http://lower:1', HTTPS_PROXY: 'http://upper:1' }).url, 'http://lower:1');
    assert.equal(envProxy({ ALL_PROXY: 'socks5://127.0.0.1:7891' }).url, 'socks5://127.0.0.1:7891');
    // Uppercase HTTP_PROXY alone is deliberately ignored: it never applies to an HTTPS request
    assert.equal(envProxy({ HTTP_PROXY: 'http://127.0.0.1:7892' }), null);
    assert.equal(envProxy({}), null);
    assert.equal(envProxy({ https_proxy: '   ' }), null);
  });
});

describe('reading a GitHub response', () => {
  test('a 201 parses to its JSON', () => {
    assert.deepEqual(expectResponse(201, '{"id":7,"name":"a.zip"}', [201]), { id: 7, name: 'a.zip' });
  });

  test('a 204 with no body is a success, not a parse error', () => {
    // This is the DELETE that replaces an already-published asset: it has no body at all.
    assert.equal(expectResponse(204, '', [204, 200]), null);
    assert.equal(expectResponse(200, '   \n', [204, 200]), null, 'whitespace-only counts as empty');
  });

  test('an unexpected status is an error naming what GitHub said', () => {
    assert.throws(() => expectResponse(404, '{"message":"Not Found"}', [200]), /HTTP 404.*Not Found/);
    assert.throws(() => expectResponse(422, '{"message":"already_exists"}', [201]), /already_exists/);
    // ...and a non-JSON body (a proxy page) still surfaces something readable
    assert.throws(() => expectResponse(502, '<html>Bad gateway</html>', [200]), /HTTP 502.*Bad gateway/);
    assert.throws(() => expectResponse(0, '', [200]), /HTTP 0/);
  });
});

/**
 * The whole publish() against a fake GitHub API. This is the test that would have caught a rename leaving a dead
 * reference inside publish() (the 422 and upload branches only run on a real publish, and `node --check` cannot see
 * an undefined call).
 */
describe('publish() against a fake GitHub API', () => {
  /**
   * Run publish() in a *child* process. publish() is synchronous end to end (spawnSync + curl), so calling it
   * in-process would block this test's event loop — and the fake API here lives in that same loop, so curl would
   * wait forever for a server that can no longer answer. (Learned the hard way: the first version of this test hung.)
   */
  function runPublish(opts, signerStub = 'ok') {
    // The APK signer check is injected, and a function cannot cross into a child process as JSON — so the stub is
    // named here and materialised inside the child. Default 'ok' because these tests exercise the upload mechanics
    // with files that are not real APKs; 'fail' is used by the test that proves publish refuses to upload a
    // wrong-key APK. The real check is covered by test/signing.test.js.
    const stub = signerStub === 'ok' ? 'opts.signerCheck = () => ({ ok: true, sha256: "a".repeat(64) });'
      : signerStub === 'fail' ? 'opts.signerCheck = () => ({ ok: false, sha256: "b".repeat(64), reason: "signature does not match" });'
        : '';
    const code = [
      `import { publish } from ${JSON.stringify(pathToFileURL(path.join(TOOLS, 'publish-release.mjs')).href)};`,
      `const opts = ${JSON.stringify(opts)};`,
      stub,
      'try {',
      '  const r = publish(opts);',
      "  console.log('OK ' + JSON.stringify(r.uploads));",
      '} catch (e) {',
      "  console.log('ERR ' + (e && e.message || e));",
      '  process.exitCode = 1;',
      '}',
    ].join('\n');
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (status) => resolve({ status, out, err }));
    });
  }

  /** A fake API: create (201, or 422 when `exists`), look up by tag, list/delete/replace assets. */
  async function fakeApi({ exists = false, lieAboutSize = false, replaceNames = [], dropFirstUpload = false, dropEveryUpload = false } = {}) {
    const seen = { uploads: [], deletes: [], release: 0 };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const name = url.searchParams.get('name') || '';
      const reply = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(obj === undefined ? '' : JSON.stringify(obj));
      };
      // Bodies are drained per branch: a stream put into flowing mode before its `data` listener is attached would
      // lose the body (and `end` would never reach the handler), which is what hangs a test.
      const body = () => {
        let bytes = 0;
        req.on('data', (c) => { bytes += c.length; });
        return new Promise((r) => req.on('end', () => r(bytes)));
      };
      if (req.method === 'POST' && url.pathname.endsWith('/releases')) {
        seen.release++;
        return body().then(() => reply(exists ? 422 : 201, { id: 4242, tag_name: 'v9.9.9-b7', html_url: 'https://example/rel', message: 'already_exists' }));
      }
      if (req.method === 'POST' && url.pathname.endsWith('/assets')) {
        return body().then((bytes) => {
          seen.uploads.push({ name, bytes });
          // `dropFirstUpload` models the real failure: the connection dies mid-body on the first attempt.
          if ((dropEveryUpload || dropFirstUpload) && (dropEveryUpload || seen.uploads.length === 1)) {
            req.socket.destroy();
            return;
          }
          // `lieAboutSize` models a truncated/aborted transfer the server still answered 201 to.
          reply(201, { id: 100 + seen.uploads.length, name, size: lieAboutSize ? bytes - 1 : bytes });
        });
      }
      req.resume(); // everything below answers without reading the request
      if (req.method === 'GET' && url.pathname.includes('/releases/tags/')) {
        return reply(200, { id: 4242, tag_name: 'v9.9.9-b7', html_url: 'https://example/rel' });
      }
      if (req.method === 'GET' && url.pathname.endsWith('/assets')) {
        // The already-published release holds both names the feed uses, so the replace path runs for both.
        return reply(200, exists ? [{ id: 11, name: replaceNames[0] }, { id: 12, name: 'latest.json' }] : []);
      }
      if (req.method === 'DELETE' && url.pathname.includes('/releases/assets/')) {
        seen.deletes.push(Number(url.pathname.split('/').pop()));
        res.writeHead(204); // 204 with no body, like GitHub
        return res.end();
      }
      return reply(404, { message: `no route ${req.method} ${url.pathname}` });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
  }

  /** A throwaway dist/ with a feed and the two artifacts it names. */
  function makeDist() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-publish-test-'));
    const win = 'StrongholdProtocol-9.9.9-win-x64.zip';
    const android = 'StrongholdProtocol-9.9.9-android-debug.apk';
    fs.writeFileSync(path.join(dir, win), Buffer.alloc(4096, 1));
    fs.writeFileSync(path.join(dir, android), Buffer.alloc(2048, 2));
    const feed = {
      schema: 1, version: '9.9.9', build: 7, versionCode: 9090007, tag: 'v9.9.9-b7', protocol: 1,
      gameCommit: 'abc1234', notes: 'test', publishedAt: '2026-01-01T00:00:00.000Z',
      win: { name: win, url: `https://example/${win}`, sha256: 'a'.repeat(64), size: fs.statSync(path.join(dir, win)).size },
      android: { name: android, url: `https://example/${android}`, sha256: 'b'.repeat(64), size: fs.statSync(path.join(dir, android)).size },
    };
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(feed, null, 2) + '\n');
    return { dir, feed, win, android };
  }

  for (const exists of [false, true]) {
    test(exists ? 're-publishing reuses the release and replaces the assets' : 'a fresh publish creates the release', async () => {
      const dist = makeDist();
      const api = await fakeApi({ exists, replaceNames: [dist.win] });
      try {
        const run = await runPublish({
          dist: dist.dir, repo: 'o/n', token: 'fake', attempts: 1, quiet: true,
          api: `http://127.0.0.1:${api.port}`, uploads: `http://127.0.0.1:${api.port}`,
        });
        assert.equal(run.status, 0, `publish must succeed:\n${run.out}\n${run.err}`);
        assert.equal(api.seen.release, 1, 'the release is created once');
        // the artifacts go up first and the feed last, so clients never see a feed whose downloads 404
        assert.deepEqual(
          api.seen.uploads.map((u) => u.name),
          [dist.win, dist.android, 'latest.json'],
          `upload order (out: ${run.out.trim()})`,
        );
        assert.match(run.out, new RegExp(`OK \\["${dist.win.replace(/[.]/g, '\\.')}"`));
        // every file arrived whole
        assert.equal(api.seen.uploads[0].bytes, fs.statSync(path.join(dist.dir, dist.win)).size, 'the zip is uploaded byte for byte');
        assert.equal(api.seen.uploads[2].bytes, fs.statSync(path.join(dist.dir, 'latest.json')).size);
        if (exists) {
          assert.deepEqual(api.seen.deletes.sort((a, b) => a - b), [11, 12], 'both stale assets are deleted before their replacement');
        } else {
          assert.deepEqual(api.seen.deletes, [], 'nothing to delete on a fresh release');
        }
      } finally {
        await api.close();
        fs.rmSync(dist.dir, { recursive: true, force: true });
      }
    });
  }

  test('refuses to publish an APK signed by another key', async () => {
    // The gate that matters for players: an APK from another machine cannot update an installed one, so uploading
    // it would hand every phone a "signature does not match" error and force an uninstall.
    const api = await fakeApi();
    const dist = makeDist();
    try {
      const run = await runPublish({
        dist: dist.dir, repo: 'o/n', token: 'fake', attempts: 1, quiet: true,
        api: `http://127.0.0.1:${api.port}`, uploads: `http://127.0.0.1:${api.port}`,
      }, 'fail');
      assert.equal(run.status, 1, `must refuse:\n${run.out}`);
      assert.match(run.out, /^ERR /m, 'the failure is reported');
      assert.match(run.out, /signature does not match/, 'and names the reason');
      assert.deepEqual(api.seen.uploads, [], 'nothing reaches the release — not even latest.json');
    } finally {
      await api.close();
      fs.rmSync(dist.dir, { recursive: true, force: true });
    }
  });

  test('refuses to publish when the feed names an artifact the build does not have', async () => {
    const api = await fakeApi();
    const dist = makeDist();
    try {
      // the feed promises a zip the build did not produce: publishing would advertise a 404 to every client
      fs.rmSync(path.join(dist.dir, dist.win));
      const run = await runPublish({
        dist: dist.dir, repo: 'o/n', token: 'fake', attempts: 1, quiet: true,
        api: `http://127.0.0.1:${api.port}`, uploads: `http://127.0.0.1:${api.port}`,
      });
      // Assertions below match on ASCII only (a file name): the tool's messages are Chinese, and comparing Chinese
      // literals from a child process' stdout is at the mercy of the console code page.
      assert.equal(run.status, 1, `must refuse:\n${run.out}`);
      assert.match(run.out, /^ERR /m, run.out);
      assert.match(run.out, new RegExp(dist.win.replace(/[.]/g, '\\.')), 'the refusal names the missing artifact');
      assert.deepEqual(api.seen.uploads, [], 'nothing is uploaded when the build is incomplete');
    } finally {
      await api.close();
      fs.rmSync(dist.dir, { recursive: true, force: true });
    }
  });

  test('a dropped upload is retried and the publish still succeeds', async () => {
    // This is the failure that started all of this: the connection dies mid-body and curl reports a transport error.
    // The first attempt must be thrown away, the second must complete, and the run must end successfully.
    const api = await fakeApi({ dropFirstUpload: true });
    const dist = makeDist();
    try {
      const run = await runPublish({
        dist: dist.dir, repo: 'o/n', token: 'fake', attempts: 3, retryWaitMs: 0, quiet: true,
        api: `http://127.0.0.1:${api.port}`, uploads: `http://127.0.0.1:${api.port}`,
      });
      assert.equal(run.status, 0, `the retry must recover:\n${run.out}\n${run.err}`);
      const winUploads = api.seen.uploads.filter((u) => u.name === dist.win);
      assert.equal(winUploads.length, 2, 'the zip was uploaded twice: the dropped one, then the retry');
      assert.deepEqual(api.seen.uploads.map((u) => u.name), [dist.win, dist.win, dist.android, 'latest.json']);
      // and the successful attempt carried the whole file, so the retry is not a partial transfer
      assert.equal(winUploads[1].bytes, fs.statSync(path.join(dist.dir, dist.win)).size);
    } finally {
      await api.close();
      fs.rmSync(dist.dir, { recursive: true, force: true });
    }
  });

  test('gives up after the configured number of attempts, naming the reason', async () => {
    // Every attempt dropped: the tool must stop (not loop forever) and say that re-running is safe.
    const api = await fakeApi({ dropEveryUpload: true });
    const dist = makeDist();
    try {
      const run = await runPublish({
        dist: dist.dir, repo: 'o/n', token: 'fake', attempts: 2, retryWaitMs: 0, quiet: true,
        api: `http://127.0.0.1:${api.port}`, uploads: `http://127.0.0.1:${api.port}`,
      });
      assert.equal(run.status, 1, run.out);
      assert.match(run.out, /^ERR /m, run.out);
      assert.equal(api.seen.uploads.length, 2, 'exactly `attempts` tries, then it stops');
      assert.match(run.out, /2/, 'the message reports how many attempts were made');
    } finally {
      await api.close();
      fs.rmSync(dist.dir, { recursive: true, force: true });
    }
  });

  test('a truncated upload is detected and the file is not reported as published', async () => {
    // The API answers 201 but with one byte fewer than the local file: publish must not claim success.
    const api = await fakeApi({ lieAboutSize: true });
    const dist = makeDist();
    try {
      const run = await runPublish({
        dist: dist.dir, repo: 'o/n', token: 'fake', attempts: 1, quiet: true,
        api: `http://127.0.0.1:${api.port}`, uploads: `http://127.0.0.1:${api.port}`,
      });
      assert.equal(run.status, 1);
      assert.match(run.out, /^ERR /m, 'the failure is reported');
      // the message quotes both sizes, which is the only ASCII anchor for "the upload did not match the file"
      assert.match(run.out, /4096/, run.out);
      assert.equal(api.seen.uploads.length, 1, 'it stops at the first bad upload instead of publishing the feed');
    } finally {
      await api.close();
      fs.rmSync(dist.dir, { recursive: true, force: true });
    }
  });
});

