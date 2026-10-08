// The Android signing key: one key for every machine, checked by fingerprint.
//
// Why this file exists: Android only replaces an installed app when the new APK carries the *same* certificate.
// Android Studio / AGP generate a debug keystore per machine, so an APK built on a second machine could not update
// the one built on the first — players saw a "signature does not match" error and had to uninstall (losing their
// save). 0.2.1 shipped that way. The project key is now pinned in client.config.json and enforced twice: at build
// time (build.gradle refuses to build with another key) and after the fact (this module, on the APK itself, before
// it is uploaded).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apksignerCommand, expectedSigner, findApksigner, parseSignerSha256, verifyApkSigner } from '../tools/android-signing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** An existing file to hand verifyApkSigner: the signer itself is injected through `run`. */
const SELF = fileURLToPath(import.meta.url);
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'client.config.json'), 'utf8'));
/** The project key: the certificate every released APK must carry. */
const PROJECT_KEY = expectedSigner(CONFIG);
/** The key 0.2.1 was accidentally signed with (built on another machine) — a real mismatching fingerprint. */
const OTHER_KEY = '25a487f6a20d35954d350fa66e0b5f898d913c1c533a779b6b956268305fd792';

/** apksigner's real output shape (abridged). */
const apksignerOutput = (sha) => [
  'Verifies',
  'Verified using v1 scheme (JAR signing): false',
  'Verified using v2 scheme (APK Signature Scheme v2): true',
  'Number of signers: 1',
  'Signer #1 certificate DN: C=US, O=Android, CN=Android Debug',
  `Signer #1 certificate SHA-256 digest: ${sha}`,
  'Signer #1 certificate SHA-1 digest: cb54004fb6d1143aec9654deefa417441673e016',
].join('\n');

describe('the project key is pinned', () => {
  test('client.config.json names it, as a SHA-256', () => {
    assert.match(PROJECT_KEY, /^[0-9a-f]{64}$/, 'android.signerSha256 must be a lowercase SHA-256');
    assert.ok(CONFIG.android?.keystoreHint, 'and says where the keystore lives / how to bring it along');
  });

  test('it is the key every APK released so far was signed with', () => {
    // History: 0.1.0 … 0.2.0 were all built on the machine that owns that debug keystore, and Android accepted each
    // update over the previous one — so that fingerprint is the one installed players already have. Changing this
    // value means every player must uninstall.
    assert.equal(PROJECT_KEY, '80f08c97e4b24eb62b415df034b069ae4381d8cfb1d96895a5a9c1471b613744');
  });
});

describe('reading the signer out of apksigner output', () => {
  test('takes signer #1 (the one Android compares with the installed app)', () => {
    assert.equal(parseSignerSha256(apksignerOutput(PROJECT_KEY)), PROJECT_KEY);
    assert.equal(parseSignerSha256(apksignerOutput(PROJECT_KEY.toUpperCase())), PROJECT_KEY, 'case is normalised');
  });

  test('a rotation lineage reports several signers — #1 is still the leaf', () => {
    const text = `${apksignerOutput(PROJECT_KEY)}\nSigner #2 certificate SHA-256 digest: ${OTHER_KEY}`;
    assert.equal(parseSignerSha256(text), PROJECT_KEY);
  });

  test('says nothing rather than guessing when the output is not a certificate list', () => {
    assert.equal(parseSignerSha256(''), null);
    assert.equal(parseSignerSha256('DOES NOT VERIFY'), null);
    assert.equal(parseSignerSha256('Signer #1 certificate DN: CN=x'), null, 'no digest line');
    assert.equal(parseSignerSha256('Signer #1 certificate SHA-256 digest: not-a-hash'), null);
  });
});

describe('finding apksigner in the Android SDK', () => {
  test('picks the newest build-tools, not the alphabetically last', () => {
    const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-sdk-'));
    const exe = process.platform === 'win32' ? 'apksigner.bat' : 'apksigner';
    try {
      for (const v of ['9.0.0', '35.0.0', '36.0.0']) {
        fs.mkdirSync(path.join(sdk, 'build-tools', v), { recursive: true });
        fs.writeFileSync(path.join(sdk, 'build-tools', v, exe), '');
      }
      assert.equal(findApksigner(sdk), path.join(sdk, 'build-tools', '36.0.0', exe));
      fs.rmSync(path.join(sdk, 'build-tools', '36.0.0'), { recursive: true });
      assert.equal(findApksigner(sdk), path.join(sdk, 'build-tools', '35.0.0', exe), 'a string sort would pick 9.0.0');
    } finally {
      fs.rmSync(sdk, { recursive: true, force: true });
    }
  });

  test('no SDK, no apksigner: it reports that instead of inventing a fingerprint', () => {
    const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-sdk-'));
    try {
      assert.equal(findApksigner(sdk), null);
      assert.equal(findApksigner(''), null);
    } finally {
      fs.rmSync(sdk, { recursive: true, force: true });
    }
  });
});

describe('verifying an APK before it is shipped', () => {
  /** A stand-in for the spawned apksigner: `output` is what it "prints". */
  const runner = (status, output) => () => ({ status, stdout: output, stderr: '' });

  test('accepts the project key', () => {
    const res = verifyApkSigner(SELF, { expected: PROJECT_KEY, sdkDir: 'x', run: runner(0, apksignerOutput(PROJECT_KEY)) });
    assert.equal(res.ok, true);
    assert.equal(res.sha256, PROJECT_KEY);
  });

  test('refuses another machine\'s key, and says what to do about it', () => {
    // This is 0.2.1: a different auto-generated debug key. Shipping it means "signature does not match" on every
    // phone that already has the app.
    const res = verifyApkSigner(SELF, { expected: PROJECT_KEY, sdkDir: 'x', run: runner(0, apksignerOutput(OTHER_KEY)) });
    assert.equal(res.ok, false);
    assert.equal(res.sha256, OTHER_KEY);
    assert.match(res.reason, /\u7b7e\u540d\u4e0d\u4e00\u81f4/, 'the message names the symptom the player sees');
    assert.match(res.reason, /sp\.keystore/, 'the fix (point the build at the project keystore) is spelled out');
  });

  test('refuses an APK with no readable certificate', () => {
    const bad = verifyApkSigner(SELF, { expected: PROJECT_KEY, sdkDir: 'x', run: runner(1, 'DOES NOT VERIFY') });
    assert.equal(bad.ok, false, 'an unsigned/corrupt APK must never be published');
    const empty = verifyApkSigner(SELF, { expected: PROJECT_KEY, sdkDir: 'x', run: runner(0, '') });
    assert.equal(empty.ok, false);
  });

  test('a missing file is a refusal, not a pass', () => {
    assert.equal(verifyApkSigner(path.join(os.tmpdir(), 'nope.apk'), { expected: PROJECT_KEY }).ok, false);
  });

  test('without a pinned fingerprint it reports the key instead of failing the build', () => {
    const res = verifyApkSigner(SELF, { expected: '', sdkDir: 'x', run: runner(0, apksignerOutput(OTHER_KEY)) });
    assert.equal(res.ok, true);
    assert.equal(res.sha256, OTHER_KEY);
  });
});

describe('how apksigner is invoked', () => {
  test('Windows runs the .bat through a shell (spawnSync cannot execute a .bat directly)', () => {
    // Without the shell, spawnSync fails with `status: null` and no output — which looks like "apksigner is silent"
    // rather than "apksigner never ran". This is the bug that broke the first packaging run of this check.
    const win = apksignerCommand('C:/tmp/app-debug.apk', 'C:/Users/x/AppData/Local/Android/Sdk/build-tools/36.0.0/apksigner.bat', 'win32');
    assert.equal(win.shell, true);
    assert.deepEqual(win.args, ['verify', '--print-certs', 'C:/tmp/app-debug.apk']);
    assert.match(win.cmd, /apksigner\.bat/);
  });

  test('paths with spaces are quoted on Windows, left alone elsewhere', () => {
    const spaced = 'C:/Program Files/Android/Sdk/build-tools/36.0.0/apksigner.bat';
    const win = apksignerCommand('C:/a b/c d.apk', spaced, 'win32');
    assert.equal(win.cmd, `"${spaced}"`, 'the program path is quoted or cmd.exe splits it at the space');
    assert.equal(win.args[2], '"C:/a b/c d.apk"', 'and so is the APK path');
    const nix = apksignerCommand('/tmp/a b.apk', '/opt/sdk/apksigner', 'linux');
    assert.equal(nix.shell, false, 'elsewhere apksigner is an executable script with a shebang');
    assert.equal(nix.cmd, '/opt/sdk/apksigner');
    assert.equal(nix.args[2], '/tmp/a b.apk', 'the args array needs no quoting without a shell');
  });

  test('a tool that never started says so instead of reporting an empty result', () => {
    const res = verifyApkSigner(SELF, {
      expected: PROJECT_KEY, sdkDir: 'x',
      run: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawnSync apksigner.bat EINVAL') }),
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /无法运行 apksigner.*EINVAL/);
  });
});

describe('the guard is wired into both halves of a release', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('build.gradle pins the key and refuses to build with another one', () => {
    const gradle = read('mobile/android/app/build.gradle');
    assert.match(gradle, /client\.config\.json/, 'the expected fingerprint comes from the committed config');
    assert.match(gradle, /signerSha256/);
    assert.match(gradle, /signingConfigs\s*\{/);
    assert.match(gradle, /SP_KEYSTORE/, 'another machine can point at the project keystore');
    assert.match(gradle, /sp\.keystore/, '...via local.properties too');
    assert.match(gradle, /throw new GradleException/, 'a missing/mismatched keystore fails the build');
    // both build types must use it, or `assembleDebug` keeps using the machine's own key
    assert.match(gradle, /debug\s*\{[^}]*signingConfig signingConfigs\.sp/s);
    assert.match(gradle, /release\s*\{[^}]*signingConfig signingConfigs\.sp/s);
  });

  test('the packaging step verifies the artifact gradle produced', () => {
    const src = read('tools/package-android.mjs');
    assert.match(src, /verifyApkSigner\(/, 'the APK itself is checked, not just the build config');
    assert.match(src, /expectedSigner\(loadConfig\(\)\)/);
    assert.match(src, /signer\.ok === false\) throw/, 'a mismatch fails the build');
  });

  test('the publish step verifies it again, right before uploading', () => {
    const src = read('tools/publish-release.mjs');
    assert.match(src, /signerCheck\(file, \{ expected: expectedSigner\(config\) \}\)/);
    assert.match(src, /signerCheck = o\.signerCheck \?\? verifyApkSigner/, 'the real check is the default (only tests replace it)');
    assert.match(src, /platform === 'android'/, 'the check is on the APK, the platform that must update in place');
  });
});
