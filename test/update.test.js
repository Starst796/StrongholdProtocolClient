// The update check: this repo's own build counter, the feed a release publishes, and the rules the picker uses to
// decide whether to offer an update.
//
// The DOM half of the picker needs a browser (the packaged app is driven over CDP against a local feed), so what is
// pinned here is everything that can go wrong *silently*: a build number that does not rise (Android then refuses
// the update, or keeps re-offering one), a feed that parses into a bogus "new version", a verdict that offers an
// *older* download than what the player runs.
//
// Dependency-free on purpose: no DOM stub, no network, `node --test` straight from a fresh clone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  BUILD_MAX, androidVersionCode, assetUrl, buildLatestFeed, latestFeedUrl, nextBuild, readRelease, releaseTag,
  sha256File, versionCode,
} from '../tools/release-meta.mjs';
import {
  FEED_MAX_BYTES, K_SKIP_UPDATE, parseLatestFeed, updateAsset, updateLabel, updatePlatform, updateUrlOk,
  updateVerdict,
} from '../shell/picker-core.js';
import { runtimeConfigSource } from '../tools/package-client.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_F = 'f'.repeat(64);

/** A published feed, the shape tools/package-release.mjs writes into build/dist/latest.json. */
function feed(overrides = {}) {
  return {
    schema: 1,
    version: '0.1.3',
    build: 12,
    versionCode: 1030012,
    tag: 'v0.1.3-b12',
    protocol: 1,
    gameCommit: '64715116ba0804617fc7924f54288854bcd248ee',
    publishedAt: '2026-10-07T12:00:00.000Z',
    notes: '上游 0.1.3',
    win: { name: 'StrongholdProtocol-0.1.3-win-x64.zip', url: 'https://github.com/o/n/releases/download/v0.1.3-b12/StrongholdProtocol-0.1.3-win-x64.zip', sha256: SHA_F, size: 362785423 },
    android: { name: 'StrongholdProtocol-0.1.3-android-debug.apk', url: 'https://github.com/o/n/releases/download/v0.1.3-b12/StrongholdProtocol-0.1.3-android-debug.apk', sha256: SHA_A, size: 227784327 },
    ...overrides,
  };
}

/** An Android-only feed whose single artifact is `android` — for the cases where *that* artifact is the problem. */
const androidOnly = (android) => JSON.stringify(feed({ win: null, android }));

/** The feed as the picker sees it: through parseLatestFeed, which is what updateAsset/updateLabel are given. */
const published = (overrides = {}) => parseLatestFeed(JSON.stringify(feed(overrides)));

describe('the client build number', () => {
  test('Gradle gets a versionCode that rises with the build, not only with the version', () => {
    assert.equal(androidVersionCode('0.1.3', 12), 1030012);
    // Every 0.1.3 build the APK before this counter carried was 103 — a new build must outrank it, or Android
    // treats the update as an equal/older install (and some ROMs refuse it outright).
    assert.ok(androidVersionCode('0.1.3', 1) > 103);
    // A version bump outranks every build of the previous version, however many builds it had.
    assert.ok(androidVersionCode('0.1.4', 0) > androidVersionCode('0.1.3', BUILD_MAX));
    assert.equal(androidVersionCode('0.1.3'), 1030000);
    assert.equal(androidVersionCode('nonsense', 3), null, 'an unparseable version has no code');
  });

  test('the semver part stays what Android already has installed', () => {
    assert.equal(versionCode('0.1.2'), 102);
    assert.equal(versionCode('0.1.3'), 103);
  });

  test('the tracked counter only ever moves forward', () => {
    const current = readRelease().build;
    assert.ok(Number.isInteger(current) && current >= 0, `release.json must hold a build number, got ${current}`);
    assert.equal(nextBuild(undefined), current + 1);
    assert.equal(nextBuild('7'), 7, '--build re-publishes an explicit number');
    assert.throws(() => nextBuild('0'));
    assert.throws(() => nextBuild(String(BUILD_MAX + 1)));
  });

  test('a release tag names the build', () => {
    assert.equal(releaseTag('0.1.3', 12), 'v0.1.3-b12');
  });
});

describe('the published feed', () => {
  test('points at the release it will live in, with the artifacts pinned by sha256', () => {
    const built = buildLatestFeed({
      version: '0.1.3', build: 12, protocol: 1, tag: 'v0.1.3-b12', repo: 'o/n', gameCommit: 'abc123',
      notes: '注', publishedAt: '2026-10-07T12:00:00.000Z',
      assets: { win: { name: 'a.zip', sha256: SHA_F, size: 10 }, android: { name: 'b.apk', sha256: SHA_A, size: 20 } },
    });
    assert.equal(built.schema, 1);
    assert.equal(built.versionCode, 1030012);
    assert.equal(built.win.url, 'https://github.com/o/n/releases/download/v0.1.3-b12/a.zip');
    assert.equal(built.android.sha256, SHA_A);
    assert.equal(built.android.size, 20);
    assert.equal(built.publishedAt, '2026-10-07T12:00:00.000Z');
    // what the release writes is what the client accepts (the two modules must not drift apart)
    assert.ok(parseLatestFeed(JSON.stringify(built)), 'a freshly built feed parses');
  });

  test('skips a platform that has no artifact', () => {
    const built = buildLatestFeed({ version: '0.1.3', build: 3, tag: 'v0.1.3-b3', repo: 'o/n', assets: { win: null, android: { name: 'b.apk', sha256: SHA_A, size: 20 } } });
    assert.equal('win' in built, false);
    assert.ok(built.android);
  });

  test('encodes an asset name in the URL', () => {
    assert.equal(assetUrl('o/n', 'v0.1.3-b12', 'a b.apk'), 'https://github.com/o/n/releases/download/v0.1.3-b12/a%20b.apk');
  });

  test('the URL clients poll is the releases/latest alias', () => {
    assert.equal(latestFeedUrl('o/n'), 'https://github.com/o/n/releases/latest/download/latest.json');
  });

  test('sha256File hashes the whole file, streamed', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-sha-')), 'artifact.bin');
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 7); // more than one chunk
    fs.writeFileSync(file, bytes);
    try {
      assert.equal(sha256File(file), createHash('sha256').update(bytes).digest('hex'));
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});

describe('a feed the client must refuse', () => {
  const rejected = {
    'an HTML page (a captive portal or a 404 page)': '<!doctype html><html>hello</html>',
    'truncated JSON': '{"schema":1,"build":12',
    'a future schema': JSON.stringify(feed({ schema: 2 })),
    'a missing build number': JSON.stringify(feed({ build: undefined })),
    'a zero build number': JSON.stringify(feed({ build: 0 })),
    'a non-numeric build': JSON.stringify(feed({ build: 'latest' })),
    'an array': '[]',
    'nothing at all': '',
    'an artifact without a sha256': androidOnly({ name: 'a.apk', url: 'https://x/a.apk', size: 5 }),
    'an artifact whose sha256 is not hex': androidOnly({ name: 'a.apk', url: 'https://x/a.apk', sha256: 'nope', size: 5 }),
    'an artifact with no size': androidOnly({ name: 'a.apk', url: 'https://x/a.apk', sha256: SHA_A }),
    'an artifact over plain http on the internet': androidOnly({ name: 'a.apk', url: 'http://evil.example/a.apk', sha256: SHA_A, size: 5 }),
    'an artifact with a javascript: url': androidOnly({ name: 'a.apk', url: 'javascript:alert(1)', sha256: SHA_A, size: 5 }),
    'a feed with no usable artifact': JSON.stringify(feed({ win: null, android: null })),
    'a very long answer': JSON.stringify(feed({ notes: 'x'.repeat(FEED_MAX_BYTES + 1) })),
  };
  for (const [what, raw] of Object.entries(rejected)) {
    test(`refuses ${what}`, () => {
      assert.equal(parseLatestFeed(raw), null);
    });
  }

  test('takes a feed whose artifacts are pinned and reachable', () => {
    const parsed = parseLatestFeed(JSON.stringify(feed()));
    assert.equal(parsed.build, 12);
    assert.equal(parsed.versionCode, 1030012);
    assert.equal(parsed.commit, '64715116ba0804617fc7924f54288854bcd248ee');
    assert.equal(parsed.android.size, 227784327);
    assert.equal(parsed.win.name, 'StrongholdProtocol-0.1.3-win-x64.zip');
  });

  test('caps the text it takes from somebody else\'s JSON', () => {
    const parsed = parseLatestFeed(JSON.stringify(feed({ notes: 'n'.repeat(500), version: '1'.repeat(200) })));
    assert.ok(parsed.notes.length <= 240, `notes must be capped, got ${parsed.notes.length}`);
    assert.ok(parsed.version.length <= 64, `version must be capped, got ${parsed.version.length}`);
  });

  test('allows plain http only on this machine (a locally served test feed)', () => {
    assert.equal(updateUrlOk('https://github.com/o/n/releases/download/t/a.apk'), true);
    assert.equal(updateUrlOk('http://127.0.0.1:8123/latest.json'), true);
    assert.equal(updateUrlOk('http://localhost:8123/a.apk'), true);
    assert.equal(updateUrlOk('http://192.168.1.9/a.apk'), false, 'a LAN address is not this machine');
    assert.equal(updateUrlOk('http://evil.example/a.apk'), false);
    assert.equal(updateUrlOk('file:///etc/passwd'), false);
    assert.equal(updateUrlOk('not a url'), false);
    assert.equal(updateUrlOk(undefined), false);
  });
});

describe('whether to offer an update', () => {
  const local = (build, versionCode) => ({ build, versionCode });

  test('a higher published build is newer, a lower one is never offered', () => {
    assert.equal(updateVerdict(local(12, 1030012), { build: 13, versionCode: 1030013 }), 'newer');
    assert.equal(updateVerdict(local(12, 1030012), { build: 12, versionCode: 1030012 }), 'same');
    assert.equal(updateVerdict(local(12, 1030012), { build: 11, versionCode: 1030011 }), 'older', 'a stale feed must not offer a downgrade');
  });

  test('versionCode breaks a tie (a feed published before the counter existed)', () => {
    assert.equal(updateVerdict(local(12, 103), { build: 12, versionCode: 1030012 }), 'newer');
    assert.equal(updateVerdict(local(12, 1030012), { build: 12, versionCode: 103 }), 'older');
    assert.equal(updateVerdict(local(12, null), { build: 12, versionCode: null }), 'same');
  });

  test('says nothing when this client cannot tell what it is', () => {
    assert.equal(updateVerdict(null, { build: 13 }), 'unknown', 'build.json unreadable: stay quiet rather than guess');
    assert.equal(updateVerdict(local(undefined), { build: 13 }), 'unknown');
    assert.equal(updateVerdict(local(12), null), 'unknown');
    assert.equal(updateVerdict(local(12), { build: 0 }), 'unknown');
  });

  test('an install from before the counter (build 0) is offered the published build', () => {
    assert.equal(updateVerdict(local(0, null), { build: 1, versionCode: 1030001 }), 'newer');
  });
});

describe('what the update row says', () => {
  test('the phone installs the APK, the desktop the zip', () => {
    assert.equal(updatePlatform('Mozilla/5.0 (Linux; Android 13; SM-F936B) AppleWebKit/537.36'), 'android');
    assert.equal(updatePlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'), 'win');
    assert.equal(updateAsset(published(), 'android').name.endsWith('.apk'), true);
    assert.equal(updateAsset(published(), 'win').name.endsWith('.zip'), true);
    assert.equal(updateAsset(published({ android: null }), 'android'), null);
  });

  test('names the version, the build, the upstream commit and the download size', () => {
    assert.equal(updateLabel(published(), 'android'), '0.1.3 · build 12 · 64715116 · 下载 217.2 MB');
  });

  test('still says something when this platform has no artifact', () => {
    assert.equal(updateLabel(published({ android: null }), 'android'), '0.1.3 · build 12 · 64715116');
  });

  test('the ignore flag is a shell preference like the others', () => {
    assert.match(K_SKIP_UPDATE, /^sp\.shell\./);
  });
});

describe('the payload carries its own build and the feed', () => {
  test('runtime-config.js carries the feed the picker polls', () => {
    const src = runtimeConfigSource('localhost:3000', false, 'https://github.com/o/n/releases/latest/download/latest.json');
    assert.match(src, /globalThis\.__SP_UPDATE_FEED__ = "https:\/\/github\.com\/o\/n\/releases\/latest\/download\/latest\.json";/);
  });

  test('an empty feed means the client makes no update request at all', () => {
    assert.match(runtimeConfigSource('localhost:3000'), /globalThis\.__SP_UPDATE_FEED__ = "";/);
  });
});
