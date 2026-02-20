const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zap', {
  hideOverlay:    ()       => ipcRenderer.send('hide-overlay'),
  openSettings:   ()       => ipcRenderer.send('open-settings'),
  openApp:        ()       => ipcRenderer.send('open-app'),
  getSettings:    ()       => ipcRenderer.invoke('get-settings'),
  saveSettings:   (s)      => ipcRenderer.send('save-settings', s),
  aiRequest:      (params) => ipcRenderer.invoke('ai-request', params),
  dripType:       (text)   => ipcRenderer.invoke('drip-type', text),
  cancelDripType: ()       => ipcRenderer.send('cancel-drip-type'),
  checkForUpdates:()       => ipcRenderer.invoke('check-for-updates'),

  onScreenCaptured: (cb) => ipcRenderer.on('screen-captured', (_, d) => cb(d)),
  onLoadSettings:   (cb) => ipcRenderer.on('load-settings',   (_, d) => cb(d)),
  onSetMode:        (cb) => ipcRenderer.on('set-mode',         (_, m) => cb(m)),
  onSettingsSaved:  (cb) => ipcRenderer.on('settings-saved',   ()     => cb()),

  welcomeDone:     () => ipcRenderer.send('welcome-done'),
  startTrial:      () => ipcRenderer.send('start-trial'),
  validateLicense: (key) => ipcRenderer.invoke('validate-license', key),
  getLicenseStatus: () => ipcRenderer.invoke('get-license-status'),

  copyToClipboard: (text) => {
    const { clipboard } = require('electron');
    clipboard.writeText(text);
  }
});
