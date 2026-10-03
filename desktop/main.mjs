// Electron main process for the packaged desktop client (.exe).
//
// The shell is deliberately thin: it serves the pre-assembled client payload (tools/package-client.mjs →
// build/client/www, shipped in resources/www) over a loopback HTTP server and points a Chromium window at it.
// The page then connects to the game server it was built for (`/js/runtime-config.js`, game.starst.site by
// default) — game traffic goes straight to that server, this process only serves the 260 MB of local art/music
// so entering a match doesn't re-download it.
//
//   StrongholdProtocol.exe [--server <address>] [--fullscreen] [--choose-server]
//
// `--server` overrides the built-in address for this run (LAN play without a rebuild) by appending ?server=…
// which public/js/net.js understands. Otherwise the client uses the server remembered by the in-page picker
// (shell/picker.js): on a first run — or whenever it has nothing remembered — that picker covers the boot screen
// and the player picks a server; `--choose-server` and F2 force it back up later.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { createStaticServer } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Payload root: resources/www in a packaged app, build/client/www when running from the repo (`npm run client:desktop:dev`). */
const WWW = app.isPackaged ? path.join(process.resourcesPath, 'www') : path.join(HERE, '..', 'build', 'client', 'www');
const TITLE = '卫戍协议：盟约 · STRONGHOLD PROTOCOL';

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

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

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

  if (!existsSync(path.join(WWW, 'index.html'))) {
    dialog.showErrorBox(TITLE, `客户端资源缺失 / client payload missing:\n${WWW}\n\n先运行 npm run client:build 生成客户端资源。`);
    app.quit();
    return;
  }

  const served = await createStaticServer({ root: WWW, log: console });
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
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(served.url)) return;
    event.preventDefault();
    openExternal(url);
  });

  await win.loadURL(`${served.url}/${query}`);
  console.log(`[client] serving ${WWW} at ${served.url}, game server ${serverOverride || '(picker / runtime-config.js)'}`);

  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('quit', () => { served.close().catch(() => {}); });
}

app.whenReady().then(main, (err) => {
  dialog.showErrorBox(TITLE, String(err?.stack || err));
  app.quit();
});
