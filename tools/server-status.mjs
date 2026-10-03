// Server status: how busy is a game server right now — and when it is quiet enough to restart it.
//
//   node tools/server-status.mjs                                  一次采样：game.starst.site 现在多少人
//   node tools/server-status.mjs --server 192.168.1.9:3000        别的服务器
//   node tools/server-status.mjs --watch                          每 60 秒采样，滚动显示 + 定时汇总（找空窗）
//   node tools/server-status.mjs --watch --under 40               一直等到 humans ≤ 40 就打印提示并退出 0
//   node tools/server-status.mjs --watch --samples 20 --interval 30   采 20 次（10 分钟）后退出
//   node tools/server-status.mjs --json                           每个采样点输出原始 JSON（喂给别的脚本）
//
// Server `/healthz` (public, no auth) reports:
//   version/app   the wire protocol + release the server runs
//   uptimeSec     since the process started (a restart resets it) — good for confirming a deploy took effect
//   sockets       open WebSockets; sessions = sessions in the registry, which also counts sockets that dropped
//                 within the 10-minute reconnect window, so sessions ≥ sockets normally
//   rooms         rooms in the lobby; matches = rooms with a running battle
//   humans/bots   occupied seats by kind — `humans` is the number to watch for "is anyone playing"
//
// A restart drops every connection and every match (all state is in memory, see docs/PACKAGING.md §10), so the
// interesting question is `humans` (and `matches`), not `sockets`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(CLIENT_ROOT, 'client.config.json');

/** `game.starst.site`, `host:port`, `https://host`, `ws://host/ws` → an /healthz URL. */
export function statusUrl(server) {
  let s = String(server ?? '').trim();
  if (!s) throw new Error('没有服务器地址（--server <addr>）');
  s = s.replace(/^(wss?|https?):\/\//i, (m) => (m.toLowerCase() === 'ws://' ? 'http://' : m.toLowerCase() === 'wss://' ? 'https://' : m.toLowerCase()));
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  u.pathname = `${u.pathname.replace(/\/+$/, '').replace(/\/ws$/, '')}/healthz`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/**
 * Normalise a /healthz body. `ok` means "this really is a Stronghold Protocol /healthz" (the server always sends
 * `ok: true`), so a 200 from something else (a proxy page, another app on the port) is not mistaken for a quiet
 * server. The counters are read defensively: an older or proxied server may not send all of them.
 * @param {any} body
 * @returns {{ ok: boolean, humans: number, bots: number, matches: number, rooms: number, sockets: number, sessions: number, uptimeSec: number|null, app: string|null, version: number|null }}
 */
export function summarize(body) {
  const j = body && typeof body === 'object' ? body : {};
  const n = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    ok: j.ok === true,
    humans: n(j.humans),
    bots: n(j.bots),
    matches: n(j.matches),
    rooms: n(j.rooms),
    sockets: n(j.sockets),
    sessions: n(j.sessions),
    uptimeSec: Number.isFinite(Number(j.uptimeSec)) ? Number(j.uptimeSec) : null,
    app: typeof j.app === 'string' ? j.app : null,
    version: Number.isFinite(Number(j.version)) ? Number(j.version) : null,
  };
}

/** `3h 02m` / `41s` for uptimeSec. */
export function formatUptime(sec) {
  if (!Number.isFinite(sec)) return '?';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

const clock = (d = new Date()) => d.toTimeString().slice(0, 8);

/** One timeline row. */
export function formatSample(sample) {
  const s = sample.status;
  if (!s) return `${clock(sample.at)}  ${sample.error || '取样失败'}`;
  const warn = s.ok ? '' : '  ← 不是本游戏的 /healthz';
  return `${clock(sample.at)}  humans ${String(s.humans).padStart(4)}  matches ${String(s.matches).padStart(3)}  rooms ${String(s.rooms).padStart(3)}  sockets ${String(s.sockets).padStart(4)}  sessions ${String(s.sessions).padStart(4)}  up ${formatUptime(s.uptimeSec)}${warn}`;
}

/** The quietest sample of a run (fewest humans; ties → fewest matches). */
export function quietest(samples) {
  const ok = samples.filter((s) => s.status);
  if (!ok.length) return null;
  return ok.reduce((a, b) => (b.status.humans < a.status.humans || (b.status.humans === a.status.humans && b.status.matches < a.status.matches) ? b : a));
}

/** Rolling summary of a run: sample count, min/avg/max humans and when the minimum happened. */
export function summarizeRun(samples) {
  const ok = samples.filter((s) => s.status);
  if (!ok.length) return null;
  const humans = ok.map((s) => s.status.humans);
  const best = quietest(ok);
  return {
    samples: samples.length,
    reachable: ok.length,
    min: Math.min(...humans),
    max: Math.max(...humans),
    avg: Math.round((humans.reduce((a, b) => a + b, 0) / humans.length) * 10) / 10,
    quietestAt: best.at,
    quietestMatches: best.status.matches,
  };
}

function parseArgs(argv) {
  const o = { server: null, interval: 60, watch: false, under: null, samples: null, json: false, timeout: 8000, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const val = () => (eq === -1 ? argv[++i] : a.slice(eq + 1));
    if (key === '--server') o.server = val();
    else if (key === '--interval') o.interval = Math.max(1, Number(val()) || 60);
    else if (key === '--watch') o.watch = true;
    else if (key === '--under') { o.under = Number(val()); o.watch = true; }
    else if (key === '--samples') { o.samples = Math.max(1, Number(val()) || 1); o.watch = true; }
    else if (key === '--json') o.json = true;
    else if (key === '--timeout') o.timeout = Math.max(500, Number(val()) || 8000);
    else if (key === '-h' || key === '--help') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

function configServer() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).defaultServer || null;
  } catch {
    return null;
  }
}

const USAGE = `usage: node tools/server-status.mjs [--server <addr>] [--watch] [--interval <sec>] [--samples <n>] [--under <n>] [--json] [--timeout <ms>]`;

async function sample(url, timeoutMs) {
  const at = new Date();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) return { at, error: `HTTP ${res.status}` };
    return { at, status: summarize(await res.json()) };
  } catch (e) {
    return { at, error: e?.name === 'AbortError' ? `超时 (${timeoutMs} ms)` : String(e?.message || e) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); return; }
  const server = o.server || configServer();
  const url = statusUrl(server);
  const samples = [];
  let done = false;

  console.log(`> ${url}${o.watch ? `  每 ${o.interval} 秒采样${o.samples ? `，共 ${o.samples} 次` : ''}${o.under != null ? `，humans ≤ ${o.under} 时提示` : ''}` : ''}`);
  while (!done) {
    const s = await sample(url, o.timeout);
    samples.push(s);
    if (o.json) console.log(JSON.stringify({ at: s.at.toISOString(), server, ...(s.status || { ok: false }), error: s.error || null }));
    else console.log(formatSample(s));

    if (!s.status) console.log('  （取不到 /healthz：地址写错、服务器没起、或网络上不去）');
    else if (!s.status.ok) console.log('  （响应不是本游戏的 /healthz —— 端口上可能是别的东西）');
    else if (o.under != null && s.status.humans <= o.under) {
      const run = summarizeRun(samples);
      console.log(`\n>>> 现在可以动手了：humans ${s.status.humans} ≤ ${o.under}（matches ${s.status.matches}，uptime ${formatUptime(s.status.uptimeSec)}）`);
      if (run) console.log(`>>> 本次观察 ${run.samples} 次：humans ${run.min}–${run.max}（均值 ${run.avg}），最空出现在 ${clock(run.quietestAt)}`);
      console.log('>>> 重启会清掉所有房间与对局（见 docs/PACKAGING.md §10），建议随后确认 uptimeSec 归零。');
      process.exitCode = 0;
      break;
    }

    const run = summarizeRun(samples);
    if (run && run.samples > 1 && run.samples % 10 === 0) {
      console.log(`--- 已观察 ${run.samples} 次：humans ${run.min}–${run.max}（均值 ${run.avg}），最空 ${clock(run.quietestAt)}（matches ${run.quietestMatches}）`);
    }
    if (o.samples && samples.length >= o.samples) break;
    if (!o.watch) break;
    await sleep(o.interval * 1000);
  }

  const run = summarizeRun(samples);
  if (o.watch && run && !o.json) {
    console.log(`\n观察 ${run.samples} 次（成功 ${run.reachable}）：humans ${run.min}–${run.max}（均值 ${run.avg}）；最空的时刻 ${clock(run.quietestAt)}（humans ${run.min}、matches ${run.quietestMatches}）`);
  }
  if (o.under != null && process.exitCode === undefined) process.exitCode = 1; // never got under the threshold
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`server-status: ${e?.message || e}`);
    console.error(USAGE);
    process.exitCode = 1;
  });
}
