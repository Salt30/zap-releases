const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  globalShortcut,
  ipcMain,
  clipboard,
  nativeImage,
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
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { accessState, shouldRevokeEntitlement, verifyEntitlement } = require('./subscription');
const { renderBatch, searchClipboard, transformWriting } = require('./pro-tools');
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
const TRIAL_KEYCHAIN_SERVICE = 'com.salt30.driptype.trial';
const USER_VAULT_KEY = 'encryptedUserVault';
const MAX_USER_VAULT_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_LENGTH = 100000;
const MAX_CORE_TEMPLATE_COUNT = 50;
const MAX_PRO_TEMPLATE_COUNT = 250;
const MAX_TEMPLATE_NAME_LENGTH = 60;
const MAX_TEMPLATE_BODY_LENGTH = 20000;
const MAX_PROFILE_COUNT = 20;
const MAX_CLIPBOARD_COUNT = 200;
const MAX_CLIPBOARD_ITEM_LENGTH = 20000;
const APP_SCHEME = 'drip';
const APP_HOST = 'app';
const APP_RESOURCES = new Set([
  'index.html', 'index.js', 'quick.html', 'quick.js',
  'onboarding.html', 'onboarding.js', 'zap-icon.svg',
  'zap-wordmark-dark.svg', 'zap-wordmark-light.svg'
]);
const DEFAULT_TEMPLATES = [
  {
    id: 'starter-follow-up',
    name: 'Friendly follow-up',
    body: 'Hi {{name}},\n\nJust following up on {{topic}}. When you have a moment, could you let me know the best next step?\n\nThanks,\n{{sender}}'
  },
  {
    id: 'starter-status',
    name: 'Project status',
    body: 'Status: {{project}}\n\nCompleted\n• {{completed}}\n\nNext\n• {{next}}\n\nBlockers\n• {{blockers}}'
  },
  {
    id: 'starter-meeting',
    name: 'Meeting recap',
    body: 'Hi {{name}},\n\nHere is a quick recap of {{meeting}}:\n\nDecisions\n• {{decisions}}\n\nNext steps\n• {{next_steps}}\n\nBest,\n{{sender}}'
  }
];
const PRO_TEMPLATE_LIBRARY = [
  { id: 'pro-sales-intro', name: 'Warm introduction', category: 'Sales', tags: ['intro', 'outreach'], body: 'Hi {{name}},\n\nI noticed {{relevant_detail}} and thought {{offering}} could help with {{goal}}. Would {{time_option}} work for a quick conversation?\n\nBest,\n{{sender}}' },
  { id: 'pro-support-update', name: 'Support update', category: 'Support', tags: ['status', 'customer'], body: 'Hi {{name}},\n\nHere is the latest on {{issue}}:\n\n• Current status: {{status}}\n• Next action: {{next_action}}\n• Expected update: {{next_update}}\n\nThanks for your patience,\n{{sender}}' },
  { id: 'pro-recruiting-followup', name: 'Candidate follow-up', category: 'Recruiting', tags: ['candidate', 'follow-up'], body: 'Hi {{name}},\n\nThank you for taking the time to discuss the {{role}} role. The team especially appreciated {{highlight}}. We will follow up with {{next_step}} by {{date}}.\n\nBest,\n{{sender}}' },
  { id: 'pro-project-brief', name: 'Project brief', category: 'Operations', tags: ['brief', 'project'], body: 'Project: {{project}}\nOwner: {{owner}}\nOutcome: {{outcome}}\nDeadline: {{deadline}}\n\nScope\n• {{scope}}\n\nRisks\n• {{risks}}\n\nNext milestone\n• {{milestone}}' },
  { id: 'pro-meeting-agenda', name: 'Decision agenda', category: 'Meetings', tags: ['agenda', 'decision'], body: 'Meeting: {{meeting}}\nDecision needed: {{decision}}\n\nContext\n{{context}}\n\nOptions\n• {{option_one}}\n• {{option_two}}\n\nOwner / next step\n{{owner}} — {{next_step}}' }
];
const DEFAULT_PROFILE = {
  id: 'profile-default', name: 'Natural', dripWPM: 45, dripDelay: 3,
  typoRate: 0.03, dripPauseChance: 0.03, dripBurstChance: 0.08
};
const DEFAULTS = {
  dripWPM: 45,
  dripDelay: 3,
  typoRate: 0.03,
  dripPauseChance: 0.03,
  dripBurstChance: 0.08,
  hotkeyStart: 'Alt+5',
  hotkeyStop: 'Alt+0',
  shortcutDefaultsMigratedToOption5: false,
  launchAtLogin: true,
  theme: 'system',
  activeProfileId: DEFAULT_PROFILE.id,
  encryptedUserVault: '',
  deviceId: null,
  trialStartedAt: null,
  entitlementToken: '',
  encryptedRefreshCredential: '',
  encryptedTrialStartedAt: '',
  paidAccessSeen: false,
  automationPermissionChecked: false,
  onboardingDone: false
};

const store = new Store({ defaults: DEFAULTS });

// Existing installs keep electron-store values across upgrades. Migrate the
// former default once, then preserve every shortcut the user chooses — even ⌥4.
if (!store.get('shortcutDefaultsMigratedToOption5', false)) {
  const previous = normalizeAccelerator(store.get('hotkeyStart'));
  if (previous.accelerator === 'Alt+4') store.set('hotkeyStart', DEFAULTS.hotkeyStart);
  store.set('shortcutDefaultsMigratedToOption5', true);
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

function defaultUserVault() {
  return {
    version: 1,
    templates: DEFAULT_TEMPLATES.map((template) => ({ ...template })),
    profiles: [{ ...DEFAULT_PROFILE }],
    clipboardWorkspace: []
  };
}

function readUserVault() {
  const decrypted = readProtectedStoreValue(USER_VAULT_KEY);
  if (!decrypted || Buffer.byteLength(decrypted, 'utf8') > MAX_USER_VAULT_BYTES) return null;
  try {
    const vault = JSON.parse(decrypted);
    if (!vault || typeof vault !== 'object' || Array.isArray(vault) || vault.version !== 1) return null;
    if (!Array.isArray(vault.templates) || !Array.isArray(vault.profiles) || !Array.isArray(vault.clipboardWorkspace)) {
      return null;
    }
    return vault;
  } catch (_) {
    return null;
  }
}

function currentUserVault() {
  return readUserVault() || defaultUserVault();
}

function writeUserVault(vault) {
  const serialized = JSON.stringify(vault);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_USER_VAULT_BYTES) {
    throw new Error('Private local data exceeds the secure storage limit.');
  }
  writeProtectedStoreValue(USER_VAULT_KEY, serialized);
}

function migrateUserVault() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const encrypted = String(store.get(USER_VAULT_KEY, '') || '');
  if (encrypted) {
    if (!readUserVault()) return false;
  } else {
    const legacyTemplates = store.get('templates');
    const legacyProfiles = store.get('profiles');
    const legacyClipboard = store.get('clipboardWorkspace');
    writeUserVault({
      version: 1,
      templates: Array.isArray(legacyTemplates) ? legacyTemplates : DEFAULT_TEMPLATES,
      profiles: Array.isArray(legacyProfiles) ? legacyProfiles : [DEFAULT_PROFILE],
      clipboardWorkspace: Array.isArray(legacyClipboard) ? legacyClipboard : []
    });
  }
  store.delete('templates');
  store.delete('profiles');
  store.delete('clipboardWorkspace');
  return true;
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

function ensureTrialStartedAt() {
  const current = Number(store.get('trialStartedAt'));
  if (Number.isFinite(current) && current > 0) return current;
  const value = Date.now();
  store.set('trialStartedAt', value);
  return value;
}

async function synchronizeTrialStartedAt() {
  let protectedStart = 0;
  if (process.platform === 'darwin') {
    try {
      const value = await execFileAsync('/usr/bin/security', [
        'find-generic-password', '-a', APP_ID, '-s', TRIAL_KEYCHAIN_SERVICE, '-w'
      ]);
      if (/^\d{13}$/.test(value)) protectedStart = Number(value);
    } catch (_) {}
  } else if (process.platform === 'win32') {
    const value = readProtectedStoreValue('encryptedTrialStartedAt');
    if (/^\d{13}$/.test(value)) protectedStart = Number(value);
  }

  const storedStart = Number(store.get('trialStartedAt'));
  const candidates = [protectedStart, storedStart].filter((value) => Number.isFinite(value) && value > 0);
  const trialStartedAt = candidates.length ? Math.min(...candidates) : Date.now();
  store.set('trialStartedAt', trialStartedAt);

  if (protectedStart !== trialStartedAt) {
    try {
      if (process.platform === 'win32') {
        writeProtectedStoreValue('encryptedTrialStartedAt', String(trialStartedAt));
      } else if (process.platform === 'darwin') {
      await execFileAsync('/usr/bin/security', [
        'add-generic-password', '-U', '-a', APP_ID, '-s', TRIAL_KEYCHAIN_SERVICE,
        '-w', String(trialStartedAt)
      ]);
      }
    } catch (_) {}
  }
  return trialStartedAt;
}

function currentBillingState() {
  billingState = accessState({
    token: store.get('entitlementToken'),
    deviceId: ensureDeviceId(),
    trialStartedAt: store.get('paidAccessSeen') ? 0 : ensureTrialStartedAt()
  });
  return { ...billingState };
}

function hasFeature(feature) {
  return currentBillingState().features.includes(feature);
}

function proRequired(feature) {
  if (hasFeature(feature)) return null;
  return { error: 'Drip Type Pro is required for this feature.', code: 'PRO_REQUIRED' };
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
    ]);
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
  ]);
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
    ]);
  } catch (_) {}
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
  store.set('paidAccessSeen', true);
  return publishBillingState();
}

async function revokeBillingAccess(message) {
  store.set('entitlementToken', '');
  store.set('paidAccessSeen', true);
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
  const refreshToken = await readRefreshCredential();
  if (!refreshToken) return publishBillingState();
  try {
    const result = await billingRequest('/api/refresh-entitlement', {
      refreshToken,
      deviceId: ensureDeviceId()
    });
    return acceptEntitlement(result);
  } catch (error) {
    if (shouldRevokeEntitlement(error.status)) {
      return revokeBillingAccess(error.message);
    }
    const current = currentBillingState();
    if (!silent || !current.allowed) {
      return publishBillingState({ message: error.message || 'Subscription could not be refreshed.' });
    }
    return current;
  }
}

async function activateAccountToken(activationToken) {
  if (typeof activationToken !== 'string' || activationToken.length > 2048 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(activationToken)) {
    throw new Error('Invalid account connection link');
  }
  const result = await billingRequest('/api/claim-account-entitlement', {
    activationToken,
    deviceId: ensureDeviceId()
  });
  await saveRefreshCredential(result.refreshToken);
  const state = acceptEntitlement(result);
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
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    const resource = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (request.method !== 'GET' || url.hostname !== APP_HOST || !APP_RESOURCES.has(resource)) {
      return new Response('Not found', { status: 404 });
    }
    const localPath = resource.startsWith('zap-')
      ? path.join(__dirname, '..', 'assets', 'brand', 'zap', 'logo', resource)
      : path.join(__dirname, resource);
    return net.fetch(pathToFileURL(localPath).href);
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
    return 'Drip Type could not reach the update service. Check your connection and try again.';
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
    title: `Drip Type ${info.version} is available`,
    body: 'Open Drip Type to review what’s new and download the verified update.',
    silent: true
  });
  notification.on('click', showUpdatesPage);
  notification.show();
}

function senderPage(event) {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  try {
    const parsed = new URL(senderUrl);
    if (parsed.protocol !== `${APP_SCHEME}:` || parsed.hostname !== APP_HOST) return null;
    return path.basename(decodeURIComponent(parsed.pathname));
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

function sanitizeTemplate(template, existingId = null) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) return null;
  const name = typeof template.name === 'string' ? template.name.trim().slice(0, MAX_TEMPLATE_NAME_LENGTH) : '';
  const body = typeof template.body === 'string'
    ? template.body.replace(/\r\n?/g, '\n').slice(0, MAX_TEMPLATE_BODY_LENGTH)
    : '';
  if (!name || !body.trim()) return null;
  const requestedId = typeof template.id === 'string' ? template.id : '';
  const id = existingId || (/^[A-Za-z0-9-]{1,80}$/.test(requestedId) ? requestedId : `template-${randomUUID()}`);
  const category = typeof template.category === 'string' ? template.category.trim().slice(0, 40) : '';
  const tags = Array.isArray(template.tags)
    ? [...new Set(template.tags.map((tag) => String(tag).trim().slice(0, 30)).filter(Boolean))].slice(0, 8)
    : [];
  return { id, name, body, category, tags, favorite: Boolean(template.favorite) };
}

function listTemplates() {
  const templates = currentUserVault().templates;
  if (!Array.isArray(templates)) return DEFAULT_TEMPLATES.map((template) => ({ ...template }));
  return templates.slice(0, hasFeature('template_library') ? MAX_PRO_TEMPLATE_COUNT : MAX_CORE_TEMPLATE_COUNT)
    .map((template) => sanitizeTemplate(template, template?.id))
    .filter(Boolean);
}

function saveTemplate(input) {
  const templates = listTemplates();
  const requestedId = typeof input?.id === 'string' ? input.id : '';
  const index = requestedId ? templates.findIndex((template) => template.id === requestedId) : -1;
  const limit = hasFeature('template_library') ? MAX_PRO_TEMPLATE_COUNT : MAX_CORE_TEMPLATE_COUNT;
  if (index < 0 && templates.length >= limit) {
    return { error: `Template limit reached (${limit}).`, templates };
  }
  const template = sanitizeTemplate(input, index >= 0 ? templates[index].id : null);
  if (!template) return { error: 'Add a template name and body.', templates };
  if (index >= 0) templates[index] = template;
  else templates.unshift(template);
  try {
    writeUserVault({ ...currentUserVault(), templates });
  } catch (_) {
    return { error: 'Templates could not be saved securely.', templates: listTemplates() };
  }
  return { template, templates };
}

function installProTemplateLibrary() {
  const blocked = proRequired('template_library');
  if (blocked) return { ...blocked, templates: listTemplates() };
  const templates = listTemplates();
  const existing = new Set(templates.map((template) => template.id));
  const additions = PRO_TEMPLATE_LIBRARY.filter((template) => !existing.has(template.id));
  const merged = [...additions, ...templates].slice(0, MAX_PRO_TEMPLATE_COUNT).map((template) => sanitizeTemplate(template, template.id));
  try {
    writeUserVault({ ...currentUserVault(), templates: merged });
  } catch (_) {
    return { error: 'The template library could not be saved securely.', templates: listTemplates() };
  }
  return { success: true, installed: additions.length, templates: merged };
}

function sanitizeProfile(input, existingId = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 40) : '';
  if (!name) return null;
  const id = existingId || (/^[A-Za-z0-9-]{1,80}$/.test(input.id || '') ? input.id : `profile-${randomUUID()}`);
  const bounds = { dripWPM: [15, 240], dripDelay: [0, 30], typoRate: [0, 0.5], dripPauseChance: [0, 0.5], dripBurstChance: [0, 0.5] };
  const profile = { id, name };
  for (const [key, [minimum, maximum]] of Object.entries(bounds)) {
    const value = Number(input[key]);
    profile[key] = Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : DEFAULT_PROFILE[key];
  }
  return profile;
}

function listProfiles() {
  const values = currentUserVault().profiles;
  const profiles = (Array.isArray(values) ? values : [DEFAULT_PROFILE]).slice(0, MAX_PROFILE_COUNT)
    .map((profile) => sanitizeProfile(profile, profile?.id)).filter(Boolean);
  return profiles.length ? profiles : [{ ...DEFAULT_PROFILE }];
}

function saveProfile(input) {
  const blocked = proRequired('profiles');
  if (blocked) return { ...blocked, profiles: listProfiles() };
  const profiles = listProfiles();
  const index = profiles.findIndex((profile) => profile.id === input?.id);
  if (index < 0 && profiles.length >= MAX_PROFILE_COUNT) return { error: `Profile limit reached (${MAX_PROFILE_COUNT}).`, profiles };
  const profile = sanitizeProfile(input, index >= 0 ? profiles[index].id : null);
  if (!profile) return { error: 'Add a profile name.', profiles };
  if (index >= 0) profiles[index] = profile; else profiles.unshift(profile);
  try {
    writeUserVault({ ...currentUserVault(), profiles });
  } catch (_) {
    return { error: 'Profiles could not be saved securely.', profiles: listProfiles() };
  }
  return { profile, profiles };
}

function activateProfile(id) {
  const blocked = proRequired('profiles');
  if (blocked) return { ...blocked, profiles: listProfiles() };
  const profile = listProfiles().find((item) => item.id === id);
  if (!profile) return { error: 'Profile not found.', profiles: listProfiles() };
  applySettings(profile);
  store.set('activeProfileId', profile.id);
  return { success: true, activeProfileId: profile.id, profile, profiles: listProfiles() };
}

function deleteProfile(id) {
  const blocked = proRequired('profiles');
  if (blocked) return { ...blocked, profiles: listProfiles() };
  const profiles = listProfiles();
  if (profiles.length === 1) return { error: 'Keep at least one profile.', profiles };
  const filtered = profiles.filter((profile) => profile.id !== id);
  if (filtered.length === profiles.length) return { error: 'Profile not found.', profiles };
  try {
    writeUserVault({ ...currentUserVault(), profiles: filtered });
  } catch (_) {
    return { error: 'Profiles could not be updated securely.', profiles: listProfiles() };
  }
  if (store.get('activeProfileId') === id) store.set('activeProfileId', filtered[0].id);
  return { success: true, activeProfileId: store.get('activeProfileId'), profiles: filtered };
}

function sanitizeClipboardItem(item) {
  if (!item || typeof item !== 'object') return null;
  const text = typeof item.text === 'string' ? item.text.replace(/\r\n?/g, '\n').slice(0, MAX_CLIPBOARD_ITEM_LENGTH) : '';
  if (!text.trim()) return null;
  return {
    id: /^[A-Za-z0-9-]{1,80}$/.test(item.id || '') ? item.id : `clip-${randomUUID()}`,
    text,
    pinned: Boolean(item.pinned),
    createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now()
  };
}

function listClipboardItems(query = '') {
  const storedItems = currentUserVault().clipboardWorkspace;
  const items = (Array.isArray(storedItems) ? storedItems : [])
    .slice(0, MAX_CLIPBOARD_COUNT).map(sanitizeClipboardItem).filter(Boolean)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt);
  return searchClipboard(items, query);
}

function captureClipboardItem() {
  const blocked = proRequired('clipboard');
  if (blocked) return { ...blocked, items: [] };
  const item = sanitizeClipboardItem({ text: clipboard.readText(), createdAt: Date.now() });
  if (!item) return { error: 'The clipboard has no text to save.', items: listClipboardItems() };
  const items = [item, ...listClipboardItems().filter((existing) => existing.text !== item.text)].slice(0, MAX_CLIPBOARD_COUNT);
  try {
    writeUserVault({ ...currentUserVault(), clipboardWorkspace: items });
  } catch (_) {
    return { error: 'Clipboard history could not be saved securely.', items: listClipboardItems() };
  }
  return { item, items };
}

function updateClipboardItem(id, action) {
  const blocked = proRequired('clipboard');
  if (blocked) return { ...blocked, items: [] };
  let items = listClipboardItems();
  const item = items.find((entry) => entry.id === id);
  if (!item) return { error: 'Clipboard item not found.', items };
  if (action === 'delete') items = items.filter((entry) => entry.id !== id);
  else if (action === 'pin') item.pinned = !item.pinned;
  else return { error: 'Invalid clipboard action.', items };
  try {
    writeUserVault({ ...currentUserVault(), clipboardWorkspace: items });
  } catch (_) {
    return { error: 'Clipboard history could not be updated securely.', items: listClipboardItems() };
  }
  return { success: true, items: listClipboardItems() };
}

function deleteTemplate(id) {
  if (typeof id !== 'string') return { error: 'Invalid template.', templates: listTemplates() };
  const templates = listTemplates();
  const filtered = templates.filter((template) => template.id !== id);
  if (filtered.length === templates.length) return { error: 'Template not found.', templates };
  try {
    writeUserVault({ ...currentUserVault(), templates: filtered });
  } catch (_) {
    return { error: 'Templates could not be updated securely.', templates: listTemplates() };
  }
  return { success: true, templates: filtered };
}

function configureLoginItem() {
  if (!app.isPackaged || !['darwin', 'win32'].includes(process.platform)) return;
  const settings = { openAtLogin: store.get('launchAtLogin', DEFAULTS.launchAtLogin) };
  if (process.platform === 'darwin') settings.openAsHidden = true;
  app.setLoginItemSettings(settings);
}

function publishTheme(theme = store.get('theme', DEFAULTS.theme)) {
  for (const window of [mainWindow, quickWindow, onboardingWindow]) {
    sendToWindow(window, 'theme:changed', { theme });
  }
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
      releaseName: info.releaseName || `Drip Type ${info.version}`,
      releaseNotes: plainReleaseNotes(info.releaseNotes),
      percent: 0,
      lastCheckedAt: new Date().toISOString(),
      message: `Drip Type ${info.version} is ready to download.`
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
      message: `Drip Type ${info.version} is verified and ready to install.`
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
  if (dripTypeRunning) return { error: 'Drip Type is already running.' };

  if (!['darwin', 'win32'].includes(process.platform)) {
    clipboard.writeText(text);
    return { fallback: true, message: 'Automatic typing is unavailable on this operating system. The text was copied instead.' };
  }

  if (!isAccessibilityTrusted(false)) {
    return {
      error: 'Accessibility access is required before Drip Type can type into another app.',
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

function windowOptions() {
  return {
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged
    }
  };
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  mainWindow = new BrowserWindow({
    ...windowOptions(),
    width: 940,
    height: 680,
    minWidth: 820,
    minHeight: 600,
    title: 'Drip Type',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0d0f13',
    vibrancy: process.platform === 'darwin' ? 'sidebar' : undefined,
    visualEffectState: 'active',
    show: false
  });

  protectWindow(mainWindow, 'index.html');
  mainWindow.loadURL(appPageUrl('index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

function createQuickWindow() {
  if (quickWindow && !quickWindow.isDestroyed()) return quickWindow;

  quickWindow = new BrowserWindow({
    ...windowOptions(),
    width: 720,
    height: 430,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    vibrancy: process.platform === 'darwin' ? 'hud' : undefined,
    visualEffectState: 'active',
    show: false
  });

  protectWindow(quickWindow, 'quick.html');
  quickWindow.loadURL(appPageUrl('quick.html'));
  quickWindow.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') quickWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
    title: 'Welcome to Drip Type',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0d0f13',
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
  quickTarget = await getFrontmostApplication();
  const window = createQuickWindow();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  const [composerWidth] = window.getSize();
  window.setPosition(Math.round(x + (width - composerWidth) / 2), Math.round(y + height * 0.18));
  window.show();
  window.focus();
  sendToWindow(window, 'quick:opened', {
    targetName: quickTarget?.name || 'previous app',
    settings: publicSettings(),
    templates: listTemplates(),
    features: access.features
  });
}

function showMainWindow() {
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
  tray.setToolTip('Drip Type');
  createTrayMenuOnly();
  tray.on('click', showQuickComposer);
}

function createApplicationMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: showUpdatesPage },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: showMainWindow },
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
      submenu: [{ role: 'minimize' }, { role: 'close' }]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

handleTrusted('drip-type:start', ['index.html', 'quick.html'], async (event, text) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
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
  if (senderWindow === quickWindow) quickWindow.hide();
  if (senderWindow === mainWindow) mainWindow.hide();
  const result = await dripType(text, { target: senderWindow === quickWindow ? quickTarget : null });
  if (result?.error && senderWindow === quickWindow) {
    quickWindow.show();
    quickWindow.focus();
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
handleTrusted('templates:list', ['index.html', 'quick.html'], () => listTemplates());
handleTrusted('templates:save', ['index.html'], (_event, template) => saveTemplate(template));
handleTrusted('templates:delete', ['index.html'], (_event, id) => deleteTemplate(id));
handleTrusted('templates:install-library', ['index.html'], () => installProTemplateLibrary());
handleTrusted('profiles:list', ['index.html'], () => ({
  profiles: listProfiles(), activeProfileId: store.get('activeProfileId', DEFAULT_PROFILE.id)
}));
handleTrusted('profiles:save', ['index.html'], (_event, profile) => saveProfile(profile));
handleTrusted('profiles:activate', ['index.html'], (_event, id) => activateProfile(id));
handleTrusted('profiles:delete', ['index.html'], (_event, id) => deleteProfile(id));
handleTrusted('clipboard-workspace:list', ['index.html'], (_event, query) => {
  const blocked = proRequired('clipboard');
  return blocked || { items: listClipboardItems(query) };
});
handleTrusted('clipboard-workspace:capture', ['index.html'], () => captureClipboardItem());
handleTrusted('clipboard-workspace:update', ['index.html'], (_event, id, action) => updateClipboardItem(id, action));
handleTrusted('pro:batch-render', ['index.html'], (_event, body, input) => {
  const blocked = proRequired('batch');
  return blocked || renderBatch(String(body || '').slice(0, MAX_TEMPLATE_BODY_LENGTH), String(input || '').slice(0, 500000));
});
handleTrusted('pro:transform', ['index.html'], (_event, value, mode) => {
  const blocked = proRequired('writing_lab');
  return blocked || { text: transformWriting(value, mode) };
});

onTrusted('drip-type:cancel', ['index.html', 'quick.html'], cancelDripType);
onTrusted('quick:show', ['index.html'], showQuickComposer);
onTrusted('quick:close', ['quick.html'], () => quickWindow?.hide());
onTrusted('main:show', ['quick.html'], showMainWindow);
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
    ? `Download Drip Type ${updateState.version}…`
    : updateState.status === 'downloaded'
      ? `Restart to Install ${updateState.version}…`
      : updateState.status === 'downloading'
        ? `Downloading Update (${Math.round(updateState.percent || 0)}%)…`
        : 'Check for Updates…';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Drip Composer', accelerator: store.get('hotkeyStart'), click: showQuickComposer },
    { label: 'Open Drip Type', click: showMainWindow },
    { label: updateLabel, click: showUpdatesPage },
    { type: 'separator' },
    { label: 'Stop Typing', accelerator: store.get('hotkeyStop'), click: cancelDripType },
    { type: 'separator' },
    { label: 'Quit Drip Type', role: 'quit' }
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
handleTrusted('billing:subscribe', ['index.html'], async () => {
  await shell.openExternal(`${BILLING_ORIGIN}/account?connect_device=${encodeURIComponent(ensureDeviceId())}`);
  return currentBillingState();
});
handleTrusted('billing:portal', ['index.html'], async () => {
  const refreshToken = await readRefreshCredential();
  if (!refreshToken) return { error: 'Activate a subscription before opening billing.' };
  try {
    const result = await billingRequest('/api/create-portal', {
      refreshToken,
      deviceId: ensureDeviceId()
    });
    if (!/^https:\/\/billing\.stripe\.com\//.test(result.url || '')) {
      throw new Error('Billing portal URL was rejected.');
    }
    await shell.openExternal(result.url);
    return { success: true };
  } catch (error) {
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
  if (updateState.status === 'downloaded') setImmediate(() => autoUpdater.quitAndInstall(false, true));
});

app.setName('Drip Type');
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

app.whenReady().then(async () => {
  await synchronizeTrialStartedAt();
  migrateUserVault();
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
app.on('will-quit', () => {
  cancelDripType();
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (entitlementRefreshTimer) clearInterval(entitlementRefreshTimer);
  globalShortcut.unregisterAll();
});
app.on('window-all-closed', () => {
  if (!['darwin', 'win32'].includes(process.platform)) app.quit();
});
