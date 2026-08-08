const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dripType', Object.freeze({
  start: (text) => ipcRenderer.invoke('drip-type:start', text),
  cancel: () => ipcRenderer.send('drip-type:cancel'),
  showQuick: () => ipcRenderer.send('quick:show'),
  closeQuick: () => ipcRenderer.send('quick:close'),
  showMain: () => ipcRenderer.send('main:show'),
  replayOnboarding: () => ipcRenderer.send('onboarding:replay'),
  completeOnboarding: (settings) => ipcRenderer.invoke('onboarding:complete', settings),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getAccessibility: () => ipcRenderer.invoke('accessibility:get'),
  requestAccessibility: () => ipcRenderer.invoke('accessibility:request'),
  getPermissionChecklist: () => ipcRenderer.invoke('permissions:get'),
  requestAutomation: () => ipcRenderer.invoke('automation:request'),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  getUpdateState: () => ipcRenderer.invoke('updater:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.send('updater:install'),
  onState: (callback) => ipcRenderer.on('drip-type:state', (_event, state) => callback(state)),
  onQuickOpened: (callback) => ipcRenderer.on('quick:opened', (_event, data) => callback(data)),
  onTheme: (callback) => ipcRenderer.on('theme:changed', (_event, data) => callback(data)),
  onUpdate: (callback) => ipcRenderer.on('updater:state', (_event, state) => callback(state))
}));
