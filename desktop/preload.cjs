// Preload for the packaged desktop client (CommonJS: sandboxed preloads cannot be ES modules).
//
// Exposes only the "open to LAN" host controls to the page (shell/picker.js), over a narrow contextBridge surface —
// the renderer stays sandboxed with no Node access. On the web/Android build this object is simply absent, so the
// picker hides the LAN controls.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__SP_HOST__', {
  /** @returns {Promise<{ active: boolean, port: number|null, addresses: string[], url: string|null, error?: string }>} */
  status: () => ipcRenderer.invoke('host:status'),
  /**
   * Open the integrated server to the LAN.
   * @param {number} [port] the port to bind (0/omitted = let the OS pick); a busy port is reported, not worked around
   * @returns {Promise<object>} the same status shape, plus `error` when the port could not be used
   */
  start: (port) => ipcRenderer.invoke('host:start', port),
  /** Close it again. @returns {Promise<object>} the same status shape */
  stop: () => ipcRenderer.invoke('host:stop'),
});
