// Prerequisites of the Android build that are *not* code bugs, and that Gradle reports only after it has started —
// with text that never names the cause (docs/PACKAGING-EXPERIENCE.md §7). Running them up front turns a ten-minute
// dead end (800 MB payload + a Gradle configuration phase) into a one-line refusal.
//
// Everything here is a pure function over its arguments so the checks can be unit-tested on a machine that has
// neither the trap nor a JDK (the CI runner is ASCII-path Ubuntu/Windows and never sees them).

import fs from 'node:fs';
import path from 'node:path';

/**
 * Code points of `text` outside printable ASCII, in order of appearance (deduplicated). AGP refuses a project path
 * with any of them, on every platform: "Your project path contains non-ASCII characters". Spaces and `~` are fine.
 */
export function nonAsciiIn(text) {
  const bad = [];
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if ((code < 0x20 || code > 0x7e) && !bad.includes(ch)) bad.push(ch);
  }
  return bad;
}

/**
 * Why a non-ASCII project path is fatal to `gradlew`, or null when the path is fine.
 *
 * `android.overridePathCheck=true` — which AGP's own message suggests — is a trap: it only moves the failure to
 * `Failed to create service 'AndroidLocationsBuildService'` plus `Couldn't open current thread, error = 5`.
 */
export function pathProblem(projectDir) {
  const bad = nonAsciiIn(projectDir);
  if (!bad.length) return null;
  return (
    `Android 工程路径含非 ASCII 字符（${bad.map((c) => JSON.stringify(c)).join(' ')}）：${projectDir}\n` +
    `AGP 会在一分钟后直接拒绝：Your project path contains non-ASCII characters。\n` +
    `别加 android.overridePathCheck=true —— 那只是把失败换成更难读的 AndroidLocationsBuildService /\n` +
    `"Couldn't open current thread, error = 5"，一样构建不出来。\n` +
    `package-android 在 Windows 上会用 subst 盘符给这份树一个纯 ASCII 视图（同一批文件，不复制）；\n` +
    `这里拒绝是因为连那一步也做不到 —— 见 docs/PACKAGING-EXPERIENCE.md §7a。`
  );
}

/**
 * The deepest ancestor of `dir` whose path relative to `dir` is pure ASCII, or null when no such ancestor helps
 * (an ASCII path needs none; a directory whose *root* is the only broken piece cannot be fixed this way).
 *
 * On Windows `subst X: <ancestor>` turns `E:\卫\fork\mobile\android` into `X:\fork\mobile\android`, which is all
 * AGP's path check looks at — the same files, no copy of the 800 MB payload (docs/PACKAGING-EXPERIENCE.md §7a).
 * path.win32 on purpose: the rule is about Windows paths, and the tests must not depend on the host.
 */
export function asciiAnchorFor(dir) {
  if (!pathProblem(dir)) return null;
  const win = path.win32;
  let anchor = null;
  for (let probe = dir; ; ) {
    const parent = win.dirname(probe);
    if (parent === probe) break; // reached the drive root: nothing left to map
    if (nonAsciiIn(win.relative(parent, dir)).length) break; // the tail would still carry the bad character
    anchor = parent;
    probe = parent;
  }
  return anchor;
}

/**
 * Why the two Android home variables cannot both be set, or null when at most one is.
 *
 * AGP rejects the pair even when both hold the *same* path, and only with `--stacktrace` does the real reason show:
 * `com.android.prefs.AndroidLocationsException: Several environment variables ... different paths to the Android
 * Preferences folder`. ANDROID_PREFS_ROOT is the deprecated one; ANDROID_USER_HOME is the one to keep.
 */
export function androidPrefsProblem(env = process.env) {
  const user = (env.ANDROID_USER_HOME || '').trim();
  const prefs = (env.ANDROID_PREFS_ROOT || '').trim();
  if (!user || !prefs) return null;
  return (
    `ANDROID_USER_HOME 与 ANDROID_PREFS_ROOT 不能同时设置（值相同也算冲突）：\n` +
    `  ANDROID_USER_HOME=${user}\n` +
    `  ANDROID_PREFS_ROOT=${prefs}\n` +
    `Gradle 会报 Failed to create service 'AndroidLocationsBuildService'，加 --stacktrace 才看得到真因\n` +
    `com.android.prefs.AndroidLocationsException（"different paths ..." 是误导）。\n` +
    `删掉 ANDROID_PREFS_ROOT，只留 ANDROID_USER_HOME（docs/PACKAGING-EXPERIENCE.md §7b）。`
  );
}

/** Paths compared the way the OS does it: separators and trailing slashes normalized, case folded on Windows. */
function samePath(a, b) {
  const norm = (p) => {
    const n = path.normalize(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? n.toLowerCase() : n;
  };
  return norm(a) === norm(b);
}

/**
 * A warning (never fatal) when ANDROID_HOME and ANDROID_SDK_ROOT point at different SDKs, or null.
 *
 * Both are read, first hit wins, so a stale ANDROID_SDK_ROOT is harmless — until the day a build picks it and
 * "SDK 36 not found" points at the wrong install. Cheaper to notice here than then.
 */
export function sdkEnvWarning(env = process.env) {
  const home = (env.ANDROID_HOME || '').trim();
  const root = (env.ANDROID_SDK_ROOT || '').trim();
  if (!home || !root || samePath(home, root)) return null;
  return `ANDROID_HOME 与 ANDROID_SDK_ROOT 指向不同的目录（只会用 ANDROID_HOME）：\n  ANDROID_HOME=${home}\n  ANDROID_SDK_ROOT=${root}`;
}

/**
 * Major version of the JDK in `dir`, read from its `release` file; 0 when it cannot be read (no `release` file, or
 * `dir` is not a JDK at all — callers tolerate 0 rather than inventing a version).
 */
export function jdkMajor(dir) {
  try {
    const m = /^JAVA_VERSION="?(\d+)/m.exec(fs.readFileSync(path.join(dir, 'release'), 'utf8'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * Why `JAVA_HOME` cannot build the Android client, or null when it can (or when the version is unreadable — Gradle
 * will then say something concrete itself).
 *
 * @capacitor/android 8 compiles with `sourceCompatibility 21`, so a 17 JDK passes every "is there a JDK" check in
 * this repo, syncs the payload, and only then dies in :capacitor-android's javac with "无效源发行版: 21" — an error
 * that never mentions the JDK it wants.
 */
export function jdkProblem(javaHome) {
  if (!javaHome) return '未设置 JAVA_HOME —— Gradle 需要 JDK 21+（见 docs/PACKAGING.md §5）';
  const major = jdkMajor(javaHome);
  if (!major || major >= 21) return null;
  return (
    `JAVA_HOME 指向 JDK ${major}，但 Capacitor 8 的 android 模块用 Java 21 编译（sourceCompatibility 21）。\n` +
    `低于 21 会在 :capacitor-android:compileDebugJavaWithJavac 报"无效源发行版: 21"，而那时 payload 已经同步完。\n` +
    `换一个 JDK 21+ 的 JAVA_HOME 再打包（见 docs/PACKAGING.md §5）。`
  );
}
