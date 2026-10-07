// Publishes a built release to GitHub Releases: creates the tag, uploads the artifacts and the update feed.
//
//   node tools/publish-release.mjs [--tag <tag>] [--dist <dir>] [--repo <owner/name>] [--token <token>] [--dry-run]
//
//   --tag <tag>       release to create (default: the tag in build/dist/latest.json)
//   --dist <dir>      where package-release.mjs left the artifacts (default: build/dist)
//   --repo <o/n>      target repository (default: client.config.json update.repo)
//   --token <t>       GitHub token (default: GITHUB_TOKEN / GH_TOKEN)
//   --dry-run         print what would be uploaded, touch nothing
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

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

export function parsePublishArgs(argv) {
  const o = { tag: undefined, dist: undefined, repo: undefined, token: undefined, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const val = () => (eq === -1 ? argv[++i] : a.slice(eq + 1));
    if (key === '--tag') o.tag = val();
    else if (key === '--dist') o.dist = val();
    else if (key === '--repo') o.repo = val();
    else if (key === '--token') o.token = val();
    else if (key === '--dry-run') o.dryRun = true;
    else if (key === '-h' || key === '--help') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/**
 * One curl call, returning the status code and the body separately. Args are passed to the process directly (no
 * shell), so paths with spaces and JSON bodies need no quoting.
 */
function curl(url, { token, method = 'GET', json, file } = {}) {
  const args = ['-sS', '--max-time', file ? '1800' : '60', '-X', method, '-w', '\n%{http_code}'];
  if (token) args.push('-H', `Authorization: Bearer ${token}`);
  args.push('-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28');
  if (json !== undefined) args.push('-H', 'Content-Type: application/json', '--data-binary', json);
  if (file !== undefined) args.push('-H', 'Content-Type: application/octet-stream', '--data-binary', `@${file}`);
  args.push(url);
  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.error) throw r.error;
  const out = String(r.stdout ?? '');
  const cut = out.lastIndexOf('\n');
  const body = cut === -1 ? '' : out.slice(0, cut);
  const status = Number(out.slice(cut + 1));
  return { status, body, stderr: r.stderr ?? '' };
}

/** Parse a JSON body, with the status and body in the error when it is not JSON (a proxy page, an HTML error). */
function asJson({ status, body }) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`GitHub 返回了非 JSON 响应（HTTP ${status}）：${body.slice(0, 200)}`);
  }
}

/** `{ ok, json }` plus the message GitHub sent when it says no. */
function expect(status, body, allowed) {
  const json = asJson({ status, body });
  if (allowed.includes(status)) return json;
  throw new Error(`GitHub 返回 HTTP ${status}：${json?.message || body.slice(0, 200)}`);
}

/** One call that must succeed (any other status becomes an error naming what GitHub said). */
function call(url, options, allowed) {
  const res = curl(url, options);
  return expect(res.status, res.body, allowed);
}

export function publish(o = {}) {
  const log = o.quiet ? () => {} : console.log;
  const config = loadConfig();
  const dist = path.resolve(o.dist ?? path.join(CLIENT_ROOT, 'build', 'dist'));
  const repo = String(o.repo ?? config.update?.repo ?? '').trim();
  const token = String(o.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim();

  const feedFile = path.join(dist, 'latest.json');
  if (!fs.existsSync(feedFile)) throw new Error(`没有找到 ${path.relative(CLIENT_ROOT, feedFile)} —— 先跑 node tools/package-release.mjs`);
  const feed = JSON.parse(fs.readFileSync(feedFile, 'utf8'));
  const tag = String(o.tag ?? feed.tag ?? '').trim();
  if (!repo) throw new Error('没有目标仓库 —— 在 client.config.json 里配 update.repo，或用 --repo owner/name');
  if (!tag) throw new Error('latest.json 里没有 tag —— 重新跑一次 package-release.mjs，或用 --tag 指定');

  // Everything the feed points at must be uploaded next to it, or the client would download a 404.
  const uploads = [{ name: 'latest.json', file: feedFile }];
  for (const platform of ['win', 'android']) {
    const asset = feed[platform];
    if (!asset?.name) continue;
    const file = path.join(dist, asset.name);
    if (!fs.existsSync(file)) {
      log(`publish-release: 跳过 ${platform} —— ${asset.name} 不在 ${path.relative(CLIENT_ROOT, dist)}`);
      continue;
    }
    const size = fs.statSync(file).size;
    if (size !== asset.size) throw new Error(`${asset.name} 与 latest.json 不一致（${size} ≠ ${asset.size}）—— 重新打包再发`);
    uploads.push({ name: asset.name, file });
  }
  if (uploads.length < 2) throw new Error('latest.json 没有任何可下载的产物（win / android 都缺）—— 检查打包结果');

  log(`publish-release: ${repo} ← tag ${tag}`);
  for (const u of uploads) log(`  ${u.name}  ${(fs.statSync(u.file).size / 1048576).toFixed(1)} MB`);
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
    : expect(created.status, created.body, [201]);
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
    const asset = call(url, { token, method: 'POST', file: u.file }, [201]);
    log(`publish-release: 已上传 ${asset.name}（${(asset.size / 1048576).toFixed(1)} MB）`);
  }

  const feedUrl = `https://github.com/${repo}/releases/latest/download/latest.json`;
  log(`\npublish-release: 完成 —— ${release.html_url}`);
  log(`  客户端轮询：${feedUrl}`);
  log('  确认一下（应看到刚上传的 build 号）：');
  log(`    curl -sSL ${feedUrl}`);
  return { repo, tag, release: release.html_url, feedUrl, uploads: uploads.map((u) => u.name) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parsePublishArgs(process.argv.slice(2));
  if (o.help) {
    console.log('usage: node tools/publish-release.mjs [--tag <tag>] [--dist <dir>] [--repo <owner/name>] [--token <t>] [--dry-run]');
  } else {
    publish(o);
  }
}
