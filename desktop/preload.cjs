// Preload for the packaged desktop client (CommonJS: sandboxed preloads cannot be ES modules).
//
// Exposes only the "open to LAN" host controls to the page (shell/picker.js), over a narrow contextBridge surface —
// the renderer stays sandboxed with no Node access. On the web/Android build this object is simply absent, so the
// picker hides the LAN controls.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__SP_HOST__', {
  /** @returns {Promise<{ active: boolean, port: number|null, addresses: string[], url: string|null }>} */
  status: () => ipcRenderer.invoke('host:status'),
  /** Open the integrated server to the LAN. @returns {Promise<object>} the same status shape */
  start: () => ipcRenderer.invoke('host:start'),
  /** Close it again. @returns {Promise<object>} the same status shape */
  stop: () => ipcRenderer.invoke('host:stop'),
});
