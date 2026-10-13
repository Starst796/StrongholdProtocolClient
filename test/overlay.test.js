// The in-app incremental update: an Android overlay over the APK's read-only payload.
//
// Three layers, each with its own failure mode:
//
//   1. Capacitor's seam. The WebView is served by Capacitor's local server out of assets/public, and the only public
//      way in is a RouteProcessor: it may answer with an absolute filesystem path, which Capacitor then opens with a
//      plain FileInputStream. That is undocumented behaviour of a dependency — so it is pinned here. If a Capacitor
//      upgrade changes it, this file fails the build instead of white-screening every phone that took an update.
//   2. The Android side (OverlayStore / OverlayRouteProcessor / AppUpdatePlugin). Only its source shape can be
//      checked without a device, so the checks below name the exact decisions that must not be lost: verify every
//      file, never activate a partial pack, never let a path escape, only apply to the base the client is running.
//   3. The picker's rules (pure JS), which decide whether the pack is even offered.
//
// What a device still has to confirm (docs/PACKAGING.md §16 has the checklist): the first real update, and a LAN
// guest served from an overlay.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deltaAsset, updateLabel, updatePlan } from '../shell/picker-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main');
const CAPACITOR = path.join(ROOT, 'mobile', 'node_modules', '@capacitor', 'android', 'capacitor', 'src', 'main', 'java', 'com', 'getcapacitor');

const java = (rel) => fs.readFileSync(path.join(ANDROID, rel), 'utf8');
const capacitor = (name) => fs.readFileSync(path.join(CAPACITOR, name), 'utf8');
const hasCapacitor = fs.existsSync(path.join(CAPACITOR, 'WebViewLocalServer.java'));

describe('the Capacitor seam the overlay depends on', { skip: hasCapacitor ? false : 'mobile/node_modules is not installed' }, () => {
  test('a route processor decides, per request, between the assets and a real file', () => {
    const server = capacitor('WebViewLocalServer.java');
    // The per-request path: the processor is consulted, and `asset = false` means "open this file from disk".
    assert.match(server, /ProcessedRoute processedRoute = bridge\.getRouteProcessor\(\)\.process\("", path\)/,
      'the request handler asks the processor (with an empty base path)');
    assert.match(server, /path = processedRoute\.getPath\(\)/, 'and uses the path it answers with');
    assert.match(server, /isAsset = processedRoute\.isAsset\(\)/, 'and the asset flag');
    assert.match(server, /stream = protocolHandler\.openFile\(path\)/, 'a non-asset path is opened as a file');
    // The directory request passes the *asset base path* and does not prefix it itself — the processor has to give
    // the full asset path back for the miss case, or Capacitor would look for "publicpublic/index.html".
    assert.match(server, /process\(this\.basePath, "\/index\.html"\)/);
    assert.match(server, /startPath = processedRoute\.getPath\(\)/);
    // The Capacitor bridge is injected into the html it serves, wherever the bytes came from: an overlaid
    // index.html must still get capacitor.js, or the page would come up without the plugin bridge at all.
    assert.match(server, /if \(jsInjector != null\) \{\s*responseStream = jsInjector\.getInjectedStream\(responseStream\);\s*\}/,
      'the injected bridge script is applied to index.html responses');
    // The file handler resolves absolute paths — the whole reason an overlay outside the APK can be served.
    const handler = capacitor('AndroidProtocolHandler.java');
    assert.match(handler, /public InputStream openFile\(String filePath\)[\s\S]{0,220}new FileInputStream\(localFile\)/,
      'openFile is a plain FileInputStream, so an absolute path works');
  });

  test('a processor can be installed before the first navigation', () => {
    // MainActivity.load() overrides BridgeActivity.load(), which is where the Builder is used to create the bridge —
    // so the builder has to be reachable (protected field), and the setter public.
    assert.match(capacitor('BridgeActivity.java'), /protected final Bridge\.Builder bridgeBuilder/, 'the builder is a protected field');
    assert.match(capacitor('Bridge.java'), /public Builder setRouteProcessor\(RouteProcessor routeProcessor\)/, 'the setter is public');
    assert.match(capacitor('BridgeActivity.java'), /protected void load\(\)[\s\S]{0,200}bridgeBuilder\.[\s\S]{0,200}\.create\(\)/,
      'load() is where the bridge is created');
    // Reloading after an update: public, and a plain loadUrl of the app URL.
    assert.match(capacitor('Bridge.java'), /public void reload\(\)\s*\{\s*webView\.post\(\(\) -> webView\.loadUrl\(appUrl\)\)/);
  });
});

describe('the Android overlay', () => {
  const store = java('java/site/starst/stronghold/update/OverlayStore.java');
  const processor = java('java/site/starst/stronghold/update/OverlayRouteProcessor.java');
  const plugin = java('java/site/starst/stronghold/update/AppUpdatePlugin.java');
  const activity = java('java/site/starst/stronghold/MainActivity.java');
  const host = java('java/site/starst/stronghold/host/HostServerPlugin.java');

  test('it is installed before the payload loads, and only there', () => {
    assert.match(activity, /protected void load\(\)\s*\{\s*bridgeBuilder\.setRouteProcessor\(new OverlayRouteProcessor\(this\)\);\s*super\.load\(\);/,
      'MainActivity.load() installs the processor, then lets Capacitor load the payload');
  });

  test('the processor answers with overlay files and leaves everything else to the assets', () => {
    assert.match(processor, /implements RouteProcessor/);
    assert.match(processor, /route\.setPath\(file\.getAbsolutePath\(\)\);\s*route\.setAsset\(false\)/,
      'a hit is an absolute path served from disk');
    assert.match(processor, /route\.setAsset\(true\)/, 'a miss keeps the asset path');
    assert.match(processor, /assetPath\(basePath, path\)/, 'and gives Capacitor the path shape it expects');
    assert.match(processor, /ensureSafe\(rel\)/, 'nothing from a request may point outside the payload');
  });

  test('the store verifies every file, and never activates a partial pack', () => {
    // Read through the central directory: the packs use data descriptors (bsdtar), which a streaming reader would
    // have to scan for.
    assert.match(store, /new ZipFile\(pack\)/, 'the pack is read through ZipFile');
    assert.match(store, /zip\.getEntry\(PACK_META\)/, 'the pack’s own list is looked up by name');
    assert.match(store, /copyVerified\(in, dest, buffer, expectSize, expectHash, rel\)/, 'every file is hashed as it is written');
    assert.match(store, /MessageDigest\.getInstance\("SHA-256"\)/);
    assert.match(store, /entry\.getSize\(\) != expectSize/, 'a size the central directory already contradicts is refused');
    assert.match(store, /done != total[\s\S]{0,120}增量包不完整/, 'a pack that is missing files never activates');
    assert.match(store, /\.staging/, 'files land in a staging directory first');
    assert.match(store, /if \(!staging\.renameTo\(target\)\)/, 'and are renamed into place only at the end');
    assert.match(store, /deleteTree\(staging\)/, 'a failure removes the staging directory (the old state survives)');
    assert.match(store, /meta\.optInt\("to"\) != expect/, 'the pack must declare the build it is for');
    assert.match(store, /rel\.contains\("\.\."\)/, 'paths from a pack are sanitised');
    assert.match(store, /apkInt\("build"\) >= build/, 'an older overlay is dropped once a newer APK is installed');
  });

  test('the store keeps the payload self-describing', () => {
    assert.match(store, /MANIFEST = "payload\.json"/);
    assert.match(store, /writeManifest\(staging, meta, files\)/, 'the overlay carries a merged 清单');
    assert.match(store, /out\.put\("build", build\(\)\)[\s\S]{0,400}out\.put\("files"/, 'and reports its state to the picker');
  });

  test('the plugin checks the base itself, verifies the download, and reloads after applying', () => {
    assert.match(plugin, /installed <= 0/, 'an unknown installed build takes the full installer');
    assert.match(plugin, /to <= installed/, 'and so does a pack that is not newer');
    assert.match(plugin, /store\.installedBuild\(\)/, 'the base comes from the device’s own state, not the page');
    assert.match(plugin, /fetchTo\(conn\.getInputStream\(\), temp, expected, total\)/, 'the pack is hashed while downloading');
    assert.match(plugin, /store\.apply\(target, build,/, 'and only then unpacked into the overlay');
    assert.match(plugin, /webView\.clearCache\(true\)/, 'the WebView cache is dropped before reloading');
    assert.match(plugin, /getBridge\(\)\.reload\(\)/);
    assert.match(plugin, /public void overlayStatus\(PluginCall call\)/, 'the picker can ask what is installed');
    assert.match(plugin, /public void clearOverlay\(PluginCall call\)/, 'and a repair path exists');
  });

  test('the LAN host serves the same files the host itself runs', () => {
    // A guest must not get the old code while the host's page runs the new one.
    assert.match(host, /OverlayStore\.get\(getContext\(\)\)\.activeDir\(\)/);
    assert.match(host, /new OverlayStaticSource\(new DirStaticSource\(overlayDir\.toPath\(\)\), source\)/);
    const overlay = java('java/site/starst/stronghold/host/OverlayStaticSource.java');
    assert.match(overlay, /implements StaticSource/);
    assert.match(overlay, /overlayFile\(rel\) \? overlay\.open\(rel\) : base\.open\(rel\)/, 'the overlay wins when it has the file');
  });
});

describe('when the picker offers the incremental pack', () => {
  const asset = { name: 'StrongholdProtocol-0.2.5-android-debug.apk', url: 'https://example/apk', sha256: 'a'.repeat(64), size: 455 * 1048576 };
  const pack = { name: 'delta-5-6.zip', url: 'https://example/delta-5-6.zip', sha256: 'b'.repeat(64), size: 75 * 1048576, base: 5, files: 1824, bytes: 85 * 1048576 };
  const feed = { version: '0.2.5', build: 6, commit: 'cf7a9400', notes: 'n', android: asset, delta: pack };
  const local = { build: 5 };

  test('a pack for the build the client is running is used, and the row names both sizes', () => {
    const plan = updatePlan(feed, local, 'android');
    assert.equal(plan.mode, 'delta');
    assert.equal(plan.bytes, pack.size);
    assert.equal(plan.saved, asset.size - pack.size);
    const label = updateLabel(feed, 'android', plan);
    assert.match(label, /增量下载 75\.0 MB（全量 455\.0 MB）/);
    assert.match(label, /0\.2\.5 · build 6 · cf7a9400/);
  });

  test('a pack for another build is refused — a partial file set cannot be verified against anything else', () => {
    for (const base of [4, 6, 99, 0, -1, null, undefined, 'six', true, {}, []]) {
      const plan = updatePlan({ ...feed, delta: { ...pack, base } }, local, 'android');
      assert.equal(plan.mode, 'apk', `base ${JSON.stringify(base)} must fall back to the installer`);
      assert.equal(plan.delta, null);
      assert.equal(deltaAsset({ ...feed, delta: { ...pack, base } }, local), null);
    }
    // The build numbers in the feed are JSON numbers; a numeric string is read as the same number rather than
    // refused, which is how the rest of the feed is read too.
    assert.equal(deltaAsset({ ...feed, delta: { ...pack, base: '5' } }, local).base, 5);
  });

  test('and refused when the client does not know what it is running', () => {
    for (const local of [null, undefined, {}, { build: 0 }, { build: 'x' }]) {
      assert.equal(updatePlan(feed, local, 'android').mode, 'apk', `local ${JSON.stringify(local)}`);
    }
  });

  test('an unverified or oversized pack is refused', () => {
    const cases = {
      'no sha256': { sha256: undefined },
      'short sha256': { sha256: 'abc' },
      'uppercase sha256': { sha256: 'B'.repeat(64) }, // accepted: normalised, like every other feed asset
      'plaintext remote url': { url: 'http://example.com/delta.zip' },
      'no url': { url: '' },
      'zero size': { size: 0 },
      'not smaller than the installer': { size: asset.size + 1 },
    };
    for (const [what, patch] of Object.entries(cases)) {
      const plan = updatePlan({ ...feed, delta: { ...pack, ...patch } }, local, 'android');
      const expected = what === 'uppercase sha256' ? 'delta' : 'apk';
      assert.equal(plan.mode, expected, `${what} → ${expected}`);
    }
  });

  test('garbage where the pack should be is simply no pack', () => {
    for (const delta of [null, 'delta', 42, [], { base: 5 }]) {
      assert.equal(deltaAsset({ ...feed, delta }, local), null);
      assert.equal(updatePlan({ ...feed, delta }, local, 'android').mode, 'apk');
    }
  });

  test('the desktop never takes the pack: it hands over the download page either way', () => {
    const feedWin = { ...feed, win: { ...asset, name: 'win.zip' } };
    const plan = updatePlan(feedWin, local, 'win');
    assert.equal(plan.mode, 'apk');
    assert.equal(plan.asset.name, 'win.zip');
    assert.ok(!updateLabel(feedWin, 'win', plan).includes('增量'));
  });

  test('a feed without an installer for this platform offers nothing', () => {
    assert.equal(updatePlan({ version: '0.2.5', build: 6, delta: pack }, local, 'android'), null);
  });
});
