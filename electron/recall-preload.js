// Sandboxed Recall renderer: named capabilities only. No config, credentials, filesystem,
// generic invoke/send/on, settings tests or meeting control.
const { contextBridge, ipcRenderer } = require('electron');
let startupTheme = 'light';
try {
  if ((process.argv || []).includes('--meetscribe-theme=dark')) startupTheme = 'dark';
} catch { /* secret-free cosmetic fallback */ }
// Main can update the theme between document load and React's first effect. Retain only
// this non-secret cosmetic value so a late subscriber receives the current theme immediately.
let currentTheme = startupTheme;
const themeListeners = new Set();
ipcRenderer.on('recall:theme', (_event, theme) => {
  if (theme !== 'dark' && theme !== 'light') return;
  currentTheme = theme;
  for (const callback of themeListeners) callback(theme);
});
function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback is required.');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('meetscribeRecall', {
  startupTheme,
  open: request => ipcRenderer.invoke('recall:open', request),
  close: request => ipcRenderer.invoke('recall:close', request),
  getState: request => ipcRenderer.invoke('recall:get-state', request),
  submitText: request => ipcRenderer.invoke('recall:submit-text', request),
  submitAudio: request => ipcRenderer.invoke('recall:submit-audio', request),
  cancel: request => ipcRenderer.invoke('recall:cancel', request),
  setMuted: request => ipcRenderer.invoke('recall:set-muted', request),
  openSource: request => ipcRenderer.invoke('recall:open-source', request),
  resize: request => ipcRenderer.invoke('recall:resize', request),
  onStage: callback => subscribe('recall:stage', callback),
  onAnswer: callback => subscribe('recall:answer', callback),
  onAudio: callback => subscribe('recall:audio', callback),
  onError: callback => subscribe('recall:error', callback),
  onTheme: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    themeListeners.add(callback); callback(currentTheme);
    return () => themeListeners.delete(callback);
  },
});
