// Pins tools/android-preflight.mjs — the three prerequisites that Gradle reports only after a build has started, with
// error text that never names the cause (docs/PACKAGING-EXPERIENCE.md §7). The checks are pure functions precisely so
// they can be asserted here: the CI runner has an ASCII path, a single ANDROID_* pair and a JDK 21, so the traps
// themselves never occur there.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { androidPrefsProblem, asciiAnchorFor, jdkMajor, jdkProblem, nonAsciiIn, pathProblem, sdkEnvWarning } from '../tools/android-preflight.mjs';

/** A throwaway directory holding a JDK-shaped `release` file (or none at all). */
function fakeJdk(release) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-preflight-'));
  if (release !== null) writeFileSync(path.join(dir, 'release'), release);
  return dir;
}

describe('nonAsciiIn', () => {
  test('accepts printable ASCII, including the space in "Program Files"', () => {
    assert.deepEqual(nonAsciiIn('C:\\Program Files\\Java\\jdk-21.0.13+9'), []);
  });

  test('reports each offending character once, in order', () => {
    assert.deepEqual(nonAsciiIn('E:\\卫\\fork\\卫'), ['卫']);
    assert.deepEqual(nonAsciiIn('a\u00e9b'), ['\u00e9']);
  });
});

describe('pathProblem', () => {
  test('refuses a non-ASCII project path and names the character', () => {
    const msg = pathProblem('E:\\卫\\fork\\mobile\\android');
    assert.ok(msg, 'a non-ASCII path must be refused');
    assert.match(msg, /非 ASCII/);
    assert.match(msg, /\u536b/); // 卫
    assert.match(msg, /overridePathCheck/); // the escape hatch AGP suggests, and why not to use it
  });

  test('waves an ASCII path through', () => {
    assert.equal(pathProblem('D:\\a\\stronghold-protocol-client\\mobile\\android'), null);
    assert.equal(pathProblem('/home/runner/work/client/mobile/android'), null);
  });
});

describe('asciiAnchorFor', () => {
  // `subst X: E:\卫` gives E:\卫\fork\mobile\android the ASCII view X:\fork\mobile\android, which is the shallowest
  // ancestor that works — mapping the drive root instead would still leave the 卫 in the path Gradle sees.
  test('picks the deepest ancestor that hides the non-ASCII segment', () => {
    assert.equal(asciiAnchorFor('E:\\卫\\fork\\mobile\\android'), 'E:\\卫');
    assert.equal(asciiAnchorFor('D:\\a\\卫\\b'), 'D:\\a\\卫');
    assert.equal(asciiAnchorFor('C:\\Users\\卫\\x'), 'C:\\Users\\卫');
  });

  test('has nothing to offer an ASCII path, or a tree broken at the drive root', () => {
    assert.equal(asciiAnchorFor('D:\\a\\client\\mobile\\android'), null);
    assert.equal(asciiAnchorFor('E:\\卫'), null); // X:\卫 is still non-ASCII
  });
});

describe('androidPrefsProblem', () => {
  test('refuses ANDROID_USER_HOME together with ANDROID_PREFS_ROOT', () => {
    const both = { ANDROID_USER_HOME: '/b/android-user', ANDROID_PREFS_ROOT: '/b/android-user' };
    assert.match(androidPrefsProblem(both), /ANDROID_PREFS_ROOT/);
    assert.match(androidPrefsProblem(both), /ANDROID_USER_HOME/);
  });

  test('refuses them even when the paths are identical — AGP does', () => {
    assert.notEqual(androidPrefsProblem({ ANDROID_USER_HOME: 'X', ANDROID_PREFS_ROOT: 'X' }), null);
  });

  test('accepts either one alone, and neither', () => {
    assert.equal(androidPrefsProblem({ ANDROID_USER_HOME: 'X' }), null);
    assert.equal(androidPrefsProblem({ ANDROID_PREFS_ROOT: 'X' }), null);
    assert.equal(androidPrefsProblem({}), null);
    assert.equal(androidPrefsProblem({ ANDROID_USER_HOME: '  ', ANDROID_PREFS_ROOT: '' }), null);
  });
});

describe('sdkEnvWarning', () => {
  test('is silent when only one is set, or both agree', () => {
    assert.equal(sdkEnvWarning({ ANDROID_HOME: 'C:\\sdk' }), null);
    assert.equal(sdkEnvWarning({ ANDROID_HOME: 'C:\\sdk', ANDROID_SDK_ROOT: 'C:\\sdk\\' }), null);
  });

  test('warns when they point at different SDKs', () => {
    const msg = sdkEnvWarning({ ANDROID_HOME: 'C:\\sdk', ANDROID_SDK_ROOT: 'D:\\old-sdk' });
    assert.match(msg, /ANDROID_SDK_ROOT/);
    assert.match(msg, /old-sdk/);
  });
});

describe('jdkMajor', () => {
  const dirs = [];
  const make = (release) => {
    const dir = fakeJdk(release);
    dirs.push(dir);
    return dir;
  };

  test.after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test('reads the major version out of JAVA_VERSION', () => {
    assert.equal(jdkMajor(make('JAVA_VERSION="21.0.13"\nJAVA_VERSION_DATE="2025-10-21"\n')), 21);
    assert.equal(jdkMajor(make('JAVA_VERSION="17.0.13"\n')), 17);
    // Pre-9 releases spell it 1.8.0_202; the major is the leading 1, which is below the floor either way.
    assert.equal(jdkMajor(make('JAVA_VERSION="1.8.0_202"\n')), 1);
  });

  test('is 0 when there is nothing to read', () => {
    assert.equal(jdkMajor(make(null)), 0);
    assert.equal(jdkMajor(path.join(tmpdir(), 'sp-preflight-does-not-exist')), 0);
  });
});

describe('jdkProblem', () => {
  test('names JAVA_HOME when it is unset', () => {
    assert.match(jdkProblem(''), /JAVA_HOME/);
    assert.match(jdkProblem(undefined), /JAVA_HOME/);
  });

  test('refuses a JDK below 21 and quotes the javac error it would otherwise hit', () => {
    const dir = fakeJdk('JAVA_VERSION="17.0.13"\n');
    try {
      const msg = jdkProblem(dir);
      assert.match(msg, /JDK 17/);
      assert.match(msg, /21/);
      assert.match(msg, /无效源发行版/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts 21+ and stays quiet when the version is unreadable', () => {
    const dir = fakeJdk('JAVA_VERSION="21.0.13"\n');
    try {
      assert.equal(jdkProblem(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // No `release` file: Gradle's own error is more specific than anything we could say here.
    const unknown = fakeJdk(null);
    try {
      assert.equal(jdkProblem(unknown), null);
    } finally {
      rmSync(unknown, { recursive: true, force: true });
    }
  });
});
