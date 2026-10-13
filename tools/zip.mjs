// Compressing a directory into a zip, with whatever archiver the machine has.
//
// Lifted out of tools/package-release.mjs so the incremental pack (tools/payload-delta.mjs) can use the same code
// path: the delta pack is a zip an Android WebView-side updater unpacks with java.util.zip, so it has to be a plain
// deflate zip — which is exactly what these tools write.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function run(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 退出码 ${r.status}`);
  return r;
}

/**
 * Zip the *contents* of `dir` into `zipPath` — the archive holds `dir`'s own name as its root, as the release zips do.
 *
 * On Windows `tar` is bsdtar and writes a zip when the target ends in `.zip` (`-a`); elsewhere `zip` / `7z` / bsdtar
 * are tried in that order. No Node dependency, and no 500 MB in memory.
 *
 * @param {string} dir the directory to archive (its parent becomes the archive root)
 * @param {string} zipPath
 * @returns {string} zipPath
 */
export function zipDir(dir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  const tarArgs = ['-a', '-c', '-f', zipPath, '-C', path.dirname(dir), path.basename(dir)];
  if (process.platform === 'win32' || process.env.SP_ZIP === 'tar') {
    run('tar', tarArgs);
    return zipPath;
  }
  for (const tool of ['zip', '7z', 'tar']) {
    const probe = spawnSync(tool, ['--help'], { encoding: 'utf8' });
    if (probe.error) continue;
    if (tool === 'zip') run('zip', ['-q', '-r', zipPath, path.basename(dir)], { cwd: path.dirname(dir) });
    else if (tool === '7z') run('7z', ['a', '-mx=9', zipPath, path.basename(dir)], { cwd: path.dirname(dir) });
    else run('tar', tarArgs);
    return zipPath;
  }
  throw new Error('找不到压缩工具（zip / 7z / tar）—— 用 --no-zip 跳过，或装一个');
}
