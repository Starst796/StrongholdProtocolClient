// Rules of the shell server picker (shell/picker.js). The DOM half needs a browser (verified by loading the
// payload), so what is pinned here is the part that decides *when* a player is asked and *what* counts as a server
// address — the two places where a wrong answer is silent: a picker that never appears looks like a broken client.
//
// Dependency-free on purpose: no DOM stub, no jsdom, `node --test` straight from a fresh clone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_SERVERS, K_AUTOSTART, K_CHOSEN, K_LIST, K_SERVER, NAME_MAX,
  addressError, ambiguousScheme, autostartOn, cleanName, customFrom, isAndroidUA, serverName, shouldShowPicker,
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
    for (const k of [K_SERVER, K_AUTOSTART, K_LIST, K_CHOSEN]) assert.match(k, /^sp\.shell\./);
  });
});
