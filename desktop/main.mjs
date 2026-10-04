// Electron main process for the packaged desktop client (.exe).
//
// The shell is deliberately thin: it serves the pre-assembled client payload (tools/package-client.mjs →
// build/client/www, shipped in resources/www) over a loopback HTTP server and points a Chromium window at it.
// The page then connects to the game server it was built for (`/js/runtime-config.js`, game.starst.site by
// default) — game traffic goes straight to that server, this process only serves the 260 MB of local art/music
// so entering a match doesn't re-download it.
//
// The loopback server always binds DEFAULT_PORT (serve.mjs): the page's origin — and with it the localStorage
// the game keeps its identity token, loadout and settings in — must be the same on every launch. Binding an
// ephemeral port instead made every restart look like a fresh install (see serve.mjs).
//
//   StrongholdProtocol.exe [--server <address>] [--fullscreen] [--choose-server] [--insecure-tls]
//
// `--server` overrides the built-in address for this run (LAN play without a rebuild) by appending ?server=…
// which public/js/net.js understands. Otherwise the client uses the server remembered by the in-page picker
// (shell/picker.js): on a first run — or whenever it has nothing remembered — that picker covers the boot screen
// and the player picks a server; `--choose-server` and F2 force it back up later.
//
// `--insecure-tls` accepts every certificate without asking (a player who runs a self-signed server and does not
// want the prompt); the Android build asks the same question with an AlertDialog instead.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, appendFileSync, statSync, writeFileSync } from 'node:fs';
import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { createStaticServer, DEFAULT_PORT } from './serve.mjs';
import { describeCertificate, fingerprintOf, hostKey, isTrusted, loadTrusted, remember, saveTrusted, shortFingerprint } from './trust.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Payload root: resources/www in a packaged app, build/client/www when running from the repo (`npm run client:desktop:dev`). */
const WWW = app.isPackaged ? path.join(process.resourcesPath, 'www') : path.join(HERE, '..', 'build', 'client', 'www');
const TITLE = '卫戍协议：盟约 · STRONGHOLD PROTOCOL';

/**
 * The shell has no console in front of it, so everything worth knowing goes to `<userData>/client.log` as well as to
 * stderr (visible when launched from a terminal). A player reporting "the client vanished" can send that file, and
 * the diagnostics above write to it synchronously so nothing is lost when the process dies abruptly.
 */
const LOG_FILE = path.join(app.getPath('userData'), 'client.log');
const LOG_MAX_BYTES = 1 << 20;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) writeFileSync(LOG_FILE, '');
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch { /* a read-only profile must not break the game */ }
  console.log(line);
}

/** `--server host:port` / `--server=host:port` (see the header). */
function argValue(name) {
  const argv = process.argv.slice(app.isPackaged ? 1 : 2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) return argv[i + 1] ?? '';
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return '';
}

const serverOverride = argValue('--server').trim();
const chooseServer = !serverOverride && process.argv.includes('--choose-server');
const startFullscreen = process.argv.includes('--fullscreen');
/**
 * `--insecure-tls`: accept every certificate without asking, instead of prompting once per server (see the
 * certificate-error handler below). For a player who runs a self-signed server and does not want to be asked.
 */
const insecureTls = process.argv.includes('--insecure-tls');

// Crash / failure diagnostics. Nothing here quits the app: a renderer that dies is reloaded by the handler below,
// and an unhandled error must not turn into a silent exit (which is what "打开干员调配就闪退" looks like).
process.on('uncaughtException', (e) => log('[client] uncaught exception in the main process', e));
process.on('unhandledRejection', (e) => log('[client] unhandled rejection in the main process', e));
app.on('child-process-gone', (_e, d) => log(`[client] child process gone: type=${d?.type} reason=${d?.reason} exitCode=${d?.exitCode}`));
app.on('render-process-gone', (_e, _wc, d) => log(`[client] renderer gone: reason=${d?.reason} exitCode=${d?.exitCode}`));
app.on('quit', (_e, code) => log(`[client] quitting (exit code ${code})`));

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

// ---- TLS trust (trust-on-first-use) -----------------------------------------------------------------------------
// Chromium refuses a self-hosted server's self-signed certificate (an frp tunnel, say) with
// ERR_CERT_AUTHORITY_INVALID. Instead of verifying nothing, ask once per server and remember the certificate that
// was accepted: every other server stays verified, and a *changed* certificate asks again.
const TRUST_FILE = path.join(app.getPath('userData'), 'trusted-certs.json');
let trusted = loadTrusted(TRUST_FILE);
/** Hosts whose prompt is on screen right now: further failures wait for it instead of stacking dialogs. */
const prompting = new Set();
/** Hosts the player declined: not asked again until the page reloads (switching servers reloads it). */
const declined = new Set();
let promptChain = Promise.resolve();

/** Show the trust prompt, one dialog at a time whatever the reconnect loop does. */
function askAboutCertificate({ host, fp, certificate }) {
  const ask = () => {
    if (!win || win.isDestroyed()) return Promise.resolve(false);
    const { subject, issuer } = describeCertificate(certificate);
    return dialog.showMessageBox(win, {
      type: 'warning',
      noLink: true,
      buttons: ['仍然连接', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '无法验证服务器证书',
      message: `无法验证 ${host} 的证书`,
      detail: [
        `服务器：${host}`,
        `证书主题：${subject}`,
        `颁发者：${issuer}`,
        `SHA-256 指纹：${shortFingerprint(fp)}`,
        '',
        '“仍然连接”只对这台服务器跳过证书校验（其它服务器照常校验）：网络上的其他人可能在冒充它，请只在确认这是自己或信得过的人开的服务器时才继续。决定会记住，证书以后变了会再问一次。',
      ].join('\n'),
    }).then((r) => r.response === 0);
  };
  promptChain = promptChain.then(ask, ask);
  return promptChain;
}

app.on('certificate-error', (event, _wc, url, error, certificate, callback) => {
  event.preventDefault();
  const host = hostKey(url);
  const fp = fingerprintOf(certificate);
  if (isTrusted(trusted, host, fp)) { callback(true); return; }
  if (insecureTls) {
    trusted = remember(trusted, host, fp);
    saveTrusted(TRUST_FILE, trusted);
    callback(true);
    return;
  }
  if (!host || !fp || declined.has(host) || prompting.has(host)) { callback(false); return; }
  prompting.add(host);
  log(`[client] the certificate of ${host} is not trusted (${error}) — asking the player, ${shortFingerprint(fp)}`);
  askAboutCertificate({ host, fp, certificate }).then((ok) => {
    prompting.delete(host);
    if (ok) {
      trusted = remember(trusted, host, fp);
      saveTrusted(TRUST_FILE, trusted);
      log(`[client] player trusted the certificate of ${host} (${shortFingerprint(fp)})`);
    } else {
      declined.add(host);
      log(`[client] player declined the certificate of ${host}`);
    }
    callback(ok);
  });
});

/** Keep the window on the local payload; anything else opens in the user's browser. */
function openExternal(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
}

function buildMenu() {
  Menu.setApplicationMenu(null); // a game window, no Electron menu bar
}

/** Bring the in-page server picker up again (shell/picker.js exposes window.__SP_SHELL_PICKER__). */
function showServerPicker(wc) {
  wc.executeJavaScript('globalThis.__SP_SHELL_PICKER__ && globalThis.__SP_SHELL_PICKER__.show()', true).catch(() => {});
}

function registerShortcuts(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'f11') { win?.setFullScreen(!win.isFullScreen()); event.preventDefault(); }
    else if (key === 'f2') { showServerPicker(wc); event.preventDefault(); }
    else if (key === 'f5' || (input.control && key === 'r')) { wc.reload(); event.preventDefault(); }
    else if (key === 'f12' || (input.control && input.shift && key === 'i')) { wc.toggleDevTools(); event.preventDefault(); }
  });
}

async function main() {
  buildMenu();
  if (insecureTls) log('[client] --insecure-tls: certificate verification is OFF for this run (self-signed servers)');

  if (!existsSync(path.join(WWW, 'index.html'))) {
    dialog.showErrorBox(TITLE, `客户端资源缺失 / client payload missing:\n${WWW}\n\n先运行 npm run client:build 生成客户端资源。`);
    app.quit();
    return;
  }

  // A pinned port (not `0`) keeps `http://127.0.0.1:<port>` — the page's origin — identical across launches.
  // Chromium scopes localStorage by origin, so this is what lets the identity token, the loadout, settings and
  // the picker's saved server survive a restart; an OS-assigned port would silently discard all of it.
  const served = await createStaticServer({ root: WWW, port: DEFAULT_PORT, proxy: true, log: console });
  const query = serverOverride
    ? `?server=${encodeURIComponent(serverOverride)}`
    : (chooseServer ? '?pick=1' : '');

  win = new BrowserWindow({
    width: 1440,
    height: 810,
    minWidth: 960,
    minHeight: 540,
    title: TITLE,
    backgroundColor: '#0c0f0e',
    autoHideMenuBar: true,
    fullscreen: startFullscreen,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false },
  });
  registerShortcuts(win.webContents);
  win.once('ready-to-show', () => win.show());
  // A reload (the picker reloads after a choice) re-arms the prompt for servers the player had declined.
  win.webContents.on('did-finish-load', () => declined.clear());
  win.on('close', () => log('[client] window closing'));
  win.on('closed', () => { log('[client] window closed'); win = null; });
  win.webContents.on('render-process-gone', (_e, d) => {
    log(`[client] the page's renderer died (reason=${d?.reason}, exitCode=${d?.exitCode}) — reloading it`);
    // Keep the game alive: without this the window is destroyed, `window-all-closed` fires and the whole app quits,
    // which is what a client that "闪退" (vanishes) when a heavy screen opens looks like. A reload re-runs the boot
    // and reconnects to the same server, so the player is back in a second instead of losing the client.
    if (win && !win.isDestroyed()) win.webContents.reload();
  });
  win.webContents.on('unresponsive', () => log('[client] the page stopped responding'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log(`[client] load failed: ${code} ${desc} ${url}`));
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(served.url)) return;
    event.preventDefault();
    openExternal(url);
  });

  try {
    await win.loadURL(`${served.url}/${query}`);
  } catch (e) {
    // A load failure is not fatal (a navigation during boot, a renderer crash we are about to recover from): log it
    // and leave the window alone — quitting here is what turned a recoverable failure into a silent exit.
    log(`[client] loadURL failed: ${e?.message || e}`);
  }
  log(`[client] serving ${WWW} at ${served.url}, game server ${serverOverride || '(picker / runtime-config.js)'}`);

  app.on('second-instance', () => {
    // A second launch while this one runs: bring the existing window forward (the new process quits by design).
    log('[client] another instance was launched — focusing this window');
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('quit', () => { served.close().catch(() => {}); });
}

app.whenReady().then(main, (err) => {
  dialog.showErrorBox(TITLE, String(err?.stack || err));
  app.quit();
});
