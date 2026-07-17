const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dripType', {
  start: (text) => ipcRenderer.invoke('drip-type:start', text),
  cancel: () => ipcRenderer.send('drip-type:cancel'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  platform: process.platform
});
