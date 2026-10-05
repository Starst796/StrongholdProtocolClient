// Payload-root specifier loader for the tests: the payload's modules import each other with root-absolute paths
// ("/server/net.js"), which a browser resolves against the page origin and Node does not resolve at all. Register it
// with `module.register()` before importing a payload module (see test/host-mobile.test.js), pointing
// SP_PAYLOAD_ROOT at an assembled payload directory.
//
// Relative specifiers are clamped above the payload root, like a browser does ("../../shared/x.js" from /sim/y.js
// means /shared/x.js there; on the file system it would walk out of the payload).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.SP_PAYLOAD_ROOT;

function clamped(url) {
  const rel = path.relative(ROOT, fileURLToPath(url));
  if (!rel.startsWith('..')) return url;
  const parts = rel.split(path.sep).filter((p) => p && p !== '..');
  return pathToFileURL(path.join(ROOT, ...parts)).href;
}

export async function resolve(specifier, context, next) {
  if (ROOT && specifier.startsWith('/')) {
    return { url: pathToFileURL(path.join(ROOT, specifier)).href, shortCircuit: true };
  }
  if (ROOT && (specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    return { url: clamped(new URL(specifier, context.parentURL).href), shortCircuit: true };
  }
  return next(specifier, context);
}
