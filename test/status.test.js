// Rules of tools/server-status.mjs (the "how busy is the server / when is it quiet" tool). Only the pure parts are
// tested here — the sampling itself is a fetch against a live server, which a unit test must not depend on.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { statusUrl, summarize, formatUptime, formatSample, quietest, summarizeRun } from '../tools/server-status.mjs';

describe('server status', () => {
  test('any server spelling becomes an /healthz URL', () => {
    assert.equal(statusUrl('game.starst.site'), 'https://game.starst.site/healthz');
    assert.equal(statusUrl('192.168.1.9:3000'), 'https://192.168.1.9:3000/healthz');
    assert.equal(statusUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/healthz');
    assert.equal(statusUrl('https://game.starst.site'), 'https://game.starst.site/healthz');
    assert.equal(statusUrl('wss://game.starst.site/ws'), 'https://game.starst.site/healthz');
    assert.equal(statusUrl('http://127.0.0.1:3000/game/'), 'http://127.0.0.1:3000/game/healthz');
    assert.throws(() => statusUrl(''), /没有服务器地址/);
  });

  test('a /healthz body is read defensively', () => {
    const full = summarize({ ok: true, version: 1, app: '0.1.0', uptimeSec: 18139, sockets: 292, sessions: 462, rooms: 279, matches: 249, humans: 374, bots: 117 });
    assert.deepEqual(full, { ok: true, humans: 374, bots: 117, matches: 249, rooms: 279, sockets: 292, sessions: 462, uptimeSec: 18139, app: '0.1.0', version: 1 });
    // a proxy page / another app / nothing at all must not look like a quiet game server
    assert.equal(summarize(null).ok, false);
    assert.equal(summarize('nope').ok, false);
    assert.equal(summarize({}).ok, false);
    assert.equal(summarize({ ok: false }).ok, false);
    assert.equal(summarize({ humans: '12', matches: '3' }).humans, 12, 'a stringly-typed counter still counts');
    const bare = summarize({ ok: true });
    assert.equal(bare.humans, 0);
    assert.equal(bare.uptimeSec, null);
  });

  test('uptime is humanised', () => {
    assert.equal(formatUptime(41), '41s');
    assert.equal(formatUptime(18139), '5h02m');
    assert.equal(formatUptime(null), '?');
  });

  test('a sample line carries the numbers that matter for a restart window', () => {
    const at = new Date('2026-10-03T11:26:47Z');
    const line = formatSample({ at, status: summarize({ ok: true, humans: 3, matches: 1, rooms: 2, sockets: 5, sessions: 6, uptimeSec: 90 }) });
    assert.match(line, /humans\s+3/);
    assert.match(line, /matches\s+1/);
    assert.match(line, /up 1m30s/);
    assert.match(formatSample({ at, error: 'HTTP 502' }), /HTTP 502/);
    assert.match(formatSample({ at, status: summarize({}) }), /不是本游戏的 \/healthz/);
  });

  test('the quietest sample is the fewest humans (then fewest matches), failures ignored', () => {
    const s = (humans, matches, min) => ({ at: new Date(2026, 9, 3, 3, min), status: summarize({ ok: true, humans, matches }) });
    const samples = [s(90, 60, 0), { at: new Date(), error: 'boom' }, s(12, 9, 10), s(12, 4, 20), s(40, 30, 30)];
    const best = quietest(samples);
    assert.equal(best.status.humans, 12);
    assert.equal(best.status.matches, 4, 'a tie on humans prefers the quietest matches');
    assert.equal(quietest([{ at: new Date(), error: 'x' }]), null);
  });

  test('a run summary reports the window, not just the last sample', () => {
    const s = (humans, matches, min) => ({ at: new Date(2026, 9, 3, 4, min), status: summarize({ ok: true, humans, matches }) });
    const run = summarizeRun([s(80, 50, 0), s(11, 7, 5), s(120, 80, 10)]);
    assert.equal(run.samples, 3);
    assert.equal(run.reachable, 3);
    assert.equal(run.min, 11);
    assert.equal(run.max, 120);
    assert.equal(run.avg, 70.3);
    assert.equal(run.quietestAt.getMinutes(), 5);
    assert.equal(run.quietestMatches, 7);
  });
});
