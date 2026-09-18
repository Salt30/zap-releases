const {
  app,
  autoUpdater: nativeUpdater,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  globalShortcut,
  ipcMain,
  clipboard,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  screen,
  session,
  shell,
  safeStorage,
  systemPreferences
} = require('electron');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');
const { configureAppIdentity } = require('./app-identity');
const { execFile } = require('child_process');
const { installZap } = require('./zap-main');
const { createAccountSession } = require('./account-session');
const { keepWindowAvailable } = require('./window-recovery');
const { randomUUID } = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { accessState, shouldRevokeEntitlement, verifyEntitlement } = require('./subscription');
const { buildCharacterSteps, renderAppleScript, validateTypingEvents } = require('./typing-engine');
const {
  normalizeAccelerator,
  registerShortcutPair,
  replaceShortcutPair,
  validateShortcutPair
} = require('./shortcut-utils');

const APP_ID = 'com.salt30.driptype';
const BILLING_ORIGIN = 'https://tryzap.net';
const BILLING_SCHEME = 'driptype';
const KEYCHAIN_SERVICE = 'com.salt30.driptype.subscription';
const LEGACY_TRIAL_KEYCHAIN_SERVICE = 'com.salt30.driptype.trial';
const MAX_TEXT_LENGTH = 100000;
const APP_SCHEME = 'drip';
const APP_HOST = 'app';
const APP_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const APP_RESOURCES = new Set([
  'index.html', 'index.js', 'quick.html', 'quick.js',
  'onboarding.html', 'onboarding.js', 'zap-icon.svg',
  'zap-wordmark-dark.svg', 'zap-wordmark-light.svg', 'native.css', 'zap.css', 'zap-pin.html', 'zap-pin.js'
]);
const DEFAULTS = {
  dripWPM: 45,
  dripDelay: 10,
  typoRate: 0.03,
  dripPauseChance: 0.03,
  dripBurstChance: 0.08,
  hotkeyStart: 'Alt+5',
  hotkeyStop: 'Alt+0',
  shortcutDefaultsMigratedToOption5: false,
  focusDelayMigratedToOldStyle: false,
  launchAtLogin: true,
  theme: 'system',
  deviceId: null,
  entitlementToken: '',
  encryptedRefreshCredential: '',
  paidOnlyMigrationV173: false,
  automationPermissionChecked: false,
  onboardingDone: false
};

configureAppIdentity(app);
const store = new Store({ defaults: DEFAULTS });

// Existing installs keep electron-store values across upgrades. Migrate the
// former default once, then preserve every shortcut the user chooses — even ⌥4.
if (!store.get('shortcutDefaultsMigratedToOption5', false)) {
  const previous = normalizeAccelerator(store.get('hotkeyStart'));
  if (previous.accelerator === 'Alt+4') store.set('hotkeyStart', DEFAULTS.hotkeyStart);
  store.set('shortcutDefaultsMigratedToOption5', true);
}
// The original Zap allowed enough time to click an exact browser field
// after its overlay disappeared. Move installs still using the former 3-second
// default to that proven 10-second focus window, while preserving every other
// customized delay.
if (!store.get('focusDelayMigratedToOldStyle', false)) {
  if (Number(store.get('dripDelay')) === 3) store.set('dripDelay', DEFAULTS.dripDelay);
  store.set('focusDelayMigratedToOldStyle', true);
}

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: false,
    corsEnabled: false
  }
}]);

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.enableSandbox();

let mainWindow = null;
let mainRecovery = null;
let quitting = false;
let quickWindow = null;
let onboardingWindow = null;
let tray = null;
let quickTarget = null;
let dripTypeCancelled = false;
let dripTypeRunning = false;
let activeTypingProcess = null;
let updateCheckTimer = null;
let lastNotifiedUpdateVersion = null;
let pendingActivationUrl = null;
let entitlementRefreshTimer = null;
let billingState = null;
let updateState = {
  status: app.isPackaged && ['darwin', 'win32'].includes(process.platform) ? 'idle' : 'development',
  currentVersion: app.getVersion(),
  version: null,
  releaseName: null,
  releaseNotes: null,
  percent: 0,
  lastCheckedAt: null,
  message: 'Updates are checked automatically.'
};

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function platformResource(filename) {
  if (!app.isPackaged) return path.join(__dirname, filename);
  return path.join(process.resourcesPath, 'app.asar.unpacked', 'build-app', filename);
}

function windowsPowerShellArguments(action, extra = []) {
  return [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', platformResource('windows-host.ps1'), '-Action', action, ...extra
  ];
}

function readProtectedStoreValue(key) {
  if (!safeStorage.isEncryptionAvailable()) return '';
  const encoded = String(store.get(key, '') || '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return '';
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch (_) {
    return '';
  }
}

function writeProtectedStoreValue(key, value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure operating-system storage is unavailable.');
  store.set(key, safeStorage.encryptString(value).toString('base64'));
}

function ensureDeviceId() {
  const current = store.get('deviceId');
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(current || ''))) {
    return current;
  }
  const value = randomUUID();
  store.set('deviceId', value);
  return value;
}

async function retireLegacyTrialState() {
  store.delete('trialStartedAt');
  store.delete('encryptedTrialStartedAt');
  store.delete('paidAccessSeen');
  if (!store.get('paidOnlyMigrationV173', false)) {
    // Invalidate every entitlement cached by a trial-capable build. A paid
    // account immediately receives a fresh token from its protected refresh
    // credential; a former trial cannot carry offline access into this build.
    store.set('entitlementToken', '');
    store.set('paidOnlyMigrationV173', true);
  }
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('/usr/bin/security', [
        'delete-generic-password', '-a', APP_ID, '-s', LEGACY_TRIAL_KEYCHAIN_SERVICE
      ]);
    } catch (_) {}
  }
}

function currentBillingState() {
  billingState = accessState({
    token: store.get('accountSignedOut', false) ? '' : store.get('entitlementToken'),
    deviceId: ensureDeviceId()
  });
  return { ...billingState, signedIn: !store.get('accountSignedOut', false) && Boolean(store.get('accountConnected', false) || store.get('entitlementToken')), cleanupPending: store.get('accountCleanupPending', false) };
}

function publishBillingState(patch = {}) {
  billingState = { ...currentBillingState(), ...patch };
  sendToWindow(mainWindow, 'billing:state', { ...billingState });
  if (tray) createTrayMenuOnly();
  return { ...billingState };
}

async function readRefreshCredential() {
  if (process.platform === 'win32') {
    const value = readProtectedStoreValue('encryptedRefreshCredential');
    return /^sub_[A-Za-z0-9]+\.[A-Za-z0-9_-]{40,}$/.test(value) ? value : '';
  }
  if (process.platform !== 'darwin') return '';
  try {
    const value = await execFileAsync('/usr/bin/security', [
      'find-generic-password', '-a', APP_ID, '-s', KEYCHAIN_SERVICE, '-w'
    ], { timeout: 10000 });
    return /^sub_[A-Za-z0-9]+\.[A-Za-z0-9_-]{40,}$/.test(value) ? value : '';
  } catch (_) {
    return '';
  }
}

async function saveRefreshCredential(value) {
  if (!/^sub_[A-Za-z0-9]+\.[A-Za-z0-9_-]{40,}$/.test(value)) {
    throw new Error('Invalid subscription credential');
  }
  if (process.platform === 'win32') {
    writeProtectedStoreValue('encryptedRefreshCredential', value);
    return;
  }
  if (process.platform !== 'darwin') throw new Error('Secure subscription storage is unavailable.');
  await execFileAsync('/usr/bin/security', [
    'add-generic-password', '-U', '-a', APP_ID, '-s', KEYCHAIN_SERVICE, '-w', value
  ], { timeout: 10000 });
}

async function deleteRefreshCredential() {
  if (process.platform === 'win32') {
    store.set('encryptedRefreshCredential', '');
    return;
  }
  if (process.platform !== 'darwin') return;
  try {
    await execFileAsync('/usr/bin/security', [
      'delete-generic-password', '-a', APP_ID, '-s', KEYCHAIN_SERVICE
    ], { timeout: 10000 });
  } catch (error) {
    if (Number(error.code) !== 44) throw new Error('Secure credential removal failed.');
  }
}

async function billingRequest(pathname, body) {
  const response = await fetch(`${BILLING_ORIGIN}${pathname}`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  let result = null;
  try {
    result = await response.json();
  } catch (_) {}
  if (!response.ok) {
    const error = new Error(result?.error || 'Subscription service is unavailable.');
    error.status = response.status;
    throw error;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Subscription service returned an invalid response.');
  }
  return result;
}

function acceptEntitlement(result) {
  const deviceId = ensureDeviceId();
  verifyEntitlement(result.entitlement, deviceId);
  store.set('entitlementToken', result.entitlement);
  return publishBillingState();
}

async function revokeBillingAccess(message) {
  store.set('entitlementToken', '');
  await deleteRefreshCredential();
  return publishBillingState({
    status: 'required',
    allowed: false,
    plan: null,
    features: ['updates'],
    expiresAt: null,
    message: message || 'Your subscription is no longer active.'
  });
}

async function refreshEntitlement({ silent = false } = {}) {
  try { return await accountSession.refresh(); }
  catch (error) {
    if (shouldRevokeEntitlement(error.status)) return revokeBillingAccess(error.message);
    const current = currentBillingState();
    return !silent || !current.allowed
      ? publishBillingState({ message: 'Access could not be refreshed. Check your connection.' }) : current;
  }
}

async function activateAccountToken(activationToken) {
  const state = await accountSession.activate(activationToken);
  if (!state.signedIn) return state;
  navigateMainWindow({ page: 'billing' });
  if (Notification.isSupported()) {
    new Notification({ title: 'Zap account connected', body: state.message, silent: true }).show();
  }
  return state;
}

function handleActivationUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== `${BILLING_SCHEME}:`) return;
    let activation;
    if (url.hostname === 'account') {
      activation = activateAccountToken(url.searchParams.get('token') || '');
    } else {
      return;
    }
    activation.catch((error) => {
      publishBillingState({ status: 'error', message: error.message || 'Activation failed.' });
      navigateMainWindow({ page: 'billing' });
    });
  } catch (_) {}
}

function numberSetting(key, fallback) {
  const value = Number(store.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function publicSettings() {
  return {
    dripWPM: numberSetting('dripWPM', DEFAULTS.dripWPM),
    dripDelay: numberSetting('dripDelay', DEFAULTS.dripDelay),
    typoRate: numberSetting('typoRate', DEFAULTS.typoRate),
    dripPauseChance: numberSetting('dripPauseChance', DEFAULTS.dripPauseChance),
    dripBurstChance: numberSetting('dripBurstChance', DEFAULTS.dripBurstChance),
    hotkeyStart: String(store.get('hotkeyStart', DEFAULTS.hotkeyStart)),
    hotkeyStop: String(store.get('hotkeyStop', DEFAULTS.hotkeyStop)),
    launchAtLogin: Boolean(store.get('launchAtLogin', DEFAULTS.launchAtLogin)),
    theme: ['system', 'dark', 'light'].includes(store.get('theme'))
      ? store.get('theme')
      : DEFAULTS.theme
  };
}

function cleanMarkdown(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, '').replace(/```/g, ''))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*{1,3}([^*]+?)\*{1,3}/g, '$1')
    .replace(/_{1,3}([^_]+?)_{1,3}/g, '$1')
    .replace(/~~([^~]+?)~~/g, '$1')
    .replace(/`([^`]+?)`/g, '$1')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/\[([^\]]+?)\]\([^)]+?\)/g, '$1')
    .replace(/!\[([^\]]*?)\]\([^)]+?\)/g, '$1')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isAccessibilityTrusted(prompt = false) {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(prompt);
}

function appPageUrl(page) {
  return `${APP_SCHEME}://${APP_HOST}/${page}`;
}

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const resource = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (request.method !== 'GET' || url.hostname !== APP_HOST || !APP_RESOURCES.has(resource)) {
      return new Response('Not found', { status: 404 });
    }
    const localPath = resource.startsWith('zap-') && resource.endsWith('.svg')
      ? path.join(__dirname, '..', 'assets', 'brand', 'zap', 'logo', resource)
      : path.join(__dirname, resource);
    const response = await net.fetch(pathToFileURL(localPath).href);
    if (!resource.endsWith('.html')) return response;
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', APP_CONTENT_SECURITY_POLICY);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
}

function protectWindow(window, page) {
  const allowedUrl = appPageUrl(page);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== allowedUrl) event.preventDefault();
  });
}

function sendToWindow(window, channel, payload) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

function broadcastState(state) {
  sendToWindow(mainWindow, 'drip-type:state', state);
  sendToWindow(quickWindow, 'drip-type:state', state);
}

function publishUpdateState(next) {
  updateState = { ...updateState, ...next };
  sendToWindow(mainWindow, 'updater:state', updateState);
  if (tray) createTrayMenuOnly();
}

function safeUpdateError(error) {
  const message = String(error?.message || error || '');
  if (/404|latest(?:-mac)?\.yml|no published versions/i.test(message)) {
    return 'The secure update channel is not published yet. Try again later.';
  }
  if (/net::|ENOTFOUND|ECONN|network|offline/i.test(message)) {
    return 'Zap could not reach the update service. Check your connection and try again.';
  }
  return 'The update could not be verified. Try again later.';
}

function plainReleaseNotes(notes) {
  const value = Array.isArray(notes)
    ? notes.map((entry) => entry?.note || '').join('\n')
    : String(notes || '');
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000) || null;
}

function notifyUpdateAvailable(info) {
  if (!Notification.isSupported() || !info?.version || lastNotifiedUpdateVersion === info.version) return;
  lastNotifiedUpdateVersion = info.version;
  const notification = new Notification({
    title: `Zap ${info.version} is available`,
    body: 'Open Zap to review what’s new and download the verified update.',
    silent: true
  });
  notification.on('click', showUpdatesPage);
  notification.show();
}

function senderPage(event) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return null;
  const senderUrl = event.senderFrame.url;
  try {
    const parsed = new URL(senderUrl);
    if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST || parsed.username || parsed.password) return null;
    const page = path.basename(parsed.pathname);
    return parsed.pathname === `/${page}` ? page : null;
  } catch (_) {
    return null;
  }
}

function assertTrustedSender(event, allowedPages) {
  const page = senderPage(event);
  if (!page || !allowedPages.includes(page)) throw new Error('Rejected untrusted IPC sender.');
}

function handleTrusted(channel, allowedPages, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event, allowedPages);
    return handler(event, ...args);
  });
}

function onTrusted(channel, allowedPages, handler) {
  ipcMain.on(channel, (event, ...args) => {
    assertTrustedSender(event, allowedPages);
    handler(event, ...args);
  });
}

function applySettings(settings = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
  const numeric = {
    dripWPM: [15, 240],
    dripDelay: [0, 30],
    typoRate: [0, 0.5],
    dripPauseChance: [0, 0.5],
    dripBurstChance: [0, 0.5]
  };
  for (const [key, [minimum, maximum]] of Object.entries(numeric)) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    const value = Number(settings[key]);
    if (Number.isFinite(value)) store.set(key, Math.min(maximum, Math.max(minimum, value)));
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'launchAtLogin') &&
      typeof settings.launchAtLogin === 'boolean') {
    store.set('launchAtLogin', settings.launchAtLogin);
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'theme')) {
    const theme = typeof settings.theme === 'string' ? settings.theme : '';
    if (['system', 'dark', 'light'].includes(theme)) {
      store.set('theme', theme);
      publishTheme(theme);
    }
  }
}

function configureLoginItem() {
  if (!app.isPackaged || !['darwin', 'win32'].includes(process.platform)) return;
  const settings = { openAtLogin: store.get('launchAtLogin', DEFAULTS.launchAtLogin) };
  if (process.platform === 'darwin') settings.openAsHidden = true;
  app.setLoginItemSettings(settings);
}

function publishTheme(theme = store.get('theme', DEFAULTS.theme)) {
  const source = ['system', 'light', 'dark'].includes(theme) ? theme : 'system';
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
  const appearance = currentAppearance();
  for (const window of [mainWindow, quickWindow, onboardingWindow]) {
    if (!window || window.isDestroyed()) continue;
    if (process.platform === 'darwin') {
      window.setVibrancy(appearance.reducedTransparency ? null : (window === quickWindow ? 'under-window' : 'sidebar'));
    }
    sendToWindow(window, 'theme:changed', appearance);
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (![mainWindow, quickWindow, onboardingWindow].includes(window)) sendToWindow(window, 'theme:changed', appearance);
  }
}

function currentAppearance() {
  return {
    theme: nativeTheme.themeSource,
    resolvedTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    reducedTransparency: nativeTheme.prefersReducedTransparency,
    highContrast: nativeTheme.shouldUseHighContrastColors,
    platform: process.platform
  };
}

async function isAutomationTrusted() {
  if (process.platform !== 'darwin') return true;
  try {
    await execFileAsync('/usr/bin/osascript', [
      '-e',
      'tell application "System Events" to get name of first process whose frontmost is true'
    ], { timeout: 10000 });
    return true;
  } catch (_) {
    return false;
  }
}

async function permissionChecklist() {
  const accessibility = isAccessibilityTrusted(false);
  const automation = process.platform !== 'darwin' || (store.get('automationPermissionChecked', false)
    ? await isAutomationTrusted()
    : false);
  const shortcuts = [store.get('hotkeyStart'), store.get('hotkeyStop')]
    .filter(Boolean)
    .every((shortcut) => globalShortcut.isRegistered(shortcut));
  const installedInApplications = !app.isPackaged || process.platform !== 'darwin'
    || process.execPath.startsWith('/Applications/');
  return { accessibility, automation, shortcuts, installedInApplications };
}

function configureUpdater() {
  if (!app.isPackaged || !['darwin', 'win32'].includes(process.platform)) {
    publishUpdateState({ status: 'development' });
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => publishUpdateState({
    status: 'checking',
    percent: 0,
    message: 'Checking the verified release channel…'
  }));
  autoUpdater.on('update-available', (info) => {
    publishUpdateState({
      status: 'available',
      version: info.version,
      releaseName: info.releaseName || `Zap ${info.version}`,
      releaseNotes: plainReleaseNotes(info.releaseNotes),
      percent: 0,
      lastCheckedAt: new Date().toISOString(),
      message: `Zap ${info.version} is ready to download.`
    });
    notifyUpdateAvailable(info);
  });
  autoUpdater.on('update-not-available', () => {
    publishUpdateState({
      status: 'current',
      version: null,
      releaseName: null,
      releaseNotes: null,
      percent: 0,
      lastCheckedAt: new Date().toISOString(),
      message: 'You have the latest verified version.'
    });
  });
  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
    publishUpdateState({ status: 'downloading', percent, message: `Downloading the verified update · ${percent}%` });
  });
  autoUpdater.on('update-downloaded', (info) => {
    publishUpdateState({
      status: 'downloaded',
      version: info.version,
      percent: 100,
      message: `Zap ${info.version} is verified and ready to install.`
    });
  });
  autoUpdater.on('error', (error) => {
    publishUpdateState({
      status: 'error',
      percent: 0,
      lastCheckedAt: new Date().toISOString(),
      message: safeUpdateError(error)
    });
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000);
  updateCheckTimer = setInterval(check, 6 * 60 * 60 * 1000);
  updateCheckTimer.unref?.();
}

async function getFrontmostApplication() {
  if (process.platform === 'win32') {
    try {
      const result = await execFileAsync('powershell.exe', windowsPowerShellArguments('Target'), { timeout: 5000 });
      const target = JSON.parse(result);
      if (!target || typeof target.name !== 'string' || !/^\d{1,20}$/.test(target.windowHandle || '')) return null;
      return { name: target.name.slice(0, 120) || 'previous app', windowHandle: target.windowHandle };
    } catch (_) {
      return null;
    }
  }
  if (process.platform !== 'darwin') return null;
  const script = [
    'tell application "System Events"',
    'set frontProcess to first application process whose frontmost is true',
    'set appName to name of frontProcess',
    'try',
    'set bundleId to bundle identifier of frontProcess',
    'on error',
    'set bundleId to ""',
    'end try',
    'return appName & "||" & bundleId',
    'end tell'
  ].join('\n');

  try {
    const result = await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 3000 });
    const [name, bundleId] = result.split('||');
    return { name: name || 'previous app', bundleId: bundleId || '' };
  } catch (_) {
    return null;
  }
}

async function restoreApplication(target) {
  if (process.platform === 'win32') {
    if (!/^\d{1,20}$/.test(target?.windowHandle || '')) return;
    try {
      await execFileAsync('powershell.exe', windowsPowerShellArguments('Restore', [
        '-WindowHandle', target.windowHandle
      ]), { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch (_) {}
    return;
  }
  if (process.platform === 'darwin' && target?.bundleId && /^[A-Za-z0-9.-]+$/.test(target.bundleId)) {
    try {
      await execFileAsync('/usr/bin/open', ['-b', target.bundleId], { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch (_) {}
  }
}

function runTypingProcess(file, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 120000, windowsHide: true }, (error) => {
      activeTypingProcess = null;
      if (error && !dripTypeCancelled) reject(error);
      else resolve();
    });
    activeTypingProcess = child;
    if (input) {
      child.stdin.on('error', () => {});
      child.stdin.end(input, 'utf8');
    }
  });
}

function cancelDripType() {
  dripTypeCancelled = true;
  if (activeTypingProcess) {
    try { activeTypingProcess.kill(); } catch (_) {}
    activeTypingProcess = null;
  }
  broadcastState({ status: 'cancelled', message: 'Typing stopped.' });
}

async function dripType(input, options = {}) {
  const text = cleanMarkdown(input);
  if (!text) return { error: 'Enter some text first.' };
  if ([...text].length > MAX_TEXT_LENGTH) return { error: 'Text is limited to 100,000 characters per run.' };
  if (dripTypeRunning) return { error: 'Zap is already running.' };

  if (!['darwin', 'win32'].includes(process.platform)) {
    clipboard.writeText(text);
    return { fallback: true, message: 'Automatic typing is unavailable on this operating system. The text was copied instead.' };
  }

  if (!isAccessibilityTrusted(false)) {
    return {
      error: 'Accessibility access is required before Zap can type into another app.',
      code: 'ACCESSIBILITY_REQUIRED'
    };
  }

  dripTypeCancelled = false;
  dripTypeRunning = true;

  try {
    if (options.target) await restoreApplication(options.target);

    const delaySeconds = Math.max(0, numberSetting('dripDelay', DEFAULTS.dripDelay));
    let lastRemaining = null;
    for (let waited = 0; waited < delaySeconds * 1000; waited += 100) {
      if (dripTypeCancelled) return { cancelled: true };
      const remaining = Math.max(1, Math.ceil(delaySeconds - waited / 1000));
      if (remaining !== lastRemaining) {
        broadcastState({
          status: 'waiting',
          remaining,
          targetName: options.target?.name || 'the selected app',
          message: `Typing starts in ${remaining}s`
        });
        lastRemaining = remaining;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const wpm = Math.max(1, numberSetting('dripWPM', DEFAULTS.dripWPM));
    const speed = Math.round(60000 / (wpm * 5));
    const typoRate = Math.max(0, numberSetting('typoRate', DEFAULTS.typoRate));
    const pauseChance = Math.max(0, numberSetting('dripPauseChance', DEFAULTS.dripPauseChance));
    const burstChance = Math.max(0, numberSetting('dripBurstChance', DEFAULTS.dripBurstChance));
    const steps = buildCharacterSteps(text, speed, typoRate, pauseChance, burstChance);
    const chunkSize = 40;

    broadcastState({ status: 'typing', progress: 0, message: 'Typing…' });

    for (let offset = 0; offset < steps.length; offset += chunkSize) {
      if (dripTypeCancelled) return { cancelled: true };

      const events = steps.slice(offset, offset + chunkSize).flat();
      if (!validateTypingEvents(events)) throw new Error('Invalid typing plan.');
      if (process.platform === 'darwin') {
        await runTypingProcess('/usr/bin/osascript', [], renderAppleScript(events));
      } else {
        await runTypingProcess('powershell.exe', windowsPowerShellArguments('Type'), JSON.stringify(events));
      }

      const completed = Math.min(offset + chunkSize, steps.length);
      broadcastState({
        status: 'typing',
        progress: Math.round((completed / steps.length) * 100),
        completed,
        total: steps.length,
        message: 'Typing…'
      });
    }

    broadcastState({ status: 'complete', progress: 100, message: 'Finished typing.' });
    return { success: true };
  } catch (error) {
    const message = /timed out|ETIMEDOUT/i.test(String(error?.message || ''))
      ? 'Typing stopped because the destination did not respond in time.'
      : process.platform === 'darwin'
        ? 'Typing could not be completed. Check macOS permissions and try again.'
        : 'Typing could not be completed. Confirm the destination app is focused and try again.';
    broadcastState({ status: 'error', message });
    return { error: message };
  } finally {
    dripTypeRunning = false;
    activeTypingProcess = null;
  }
}

function windowOptions({ backgroundWork = false } = {}) {
  return {
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !backgroundWork,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged
    }
  };
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  mainWindow = new BrowserWindow({
    ...windowOptions({ backgroundWork: true }),
    width: 1000,
    height: 740,
    minWidth: 820,
    minHeight: 600,
    title: 'Zap',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: process.platform === 'darwin' ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#202023' : '#f5f5f7'),
    vibrancy: process.platform === 'darwin' && !nativeTheme.prefersReducedTransparency ? 'sidebar' : undefined,
    visualEffectState: 'followWindow',
    show: false
  });

  protectWindow(mainWindow, 'index.html');
  const window = mainWindow;
  mainRecovery = keepWindowAvailable({
    window, isQuitting: () => quitting,
    loadPage: () => window.loadURL(appPageUrl('index.html')),
    onCrash: () => { cancelDripType(); zap.resetSession(); },
    onStatus: (status) => {
      if (['paused', 'stopped'].includes(status) && Notification.isSupported()) {
        new Notification({ title: 'Zap window needs attention', body: 'Window recovery stopped. Quit and reopen Zap. Interrupted work will not restart automatically.', silent: true }).show();
      }
    }
  });
  mainWindow.loadURL(appPageUrl('index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

function createQuickWindow() {
  if (quickWindow && !quickWindow.isDestroyed()) return quickWindow;

  quickWindow = new BrowserWindow({
    ...windowOptions(),
    width: 560,
    height: 350,
    minWidth: 480,
    minHeight: 300,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    movable: true,
    maximizable: true,
    fullscreenable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    vibrancy: process.platform === 'darwin' && !nativeTheme.prefersReducedTransparency ? 'under-window' : undefined,
    visualEffectState: 'followWindow',
    show: false
  });

  protectWindow(quickWindow, 'quick.html');
  quickWindow.loadURL(appPageUrl('quick.html'));
  quickWindow.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') quickWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quickWindow.on('enter-full-screen', () => {
    sendToWindow(quickWindow, 'quick:full-screen-changed', true);
  });
  quickWindow.on('leave-full-screen', () => {
    quickWindow.setAlwaysOnTop(true, 'floating');
    if (process.platform === 'darwin') quickWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    sendToWindow(quickWindow, 'quick:full-screen-changed', false);
  });
  quickWindow.on('closed', () => { quickWindow = null; });
  return quickWindow;
}

function createOnboardingWindow() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) return onboardingWindow;

  onboardingWindow = new BrowserWindow({
    ...windowOptions(),
    width: 800,
    height: 620,
    minWidth: 760,
    minHeight: 580,
    title: 'Welcome to Zap',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202023' : '#f5f5f7',
    resizable: false,
    show: false
  });

  protectWindow(onboardingWindow, 'onboarding.html');
  onboardingWindow.loadURL(appPageUrl('onboarding.html'));
  onboardingWindow.once('ready-to-show', () => onboardingWindow.show());
  onboardingWindow.on('closed', () => { onboardingWindow = null; });
  return onboardingWindow;
}

async function showQuickComposer() {
  if (dripTypeRunning) return;
  const access = currentBillingState();
  if (!access.allowed) {
    publishBillingState();
    navigateMainWindow({ page: 'billing' });
    return;
  }
  if (quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()) {
    quickWindow.focus();
    return;
  }
  if (process.platform === 'darwin') app.show();
  // Windows needs an explicit window handle for SendInput. On macOS the old,
  // more reliable workflow is manual focus after the composer disappears.
  quickTarget = process.platform === 'win32' ? await getFrontmostApplication() : null;
  const window = createQuickWindow();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  const [composerWidth] = window.getSize();
  window.setPosition(Math.round(x + (width - composerWidth) / 2), Math.round(y + height * 0.18));
  window.show();
  window.focus();
  const notifyOpened = () => sendToWindow(window, 'quick:opened', {
    targetName: quickTarget?.name || 'previous app',
    settings: publicSettings(),
    features: access.features
  });
  if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', notifyOpened);
  else notifyOpened();
}

function showMainWindow() {
  if (process.platform === 'darwin') app.show();
  const window = createMainWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

function navigateMainWindow(target) {
  const window = showMainWindow();
  const navigate = () => sendToWindow(window, 'app:navigate', target);
  if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', navigate);
  else navigate();
  return window;
}

function showUpdatesPage() {
  navigateMainWindow({ page: 'setup', focus: 'updates' });
}

function attemptShortcutRegistration(pair) {
  return registerShortcutPair(globalShortcut, pair, {
    openComposer: showQuickComposer,
    stopTyping: cancelDripType
  });
}

function storedShortcutPair() {
  return {
    hotkeyStart: store.get('hotkeyStart', DEFAULTS.hotkeyStart),
    hotkeyStop: store.get('hotkeyStop', DEFAULTS.hotkeyStop)
  };
}

function registerStoredShortcuts() {
  const current = storedShortcutPair();
  const validated = validateShortcutPair(current.hotkeyStart, current.hotkeyStop);
  if (validated.error) return { success: false, failures: [validated.error] };
  return attemptShortcutRegistration(validated);
}

function updateShortcuts(settings = {}) {
  const previous = storedShortcutPair();
  const requested = {
    hotkeyStart: Object.prototype.hasOwnProperty.call(settings, 'hotkeyStart')
      ? settings.hotkeyStart : previous.hotkeyStart,
    hotkeyStop: Object.prototype.hasOwnProperty.call(settings, 'hotkeyStop')
      ? settings.hotkeyStop : previous.hotkeyStop
  };
  if (Object.values(requested).some((value) => zap.conflicts(value))) {
    return { success: false, failures: ['That shortcut opens Zap. Change the Zap shortcut first.'] };
  }
  const replacement = replaceShortcutPair(globalShortcut, previous, requested, {
    openComposer: showQuickComposer,
    stopTyping: cancelDripType
  });
  if (!replacement.success) return replacement;

  store.set('hotkeyStart', replacement.settings.hotkeyStart);
  store.set('hotkeyStop', replacement.settings.hotkeyStop);
  return replacement;
}

function createTray() {
  const isMac = process.platform === 'darwin';
  const iconPath = path.join(__dirname, '..', 'assets', isMac ? 'trayTemplate.png' : 'icon.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (isMac) {
    icon.setTemplateImage(true);
  } else if (!icon.isEmpty()) {
    icon = icon.resize({ width: 18, height: 18 });
  }
  tray = new Tray(icon);
  tray.setToolTip('Zap');
  createTrayMenuOnly();
  tray.on('click', showMainWindow);
}

function createApplicationMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: showUpdatesPage },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: () => navigateMainWindow({ page: 'setup' }) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }, { type: 'separator' }, { role: 'togglefullscreen' }]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

handleTrusted('drip-type:start', ['index.html', 'quick.html'], async (event, text) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const startedFromQuickComposer = senderWindow === quickWindow;
  if (!currentBillingState().allowed) {
    return { error: 'A Core subscription is required to start typing.', code: 'SUBSCRIPTION_REQUIRED' };
  }
  if (!cleanMarkdown(text)) return { error: 'Enter some text first.' };
  if (typeof text !== 'string' || [...text].length > MAX_TEXT_LENGTH) {
    return { error: 'Text is limited to 100,000 characters per run.' };
  }
  if (process.platform === 'darwin' && !isAccessibilityTrusted(false)) {
    return { error: 'Enable Accessibility access before typing.', code: 'ACCESSIBILITY_REQUIRED' };
  }
  if (process.platform === 'darwin' && !await isAutomationTrusted()) {
    return { error: 'Allow Automation access for System Events before typing.', code: 'AUTOMATION_REQUIRED' };
  }
  if (startedFromQuickComposer) quickWindow.hide();
  if (senderWindow === mainWindow) mainWindow.hide();
  // Match the original Zap workflow on macOS: disappear completely and
  // let the user click the exact web field during the countdown. Reopening a
  // browser by bundle ID can restore the app while losing focus inside rich or
  // paste-restricted editors such as Google Forms and Turnitin.
  if (process.platform === 'darwin') app.hide();
  const target = process.platform === 'win32' && startedFromQuickComposer ? quickTarget : null;
  const result = await dripType(text, { target });
  if (result?.error && senderWindow && !senderWindow.isDestroyed()) {
    if (process.platform === 'darwin') app.show();
    senderWindow.show();
    senderWindow.focus();
  }
  return result;
});

handleTrusted('clipboard:read-text', ['quick.html'], () => (
  clipboard.readText().slice(0, MAX_TEXT_LENGTH)
));
handleTrusted('clipboard:write-text', ['index.html'], (_event, value) => {
  const text = typeof value === 'string' ? value.slice(0, MAX_TEXT_LENGTH) : '';
  if (!text) return { error: 'There is no text to copy.' };
  clipboard.writeText(text);
  return { success: true };
});
handleTrusted('appearance:get', ['index.html', 'quick.html', 'onboarding.html', 'zap-pin.html'], currentAppearance);
onTrusted('drip-type:cancel', ['index.html', 'quick.html'], cancelDripType);
onTrusted('quick:show', ['index.html'], showQuickComposer);
onTrusted('quick:close', ['quick.html'], () => quickWindow?.hide());
onTrusted('main:show', ['quick.html'], showMainWindow);
handleTrusted('quick:toggle-full-screen', ['quick.html'], () => {
  if (!quickWindow || quickWindow.isDestroyed()) return { fullScreen: false };
  const next = !quickWindow.isFullScreen();
  if (next) quickWindow.setAlwaysOnTop(false);
  quickWindow.setFullScreen(next);
  return { fullScreen: next };
});
onTrusted('onboarding:replay', ['index.html'], () => {
  mainWindow?.hide();
  createOnboardingWindow();
});

handleTrusted('onboarding:complete', ['onboarding.html'], async (_event, settings = {}) => {
  const permissions = await permissionChecklist();
  const missing = [];
  if (!permissions.accessibility) missing.push('Accessibility');
  if (!permissions.automation) missing.push('Automation');
  if (missing.length) return { success: false, missing, permissions };
  applySettings(settings);
  store.set('onboardingDone', true);
  configureLoginItem();
  registerStoredShortcuts();
  onboardingWindow?.close();
  showMainWindow();
  return { success: true };
});

handleTrusted('settings:get', ['index.html', 'onboarding.html'], () => publicSettings());
handleTrusted('settings:save', ['index.html'], (_event, settings) => {
  const hasShortcutChange = ['hotkeyStart', 'hotkeyStop']
    .some((key) => Object.prototype.hasOwnProperty.call(settings || {}, key));
  const shortcutResult = hasShortcutChange ? updateShortcuts(settings) : null;
  applySettings(settings);
  if (Object.prototype.hasOwnProperty.call(settings || {}, 'launchAtLogin')) configureLoginItem();
  if (tray) createTrayMenuOnly();
  return {
    settings: publicSettings(),
    shortcutSuccess: shortcutResult ? shortcutResult.success : true,
    shortcutFailures: shortcutResult?.failures || []
  };
});

function createTrayMenuOnly() {
  const updateLabel = updateState.status === 'available'
    ? `Download Zap ${updateState.version}…`
    : updateState.status === 'downloaded'
      ? `Restart to Install ${updateState.version}…`
      : updateState.status === 'downloading'
        ? `Downloading Update (${Math.round(updateState.percent || 0)}%)…`
        : 'Check for Updates…';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Drip Type', accelerator: store.get('hotkeyStart'), click: showQuickComposer },
    { label: 'Zap AI Workspace', click: () => navigateMainWindow({ page: 'zap', focus: 'zap-input' }) },
    { label: 'Open Zap', click: showMainWindow },
    { label: updateLabel, click: showUpdatesPage },
    { type: 'separator' },
    { label: 'Stop Typing', accelerator: store.get('hotkeyStop'), click: cancelDripType },
    { type: 'separator' },
    { label: 'Quit Zap', role: 'quit' }
  ]));
}

handleTrusted('accessibility:get', ['index.html', 'onboarding.html'], () => isAccessibilityTrusted(false));
handleTrusted('accessibility:request', ['index.html', 'onboarding.html'], async () => {
  const trusted = isAccessibilityTrusted(true);
  if (!trusted && process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  }
  return trusted;
});
handleTrusted('permissions:get', ['index.html', 'onboarding.html'], () => permissionChecklist());
handleTrusted('automation:request', ['index.html', 'onboarding.html'], async () => {
  store.set('automationPermissionChecked', true);
  const trusted = await isAutomationTrusted();
  if (!trusted && process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
  }
  return permissionChecklist();
});
handleTrusted('app:get-info', ['index.html', 'onboarding.html'], () => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform,
  appId: APP_ID
}));
handleTrusted('billing:get-state', ['index.html'], () => currentBillingState());
handleTrusted('billing:refresh', ['index.html'], () => refreshEntitlement());
handleTrusted('billing:subscribe', ['index.html'], () => accountSession.beginSignIn());
handleTrusted('account:sign-in', ['index.html'], () => accountSession.beginSignIn());
handleTrusted('account:sign-out', ['index.html'], () => accountSession.signOut());
handleTrusted('account:open', ['index.html'], () => shell.openExternal(`${BILLING_ORIGIN}/account`));
handleTrusted('billing:portal', ['index.html'], async () => {
  const revision = accountSession.revision();
  const { refreshToken } = await accountSession.credentials();
  if (!refreshToken) return { error: 'Activate a subscription before opening billing.' };
  try {
    const result = await billingRequest('/api/create-portal', {
      refreshToken,
      deviceId: ensureDeviceId()
    });
    if (revision !== accountSession.revision()) return { error: 'Your account changed. Open billing again.' };
    if (!/^https:\/\/billing\.stripe\.com\//.test(result.url || '')) {
      throw new Error('Billing portal URL was rejected.');
    }
    await shell.openExternal(result.url);
    return { success: true };
  } catch (error) {
    if (revision !== accountSession.revision()) return { error: 'Your account changed. Open billing again.' };
    if (shouldRevokeEntitlement(error.status)) await revokeBillingAccess(error.message);
    return { error: error.message || 'Billing portal could not be opened.' };
  }
});
handleTrusted('updater:get-state', ['index.html'], () => ({ ...updateState }));
handleTrusted('updater:check', ['index.html'], async () => {
  if (!app.isPackaged || !['darwin', 'win32'].includes(process.platform)) return { status: 'development' };
  try {
    await autoUpdater.checkForUpdates();
    return { ...updateState };
  } catch (error) {
    publishUpdateState({ status: 'error', message: safeUpdateError(error) });
    return { ...updateState };
  }
});
handleTrusted('updater:download', ['index.html'], async () => {
  if (updateState.status !== 'available') return { ...updateState };
  publishUpdateState({ status: 'downloading', percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (_) {
    publishUpdateState({ status: 'error', message: 'The verified update could not be downloaded.' });
  }
  return { ...updateState };
});
onTrusted('updater:install', ['index.html'], () => {
  if (updateState.status === 'downloaded') setImmediate(() => { prepareToQuit(); autoUpdater.quitAndInstall(false, true); });
});

app.setAsDefaultProtocolClient(BILLING_SCHEME);

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (!app.isReady()) pendingActivationUrl = url;
  else handleActivationUrl(url);
});

app.on('second-instance', (_event, commandLine) => {
  const activationUrl = commandLine.find((argument) => argument.startsWith(`${BILLING_SCHEME}://`));
  if (activationUrl) {
    handleActivationUrl(activationUrl);
    return;
  }
  if (dripTypeRunning) return;
  showQuickComposer();
});

const zap = installZap({
  store, getCredentials: () => accountSession.credentials(),
  handleTrusted, onTrusted, windowOptions, protectWindow, appPageUrl,
  navigate: navigateMainWindow, isTyping: () => dripTypeRunning, getTypingShortcuts: storedShortcutPair
});

const accountSession = createAccountSession({
  store, deviceId: ensureDeviceId, readCredential: readRefreshCredential,
  saveCredential: saveRefreshCredential, deleteCredential: deleteRefreshCredential,
  request: billingRequest, validateEntitlement: verifyEntitlement, publish: publishBillingState,
  openBrowser: (url) => shell.openExternal(url),
  onSignOut: () => {
    pendingActivationUrl = null;
    cancelDripType();
    zap.resetSession();
    store.set('zapSettings', { ...store.get('zapSettings', {}), context: '' });
    quickWindow?.close();
    sendToWindow(mainWindow, 'account:signed-out', {});
  }
});

app.whenReady().then(async () => {
  publishTheme();
  nativeTheme.on('updated', () => publishTheme());
  await retireLegacyTrialState();
  registerAppProtocol();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true })
  );
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
  createApplicationMenu();
  createQuickWindow();
  createTray();
  registerStoredShortcuts();
  zap.start();
  configureLoginItem();
  configureUpdater();
  currentBillingState();
  refreshEntitlement({ silent: true });
  entitlementRefreshTimer = setInterval(() => refreshEntitlement({ silent: true }), 12 * 60 * 60 * 1000);
  if (pendingActivationUrl) {
    const url = pendingActivationUrl;
    pendingActivationUrl = null;
    handleActivationUrl(url);
  }
  const openedAtLogin = ['darwin', 'win32'].includes(process.platform)
    && app.getLoginItemSettings().wasOpenedAtLogin;
  if (!store.get('onboardingDone')) createOnboardingWindow();
  else if (!openedAtLogin) createMainWindow();
});

app.on('activate', () => {
  if (store.get('onboardingDone')) showMainWindow();
  else createOnboardingWindow();
});
function prepareToQuit() {
  quitting = true;
  mainRecovery?.stop();
}
app.on('before-quit', prepareToQuit);
nativeUpdater.on('before-quit-for-update', prepareToQuit);
app.on('will-quit', () => {
  prepareToQuit();
  zap.stop();
  cancelDripType();
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (entitlementRefreshTimer) clearInterval(entitlementRefreshTimer);
  globalShortcut.unregisterAll();
});
app.on('window-all-closed', () => {
  if (!['darwin', 'win32'].includes(process.platform)) app.quit();
});
