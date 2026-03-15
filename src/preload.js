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
  autopilotExecute: (data) => ipcRenderer.invoke('autopilot-execute', data),
  pasteToScreen:  ()       => ipcRenderer.invoke('paste-to-screen'),
  openFlashcards: (cards)  => ipcRenderer.send('open-flashcards', cards),
  checkForUpdates:()       => ipcRenderer.invoke('check-for-updates'),

  onScreenCaptured: (cb) => ipcRenderer.on('screen-captured', (_, d) => cb(d)),
  onLoadCards:      (cb) => ipcRenderer.on('load-cards',       (_, d) => cb(d)),
  onLoadSettings:   (cb) => ipcRenderer.on('load-settings',   (_, d) => cb(d)),
  onSetMode:        (cb) => ipcRenderer.on('set-mode',         (_, m) => cb(m)),
  onScreenShareStatus: (cb) => ipcRenderer.on('screen-share-status', (_, s) => cb(s)),
  onAutopilotResult:   (cb) => ipcRenderer.on('autopilot-result', (_, d) => cb(d)),
  onSettingsSaved:  (cb) => ipcRenderer.on('settings-saved',   ()     => cb()),
  onCheckoutCancelled: (cb) => ipcRenderer.on('checkout-cancelled', () => cb()),

  authSignup:      (data) => ipcRenderer.invoke('auth-signup', data),
  authSignin:      (data) => ipcRenderer.invoke('auth-signin', data),
  authDone:        ()     => ipcRenderer.send('auth-done'),

  welcomeDone:     () => ipcRenderer.send('welcome-done'),
  replayTour:      () => ipcRenderer.send('replay-tour'),
  getChangelog:    () => ipcRenderer.invoke('get-changelog'),
  startTrial:      () => ipcRenderer.send('start-trial'),
  acceptTerms:     () => ipcRenderer.invoke('accept-terms'),
  validateLicense: (key) => ipcRenderer.invoke('validate-license', key),
  getLicenseStatus: () => ipcRenderer.invoke('get-license-status'),
  createCheckoutSession: (email) => ipcRenderer.invoke('create-checkout-session', email),
  openCheckoutWindow:    (url, sessionId) => ipcRenderer.invoke('open-checkout-window', url, sessionId),
  validateStripeSubscription: (sid) => ipcRenderer.invoke('validate-stripe-subscription', sid),
  getSubscriptionInfo:   () => ipcRenderer.invoke('get-subscription-info'),
  cancelSubscription:    () => ipcRenderer.invoke('cancel-subscription'),
  reactivateSubscription:() => ipcRenderer.invoke('reactivate-subscription'),
  createBillingPortal:   () => ipcRenderer.invoke('create-billing-portal'),

  copyToClipboard: (text) => {
    const { clipboard } = require('electron');
    clipboard.writeText(text);
  },

  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openExternal:  (url) => ipcRenderer.invoke('open-external', url),

  // Admin & Support
  isAdmin:          ()     => ipcRenderer.invoke('is-admin'),
  getAdminStats:    ()     => ipcRenderer.invoke('get-admin-stats'),
  submitTicket:     (data) => ipcRenderer.invoke('submit-ticket', data),
  getTickets:       ()     => ipcRenderer.invoke('get-tickets'),
  updateTicketStatus: (data) => ipcRenderer.invoke('update-ticket-status', data),

  // Fetch ticket comments (admin replies)
  getTicketComments: (issueNumber) => ipcRenderer.invoke('get-ticket-comments', issueNumber)
});
