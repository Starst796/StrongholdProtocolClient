// Publishes a built release to GitHub Releases: creates the tag, uploads the artifacts and the update feed.
//
//   node tools/publish-release.mjs [--tag <tag>] [--dist <dir>] [--repo <owner/name>] [--token <token>] [--dry-run]
//
//   --tag <tag>       release to create (default: the tag in build/dist/latest.json)
//   --dist <dir>      where package-release.mjs left the artifacts (default: build/dist)
//   --repo <o/n>      target repository (default: client.config.json update.repo)
//   --token <t>       GitHub token (default: GITHUB_TOKEN / GH_TOKEN)
//   --dry-run         print what would be uploaded, touch nothing
//   --attempts <n>    tries per upload (default 3): the packages are hundreds of MB over a home link
//   --api <url>       API base (default https://api.github.com; for GitHub Enterprise and for tests)
//   --uploads <url>   upload base (default https://uploads.github.com)
//   --proxy <url>     proxy for every request, e.g. http://127.0.0.1:7892 (curl -x; overrides the environment)
//   --check           only probe connectivity and report which route curl took, then exit
//
// Proxies: curl already honours https_proxy / HTTPS_PROXY / all_proxy, but a variable only reaches it if it was set
// in the shell that started node. `--check` and the startup log make that visible instead of a guess. Note that for
// GitHub (all HTTPS) the variable that matters is HTTPS_PROXY — the uppercase HTTP_PROXY alone never applies.
//
// Order matters and is deliberate: the artifacts go up first and latest.json *last*, so clients never see a feed
// pointing at files that are not there yet.
//
// This is the step that makes an update visible: installed clients poll
// https://github.com/<repo>/releases/latest/download/latest.json — the `latest` alias resolves to the most recent
// *published, non-prerelease* release, so every release must be a normal one (not a draft, not a prerelease).
//
// Nothing here builds anything: run `node tools/package-release.mjs` first, then this. It reads the tag, the artifact
// names and their sha256 out of build/dist/latest.json, so the uploaded files and the feed always agree.
//
// Needs a token with permission to write releases: a classic PAT with `repo`, or a fine-grained one with
// "Contents: read and write". It is read from the environment, never from a file in the repo.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLIENT_ROOT, loadConfig } from './package-client.mjs';

const API_DEFAULT = 'https://api.github.com';
const UPLOADS_DEFAULT = 'https://uploads.github.com';

export function parsePublishArgs(argv) {
  const o = { tag: undefined, dist: undefined, repo: undefined, token: undefined, dryRun: false, attempts: 3, api: undefined, uploads: undefined, proxy: undefined, check: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const val = () => (eq === -1 ? argv[++i] : a.slice(eq + 1));
    if (key === '--tag') o.tag = val();
    else if (key === '--dist') o.dist = val();
    else if (key === '--repo') o.repo = val();
    else if (key === '--token') o.token = val();
    else if (key === '--attempts') o.attempts = Math.max(1, Number(val()) || 3);
    else if (key === '--api') o.api = val();
    else if (key === '--uploads') o.uploads = val();
    else if (key === '--proxy') o.proxy = val();
    else if (key === '--check') o.check = true;
    else if (key === '--dry-run') o.dryRun = true;
    else if (key === '-h' || key === '--help') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/**
 * One curl call, returning the status code, the body and curl's own exit code. Args go to the process directly (no
 * shell), so paths with spaces and JSON bodies need no quoting.
 *
 * Two things here exist because the packages are hundreds of MB:
 *
 *  - `-T <file>` streams the body straight off the disk. `--data-binary @<file>` would first read the whole 483 MB
 *    into memory, and then curl negotiates `Expect: 100-continue` before sending a byte (an extra round trip whose
 *    `HTTP/1.1 100 Continue` shows up as the *last* status if the connection then dies — the `HTTP 100, empty body`
 *    failure this tool used to hit). `-H 'Expect:'` drops that negotiation entirely.
 *  - `--speed-limit/--speed-time` abort a transfer that has stalled (a dead link would otherwise sit there for the
 *    full --max-time), so the retry loop can start over quickly.
 */
function curl(url, { token, method = 'GET', json, file, timeoutMs = 60000, proxy } = {}) {
  const args = curlArgs(url, { token, method, json, file, timeoutMs, proxy });
  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.error) throw r.error;
  const out = String(r.stdout ?? '');
  const cut = out.lastIndexOf('\n');
  const body = cut === -1 ? '' : out.slice(0, cut);
  const status = Number(out.slice(cut + 1));
  return { status, body, stderr: String(r.stderr ?? '').trim(), exit: r.status };
}

/**
 * The curl argument vector. Exported (and therefore testable without a network) because two of these arguments are
 * load-bearing for the 500 MB uploads — see the note above curl().
 *
 * `proxy` is passed as `-x` when the caller asked for one explicitly. Without it curl still honours the usual
 * environment (https_proxy / HTTPS_PROXY / all_proxy); `-x` exists because "is my $env:HTTPS_PROXY reaching curl?"
 * is otherwise invisible — a variable only reaches a process if it was set in that process' shell (see --check).
 */
export function curlArgs(url, { token, method = 'GET', json, file, timeoutMs = 60000, proxy } = {}) {
  const args = [
    '-sS', '--http1.1', '--connect-timeout', '30', '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '--speed-limit', '10240', '--speed-time', '120',
    '-X', method, '-w', '\n%{http_code}',
  ];
  if (proxy) args.push('-x', proxy);
  if (token) args.push('-H', `Authorization: Bearer ${token}`);
  args.push('-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28');
  if (json !== undefined) args.push('-H', 'Content-Type: application/json', '--data-binary', json);
  // `-T` streams the file; `Expect:` (empty) suppresses the 100-continue round trip.
  if (file !== undefined) args.push('-H', 'Expect:', '-H', 'Content-Type: application/octet-stream', '-T', file);
  args.push(url);
  return args;
}

/**
 * Which route did curl actually take? Read out of `curl -v`'s stderr, because that is the only place it says so —
 * and "the proxy software shows no traffic" is otherwise indistinguishable from "the upload went direct".
 *
 * Real lines this parses (curl 8.13 on Windows, both directions):
 *   * Uses proxy env variable https_proxy == 'http://127.0.0.1:7892'
 *   *   Trying 127.0.0.1:7892...
 *   * Establish HTTP proxy tunnel to api.github.com:443
 *   * Connected to api.github.com (140.82.121.6) port 443          ← direct
 */
export function parseCurlRoute(stderr) {
  const text = String(stderr ?? '');
  const env = /Uses proxy env variable ([A-Za-z0-9_]+) == '([^']+)'/.exec(text);
  const tunnel = /Establish HTTP proxy tunnel to ([^\s]+)/.exec(text);
  if (env) return { viaProxy: true, proxy: env[2], source: `环境变量 ${env[1]}`, target: tunnel ? tunnel[1] : null };
  if (tunnel) return { viaProxy: true, proxy: null, source: 'curl -x（命令行）', target: tunnel[1] };
  const direct = /Connected to ([^\s]+) \(([^)]+)\) port (\d+)/.exec(text);
  if (direct) return { viaProxy: false, proxy: null, source: '直连', target: `${direct[1]}:${direct[3]}` };
  return { viaProxy: false, proxy: null, source: '未知', target: null };
}

/** The proxy the environment would hand to curl, for logging (curl itself reads these; we only report them). */
export function envProxy(env = process.env) {
  for (const name of ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    const value = String(env[name] ?? '').trim();
    if (value) return { url: value, name };
  }
  return null;
}

/**
 * Turn one response into its parsed JSON, or into an error naming what GitHub said.
 *
 * A success may legitimately have *no* body: `DELETE /releases/assets/<id>` answers `204 No Content`, and demanding
 * JSON there made re-publishing an existing release fail at the first asset it tried to replace (found by running
 * this tool against a fake API before using it on the real one). An empty body is therefore a success with no value.
 */
export function expectResponse(status, body, allowed) {
  if (!allowed.includes(status)) {
    let detail = String(body ?? '').slice(0, 200);
    try {
      detail = JSON.parse(body)?.message || detail;
    } catch { /* not JSON (a proxy page): the raw text is the best hint */ }
    throw new Error(`GitHub 返回 HTTP ${status}：${detail}`);
  }
  if (!String(body ?? '').trim()) return null;
  return JSON.parse(body);
}

/** One call that must succeed (any other status becomes an error naming what GitHub said). */
function call(url, options, allowed) {
  const res = curl(url, options);
  return expectResponse(res.status, res.body, allowed);
}

/**
 * Upload one file, retrying a transfer that died on the way. Nothing on GitHub can resume a release-asset upload, so
 * a retry starts from zero — which is exactly why the attempt budget exists instead of one long, doomed request.
 * A 4xx is final (a bad token, a name taken): retrying would only repeat it.
 */
function uploadAsset(url, file, { token, attempts, retryWaitMs = 15000, log, proxy }) {
  const mb = (fs.statSync(file).size / 1048576).toFixed(1);
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = curl(url, { token, method: 'POST', file, timeoutMs: 3600000, proxy });
    if (res.status === 201) return expectResponse(res.status, res.body, [201]);
    // 4xx other than the retryable 408/429 is the server saying no: report it now.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      throw new Error(`上传 ${path.basename(file)} 失败：GitHub 返回 HTTP ${res.status} ${res.body.slice(0, 200)}`);
    }
    last = `HTTP ${res.status || '—'}${res.body ? ` ${res.body.slice(0, 120)}` : ''}${res.stderr ? ` (curl: ${res.stderr})` : ''}`;
    if (attempt < attempts) {
      const waitMs = retryWaitMs * attempt;
      log(`publish-release: ${path.basename(file)}（${mb} MB）中断（${last}）—— ${(waitMs / 1000).toFixed(waitMs < 1000 ? 2 : 0)} 秒后重试（第 ${attempt + 1}/${attempts} 次）`);
      // spawnSync is synchronous: the only way to wait here is a sleeping child.
      spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${waitMs})`]);
    }
  }
  throw new Error(`上传 ${path.basename(file)}（${mb} MB）连续 ${attempts} 次失败：${last}\n`
    + '  提示：网络到 GitHub 的上传不稳定时会这样。可重复执行本命令：已存在的附件会被替换，不会重复。');
}

export function publish(o = {}) {
  const log = o.quiet ? () => {} : console.log;
  const config = loadConfig();
  const dist = path.resolve(o.dist ?? path.join(CLIENT_ROOT, 'build', 'dist'));
  const repo = String(o.repo ?? config.update?.repo ?? '').trim();
  const token = String(o.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim();
  const API = String(o.api ?? API_DEFAULT).replace(/\/$/, '');
  const UPLOADS = String(o.uploads ?? UPLOADS_DEFAULT).replace(/\/$/, '');
  const attempts = Math.max(1, Number(o.attempts ?? 3) || 3);
  // Retry pacing: the first wait is this long, the second twice that. Not a CLI flag — tests take it to 0.
  const retryWaitMs = Number.isFinite(Number(o.retryWaitMs)) ? Math.max(0, Number(o.retryWaitMs)) : 15000;
  // `--proxy` wins over the environment: with `-x` there is no doubt about the route (see --check).
  const proxy = String(o.proxy ?? '').trim();
  const env = envProxy();

  const feedFile = path.join(dist, 'latest.json');
  if (!fs.existsSync(feedFile)) throw new Error(`没有找到 ${path.relative(CLIENT_ROOT, feedFile)} —— 先跑 node tools/package-release.mjs`);
  const feed = JSON.parse(fs.readFileSync(feedFile, 'utf8'));
  const tag = String(o.tag ?? feed.tag ?? '').trim();
  if (!repo) throw new Error('没有目标仓库 —— 在 client.config.json 里配 update.repo，或用 --repo owner/name');
  if (!tag) throw new Error('latest.json 里没有 tag —— 重新跑一次 package-release.mjs，或用 --tag 指定');

  // Everything the feed points at must be uploaded next to it, or the client would download a 404.
  // The feed itself is uploaded LAST (see below): until then, `releases/latest` must not offer a download that 404s.
  const uploads = [];
  for (const platform of ['win', 'android']) {
    const asset = feed[platform];
    if (!asset?.name) continue; // the feed has no artifact for this platform (e.g. an Android-only release)
    const file = path.join(dist, asset.name);
    if (!fs.existsSync(file)) {
      // Skipping it would publish a feed advertising a file that was never uploaded — the exact "有新版本 → 404"
      // this tool exists to prevent. A feed and its artifacts are published together or not at all.
      throw new Error(`latest.json 指向 ${asset.name}，但它不在 ${path.relative(CLIENT_ROOT, dist)} 里 —— 重新打包再发`);
    }
    const size = fs.statSync(file).size;
    if (size !== asset.size) throw new Error(`${asset.name} 与 latest.json 不一致（${size} ≠ ${asset.size}）—— 重新打包再发`);
    uploads.push({ name: asset.name, file });
  }
  if (!uploads.length) throw new Error('latest.json 没有任何可下载的产物（win / android 都缺）—— 检查打包结果');
  uploads.push({ name: 'latest.json', file: feedFile });

  log(`publish-release: ${repo} ← tag ${tag}`);
  for (const u of uploads) log(`  ${u.name}  ${(fs.statSync(u.file).size / 1048576).toFixed(1)} MB`);
  log(proxy
    ? `publish-release: 代理 = ${proxy}（--proxy，显式交给 curl -x）`
    : env
      ? `publish-release: 代理 = ${env.url}（环境变量 ${env.name}）`
      : 'publish-release: 代理 = 无 —— 直连 GitHub（慢/被掐断时用 --proxy http://127.0.0.1:7892）');
  if (process.env.NO_PROXY || process.env.no_proxy) {
    log(`publish-release: 注意 NO_PROXY=${process.env.NO_PROXY || process.env.no_proxy} —— 若它包含 github.com，代理会被绕过`);
  }
  if (o.dryRun) {
    log('publish-release: --dry-run —— 没有上传任何东西');
    return { repo, tag, uploads: uploads.map((u) => u.name), dryRun: true };
  }
  if (!token) throw new Error('缺少 GitHub token —— 设 GITHUB_TOKEN / GH_TOKEN，或用 --token（需要 repo 或 Contents 写权限）');

  // Create the release; a 422 means this tag already exists (re-publishing a fixed build), which is fine.
  const notes = String(feed.notes ?? '').trim();
  const body = [
    notes,
    '',
    `客户端构建号 build ${feed.build}（Android versionCode ${feed.versionCode}），上游 ${feed.gameCommit ?? '?'}。`,
    '',
    '客户端内的「有新版本」提示读的是这个 release 的 latest.json；请保持它是正式发布（不是草稿/预发布），',
    '否则 `releases/latest` 不会指向它。',
  ].join('\n').trim();
  const created = curl(`${API}/repos/${repo}/releases`, {
    token,
    method: 'POST',
    json: JSON.stringify({ tag_name: tag, name: `客户端 ${feed.version} (build ${feed.build})`, body, draft: false, prerelease: false }),
  });
  // 422 = this tag already has a release (re-publishing a fixed build): use it and replace its assets below.
  const release = created.status === 422
    ? call(`${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { token }, [200])
    : expectResponse(created.status, created.body, [201]);
  log(`publish-release: release ${release.tag_name}（id ${release.id}）`);

  // Replace assets instead of failing on the name collision (GitHub refuses a duplicate name).
  const existing = call(`${API}/repos/${repo}/releases/${release.id}/assets?per_page=100`, { token }, [200]);
  const byName = new Map((Array.isArray(existing) ? existing : []).map((a) => [a.name, a]));
  for (const u of uploads) {
    const old = byName.get(u.name);
    if (old) {
      call(`${API}/repos/${repo}/releases/assets/${old.id}`, { token, method: 'DELETE' }, [204, 200]);
      log(`publish-release: 已删除同名旧附件 ${u.name}`);
    }
    const url = `${UPLOADS}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(u.name)}`;
    const size = fs.statSync(u.file).size;
    log(`publish-release: 正在上传 ${u.name}（${(size / 1048576).toFixed(1)} MB）…`);
    const asset = uploadAsset(url, u.file, { token, attempts, retryWaitMs, log, proxy });
    if (Number(asset.size) !== size) {
      throw new Error(`${u.name} 上传后大小不符（${asset.size} ≠ ${size}）—— 重新执行本命令`);
    }
    log(`publish-release: 已上传 ${asset.name}（${(asset.size / 1048576).toFixed(1)} MB）`);
  }

  const feedUrl = `https://github.com/${repo}/releases/latest/download/latest.json`;
  log(`\npublish-release: 完成 —— ${release.html_url}`);
  log(`  客户端轮询：${feedUrl}`);
  log('  确认一下（要能看到 win / android 两个 URL，且文件真的能下）：');
  log(`    curl -sSL ${feedUrl}`);
  // A feed whose downloads 404 is worse than no release at all: check the alias really serves what we just pushed.
  // Skipped when --api points somewhere else (a test harness or GitHub Enterprise has no github.com alias).
  if (API === API_DEFAULT) {
    const check = curl(feedUrl, { timeoutMs: 60000 });
    const live = check.status === 200 ? JSON.parse(check.body) : null;
    if (!live || live.build !== feed.build) {
      log(`  注意：${feedUrl} 现在还取不到本次的 feed（HTTP ${check.status}）。GitHub 的 releases/latest 别名有几秒到几十秒的缓存，稍后再试一次即可。`);
    } else {
      log(`  已确认：线上 feed 的 build = ${live.build}（与本次一致）`);
    }
  }
  return { repo, tag, release: release.html_url, feedUrl, uploads: uploads.map((u) => u.name) };
}

/**
 * `--check`: one tiny request through the same curl invocation the uploads use, reporting the route curl took and the
 * status it got. Exists because "the proxy shows no traffic" is otherwise only discoverable after pushing 483 MB.
 */
export function checkConnectivity(o = {}) {
  const config = loadConfig();
  const repo = String(o.repo ?? config.update?.repo ?? '').trim() || 'Starst796/StrongholdProtocolClient';
  const API = String(o.api ?? API_DEFAULT).replace(/\/$/, '');
  const proxy = String(o.proxy ?? '').trim();
  const env = envProxy();
  const url = `${API}/repos/${repo}`;

  console.log(`publish-release: 探测 ${url}`);
  console.log(proxy
    ? `  代理 = ${proxy}（--proxy）`
    : env
      ? `  代理 = ${env.url}（环境变量 ${env.name}）`
      : '  代理 = 无 —— curl 将直连（要用代理：--proxy http://127.0.0.1:7892）');
  if (process.env.NO_PROXY || process.env.no_proxy) console.log(`  NO_PROXY = ${process.env.NO_PROXY || process.env.no_proxy}`);

  // `-v` makes curl name the route it took on stderr; the URL is the last argument curlArgs() builds.
  const args = [...curlArgs(url, { proxy, timeoutMs: 30000, method: 'GET' }).slice(0, -1), '-v', url];
  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.error) throw r.error;
  const out = String(r.stdout ?? '');
  const status = Number(out.slice(out.lastIndexOf('\n') + 1));
  const body = out.slice(0, out.lastIndexOf('\n')).trim();
  const route = parseCurlRoute(r.stderr);

  console.log(`  curl 实际走的是：${route.source}${route.target ? ` → ${route.target}` : ''}`);
  console.log(`  HTTP ${status || '—'}${status === 200 ? '（仓库可见）' : ` ${body.slice(0, 160)}`}`);
  if (!route.viaProxy) {
    console.log('  提示：这次是直连。若你在另一个 PowerShell 窗口设的 $env:HTTPS_PROXY，它不会进到这里；');
    console.log('       把代理交给本工具最省事：node tools/publish-release.mjs --proxy http://127.0.0.1:7892');
  }
  return { status, route, url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parsePublishArgs(process.argv.slice(2));
  if (o.help) {
    console.log('usage: node tools/publish-release.mjs [--tag <tag>] [--dist <dir>] [--repo <owner/name>] [--token <t>]');
    console.log('                                        [--attempts <n>] [--proxy <url>] [--api <url>] [--uploads <url>]');
    console.log('                                        [--check] [--dry-run]');
  } else if (o.check) {
    checkConnectivity(o);
  } else {
    publish(o);
  }
}
