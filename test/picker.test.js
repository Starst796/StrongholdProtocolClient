// Rules of the shell server picker (shell/picker.js). The DOM half needs a browser (verified by loading the
// payload), so what is pinned here is the part that decides *when* a player is asked and *what* counts as a server
// address — the two places where a wrong answer is silent: a picker that never appears looks like a broken client.
//
// Dependency-free on purpose: no DOM stub, no jsdom, `node --test` straight from a fresh clone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_SERVERS, CLIENT_PAGE_PORT, HOST_PORT_DEFAULT, K_AUTOSTART, K_CHOSEN, K_HOST_PORT, K_LIST, K_SERVER, NAME_MAX, PROBE_HELLO,
  addressError, ambiguousScheme, autostartOn, cleanName, customFrom, hostPortError, hostPortValue, isAndroidUA,
  parseProbeReply, serverName, shouldShowPicker, versionLabel, versionMismatchHint, versionVerdict,
} from '../shell/picker-core.js';

describe('when the picker is shown', () => {
  test('first launch (nothing remembered) always asks', () => {
    assert.equal(shouldShowPicker({ forced: false, chosenThisSession: false, savedAddress: null, autostart: true }), true);
    assert.equal(shouldShowPicker({ forced: false, chosenThisSession: false, savedAddress: null, autostart: false }), true);
  });

  test('desktop remembers and does not ask again', () => {
    assert.equal(shouldShowPicker({ forced: false, chosenThisSession: false, savedAddress: 'localhost:3000', autostart: true }), false);
  });

  test('Android (autostart off) always asks — it is the only way to switch servers there', () => {
    assert.equal(shouldShowPicker({ forced: false, chosenThisSession: false, savedAddress: 'localhost:3000', autostart: false }), true);
  });

  test('--choose-server / F2 forces it, even with something remembered', () => {
    assert.equal(shouldShowPicker({ forced: true, chosenThisSession: false, savedAddress: 'localhost:3000', autostart: true }), true);
  });

  test('a choice in this session wins: the reload after picking must not ask again (no loop)', () => {
    const base = { forced: false, savedAddress: 'localhost:3000' };
    assert.equal(shouldShowPicker({ ...base, chosenThisSession: true, autostart: true }), false);
    assert.equal(shouldShowPicker({ ...base, chosenThisSession: true, autostart: false }), false);
    // ...including a forced launch: --choose-server asks once per launch, not once per reload
    assert.equal(shouldShowPicker({ forced: true, chosenThisSession: true, savedAddress: 'localhost:3000', autostart: false }), false);
  });

  test('autostart defaults: on for desktop, off for Android, explicit value wins', () => {
    assert.equal(autostartOn(null, false), true, 'desktop default: remember and go straight in');
    assert.equal(autostartOn(undefined, true), false, 'Android default: always ask');
    assert.equal(autostartOn('0', false), false);
    assert.equal(autostartOn('1', true), true);
  });

  test('Android is detected from the WebView user agent', () => {
    assert.equal(isAndroidUA('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36'), true);
    assert.equal(isAndroidUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/44.5.1'), false);
    assert.equal(isAndroidUA(undefined), false);
  });
});

describe('server addresses', () => {
  test('accepts the shapes a player can type', () => {
    for (const ok of ['game.starst.site', '192.168.1.9:3000', 'localhost:3000', 'https://example.com', 'ws://10.0.0.5:8080/game/ws', 'http://[::1]:3000']) {
      assert.equal(addressError(ok), null, `${ok} should be accepted`);
    }
  });

  test('rejects what is not an address, with a reason', () => {
    assert.match(addressError(''), /请输入/);
    assert.match(addressError('   '), /请输入/);
    assert.match(addressError('game server'), /空格/);
    assert.equal(addressError('http://x.io/'), null, 'a trailing slash is normalised by toWsUrl, not rejected');
    assert.match(addressError('!!!'), /无法识别/);
    assert.match(addressError('game..starst'), /主机名/);
    assert.match(addressError('.starst.site'), /主机名/);
    assert.match(addressError(':3000'), /主机名/);
  });

  test('the only built-in entry is the local server the player runs themselves', () => {
    assert.deepEqual(BUILTIN_SERVERS.map((s) => s.address), ['localhost:3000']);
    assert.equal(BUILTIN_SERVERS[0].label, '本机 / 局域网');
  });

  test('the stored custom list is JSON ({name, address}) and survives garbage', () => {
    assert.deepEqual(customFrom('[{"name":"家","address":"a:1"},{"name":"","address":"b:2"}]'), [
      { name: '家', address: 'a:1' }, { name: '', address: 'b:2' },
    ]);
    assert.deepEqual(customFrom('["a:1","b:2"]'), [
      { name: '', address: 'a:1' }, { name: '', address: 'b:2' },
    ], 'the pre-name (array of strings) shape still loads');
    assert.deepEqual(customFrom(''), []);
    assert.deepEqual(customFrom(null), []);
    assert.deepEqual(customFrom('not json'), []);
    assert.deepEqual(customFrom('{"a":1}'), [], 'not an array');
    assert.deepEqual(customFrom('["ok", 7, null, " ", {"address":"c:3"}, {"name":"x"}]'), [
      { name: '', address: 'ok' }, { name: '', address: 'c:3' },
    ], 'only usable entries survive');
  });

  test('a saved server shows its name, falling back to the address when the name is blank', () => {
    assert.equal(serverName({ name: '家', address: 'a:1' }), '家');
    assert.equal(serverName({ name: '   ', address: 'a:1' }), 'a:1');
    assert.equal(serverName({ address: 'a:1' }), 'a:1');
    assert.equal(serverName(null), '');
  });

  test('the typed name is trimmed and capped to NAME_MAX', () => {
    assert.equal(cleanName('  我的服务器  '), '我的服务器');
    assert.equal(cleanName(undefined), '');
    assert.equal(cleanName('x'.repeat(NAME_MAX + 10)).length, NAME_MAX);
  });

  test('a scheme-less host:port is the ambiguous case the picker probes both ways', () => {
    for (const both of ['192.168.1.9:3000', '1.2.3.4:3000', 'example.com:8443', '[::1]:3000', 'localhost:3000', 'host:3000/path']) {
      assert.equal(ambiguousScheme(both), true, `${both} should try ws:// and wss://`);
    }
    for (const one of ['http://example.com:8443', 'wss://x.io', 'ws://x.io:3000', 'https://x.io', 'example.com', 'localhost', '', '   ']) {
      assert.equal(ambiguousScheme(one), false, `${one} needs no second attempt`);
    }
  });

  test('storage keys are namespaced under sp.shell.* so they never collide with the game"s own keys', () => {
    for (const k of [K_SERVER, K_AUTOSTART, K_LIST, K_CHOSEN, K_HOST_PORT]) assert.match(k, /^sp\.shell\./);
  });
});

describe('the 创建服务器 port', () => {
  test('an empty field means 自动, and that is what the shell is asked for', () => {
    assert.equal(hostPortError(''), null);
    assert.equal(hostPortError('   '), null);
    assert.equal(hostPortError(null), null);
    assert.equal(hostPortValue(''), 0, '0 tells the shell "let the OS pick"');
    assert.equal(hostPortValue(null), 0);
  });

  test('the default is the port both shells host on', () => {
    assert.equal(HOST_PORT_DEFAULT, 47822);
    assert.equal(hostPortError(String(HOST_PORT_DEFAULT)), null);
    assert.equal(hostPortValue(String(HOST_PORT_DEFAULT)), HOST_PORT_DEFAULT);
    // the desktop client's own page server: picking it would collide with the client itself
    assert.equal(CLIENT_PAGE_PORT, 47821);
  });

  test('a typed port is accepted exactly as typed', () => {
    for (const p of ['1', '80', '25565', '47822', '65535']) {
      assert.equal(hostPortError(p), null, `${p} is valid`);
      assert.equal(hostPortValue(p), Number(p));
    }
    // a remembered value with stray whitespace still works (the field is free text)
    assert.equal(hostPortValue(' 25565 '), 25565);
  });

  test('what is not a port is refused with a reason, and never reaches the shell', () => {
    for (const bad of ['abc', '12a', '65536', '0', '-1', '1.5', '999999']) {
      assert.ok(hostPortError(bad), `${bad} must be refused`);
      assert.equal(hostPortValue(bad), 0, `${bad} falls back to 自动 rather than a bogus bind`);
    }
    assert.match(hostPortError('65536'), /1–65535/);
    assert.match(hostPortError('abc'), /数字/);
    // the client's own page port gets its own explanation (otherwise a player just sees "in use")
    assert.match(hostPortError(String(CLIENT_PAGE_PORT)), /客户端自己/);
  });
});

describe('wire-version probe', () => {
  test('the probe is a version-0 hello: every real server takes the mismatch branch before it makes a session', () => {
    assert.deepEqual({ ...PROBE_HELLO }, { t: 'hello', name: 'sp-probe', version: 0 });
  });

  test('reads the server number out of the mismatch error the branch answers with', () => {
    assert.equal(parseProbeReply({ t: 'error', code: 'BAD_MSG', detail: 'version mismatch: server 1' }), 1);
    assert.equal(parseProbeReply({ t: 'error', code: 'BAD_MSG', detail: 'version mismatch: server 12' }), 12);
  });

  test('reads it from a welcome too, and yields null when the frame carries none', () => {
    assert.equal(parseProbeReply({ t: 'welcome', version: 0 }), 0);
    assert.equal(parseProbeReply({ t: 'error', code: 'BAD_MSG', detail: 'bad field name' }), null);
    assert.equal(parseProbeReply({ t: 'welcome' }), null);
    assert.equal(parseProbeReply(null), null);
    assert.equal(parseProbeReply('nope'), null);
  });

  test('the verdict gates on the wire number only — a differing release version is irrelevant', () => {
    assert.equal(versionVerdict(1, 1), 'ok');
    assert.equal(versionVerdict(1, 2), 'mismatch');
    assert.equal(versionVerdict(1, null), 'unknown');
    assert.equal(versionVerdict(1, undefined), 'unknown');
  });

  test('the row label flags a server this client cannot enter', () => {
    assert.equal(versionLabel(1, 1), '协议 v1');
    assert.equal(versionLabel(1, 2), '协议 v2 · 需 v1');
    assert.equal(versionLabel(1, null), null, 'nothing probed: no label rather than a wrong one');
  });

  test('the refusal hint names both numbers so the player knows which side to update', () => {
    const h = versionMismatchHint(1, 2);
    assert.match(h, /v2/);
    assert.match(h, /v1/);
  });
});
