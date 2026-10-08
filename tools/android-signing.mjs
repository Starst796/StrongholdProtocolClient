// Which key signed an APK, and is it the project's key?
//
// The Android side of this repo pins one signing key (see the signing block in mobile/android/app/build.gradle and
// client.config.json's android.signerSha256). That block stops a *build* from picking up a machine-local debug key;
// this module is the second gate, after the APK exists:
//
//   * tools/package-android.mjs  verifies what gradle just produced, and names the fingerprint in its output
//   * tools/publish-release.mjs  verifies the APK once more, right before uploading it to the world
//
// The check exists because Android only replaces an installed app when the new APK carries the *same* certificate
// (and a versionCode that does not go down). A second machine's auto-generated ~/.android/debug.keystore is a
// different key, so its APK installs but cannot update — the player sees "签名不一致" and has to uninstall, losing
// their save. Shipping that once (0.2.1) was enough.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/** The certificate every packaged APK must carry, from client.config.json (`android.signerSha256`); '' = not pinned. */
export function expectedSigner(config) {
  return String(config?.android?.signerSha256 ?? '').trim().toLowerCase();
}

/** Android SDK: ANDROID_HOME / ANDROID_SDK_ROOT, then the per-OS default the SDK manager installs into. */
export function findAndroidSdk(env = process.env) {
  const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT];
  if (process.platform === 'win32') candidates.push(path.join(env.LOCALAPPDATA || '', 'Android', 'Sdk'));
  else if (process.platform === 'darwin') candidates.push(path.join(os.homedir(), 'Library', 'Android', 'sdk'));
  else candidates.push(path.join(os.homedir(), 'Android', 'Sdk'));
  return candidates.find((c) => c && fs.existsSync(c)) || '';
}

/** The newest `apksigner` in <sdk>/build-tools, or null when the SDK (or the program) is not there. */
export function findApksigner(sdkDir = findAndroidSdk()) {
  if (!sdkDir) return null;
  const dir = path.join(sdkDir, 'build-tools');
  if (!fs.existsSync(dir)) return null;
  const version = (name) => name.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const names = fs.readdirSync(dir)
    .filter((n) => fs.existsSync(path.join(dir, n, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner')))
    .sort((a, b) => {
      const [av, bv] = [version(a), version(b)];
      for (let i = 0; i < 3; i++) if ((av[i] || 0) !== (bv[i] || 0)) return (bv[i] || 0) - (av[i] || 0);
      return b.localeCompare(a);
    });
  if (!names.length) return null;
  return path.join(dir, names[0], process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
}

/**
 * The signer's certificate SHA-256 out of `apksigner verify --print-certs` output — null when there is none (the
 * first signer is the one Android compares with the installed app; the rest of the list is a rotation lineage).
 * @param {string} text
 * @returns {string|null} lowercase hex
 */
export function parseSignerSha256(text) {
  const m = /Signer\s+#1\s+certificate\s+SHA-256\s+digest:\s*([0-9a-fA-F]{64})/.exec(String(text ?? ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * How to run apksigner for one APK. Exported and platform-parameterised so the Windows trap below is pinned by a
 * test rather than rediscovered: `<sdk>/build-tools/<v>/apksigner` is a **shell script** (`.bat` on Windows), and
 * `spawnSync` cannot execute a batch file — it fails with `status: null` and an empty output, which reads as
 * "apksigner printed nothing" rather than "apksigner never ran".
 *
 * The command line is handed to cmd.exe as one pre-quoted string, so `shell: true` is never needed (Node warns about
 * it: with a shell, arguments are concatenated rather than escaped).
 */
export function apksignerCommand(file, apksigner, platform = process.platform, comspec = process.env.ComSpec || 'cmd.exe') {
  if (platform === 'win32') {
    return { cmd: comspec, args: ['/d', '/s', '/c', `"${apksigner}" verify --print-certs "${file}"`], shell: false };
  }
  return { cmd: apksigner, args: ['verify', '--print-certs', file], shell: false };
}

/**
 * Verify one APK's signer against the project's expected one.
 *
 * @param {string} file  the APK
 * @param {{ expected?: string, sdkDir?: string, run?: Function }} [opts] `run` is injectable for tests
 * @returns {{ ok: boolean|null, sha256: string|null, reason?: string, apksigner?: string|null }}
 *   ok: true = matches (or nothing is pinned), false = a real mismatch (never ship it), null = could not check
 */
export function verifyApkSigner(file, { expected = '', sdkDir = undefined, run = null } = {}) {
  const wanted = String(expected ?? '').trim().toLowerCase();
  if (!fs.existsSync(file)) return { ok: false, sha256: null, reason: `${file} 不存在` };
  // An injected runner *is* the tool: tests pass one, and probing the SDK would answer before it could be used.
  const apksigner = run ? null : findApksigner(sdkDir);
  if (!run && !apksigner) {
    return { ok: wanted ? null : true, sha256: null, apksigner: null, reason: '找不到 apksigner（Android SDK build-tools 不在）' };
  }
  const call = run ?? ((cmd, args, options) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...options }));
  const { cmd, args, shell } = apksignerCommand(file, apksigner ?? 'apksigner');
  const res = call(cmd, args, { shell });
  const out = `${res?.stdout ?? ''}\n${res?.stderr ?? ''}`;
  const sha256 = parseSignerSha256(out);
  if (!sha256) {
    // `res.error` is the difference between "apksigner ran and said nothing" and "apksigner never started".
    const why = res?.error ? `无法运行 apksigner：${res.error.message}` : `apksigner 没有读出证书（退出码 ${res?.status}）`;
    return { ok: false, sha256: null, apksigner, reason: `${why}：${out.trim().split('\n').slice(0, 3).join(' / ') || '(无输出)'}` };
  }
  if (!wanted) return { ok: true, sha256, apksigner, reason: 'client.config.json 没有钉住签名指纹' };
  if (sha256 !== wanted) {
    return {
      ok: false, sha256, apksigner,
      reason: [
        '签名指纹与项目不符 —— 这个包无法覆盖安装已经发布的版本（会提示"签名不一致"）：',
        `  实际 ${sha256}`,
        `  期望 ${wanted}`,
        '  修法：把项目那把 keystore 复制到这台机器（或 -Psp.keystore / SP_KEYSTORE 指向它）后重新打包，',
        '        参见 docs/PACKAGING.md §5「签名」与 mobile/android/app/build.gradle 顶部的说明。',
      ].join('\n'),
    };
  }
  return { ok: true, sha256, apksigner };
}
