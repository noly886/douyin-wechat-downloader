const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nativeApi', {
  getConfig: () => ipcRenderer.invoke('app:get-config'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  openCaptureWindow: url => ipcRenderer.invoke('capture:open-window', url),
  openDouyinLogin: () => ipcRenderer.invoke('auth:open-douyin-login'),
  getLatestCapturedVideo: () => ipcRenderer.invoke('capture:get-latest-video'),
  startDownload: options => ipcRenderer.invoke('download:start', options),
  cancelDownload: () => ipcRenderer.invoke('download:cancel'),
  openPath: targetPath => ipcRenderer.invoke('shell:open-path', targetPath),
  onDownloadEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('download:event', listener);
    return () => ipcRenderer.removeListener('download:event', listener);
  },
  onCaptureEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('capture:event', listener);
    return () => ipcRenderer.removeListener('capture:event', listener);
  },
  onWindowState: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  }
});
