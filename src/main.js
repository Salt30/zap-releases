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
  systemPreferences
} = require('electron');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const APP_ID = 'com.salt30.driptype';
const MAX_TEXT_LENGTH = 100000;
const APP_SCHEME = 'drip';
const APP_HOST = 'app';
const APP_RESOURCES = new Set([
  'index.html', 'index.js', 'quick.html', 'quick.js',
  'onboarding.html', 'onboarding.js'
]);
const DEFAULTS = {
  dripWPM: 45,
  dripDelay: 3,
  typoRate: 0.03,
  dripPauseChance: 0.03,
  dripBurstChance: 0.08,
  hotkeyStart: 'Alt+5',
  hotkeyStop: 'Alt+0',
  launchAtLogin: true,
  theme: 'system',
  automationPermissionChecked: false,
  onboardingDone: false
};

const store = new Store({ defaults: DEFAULTS });

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

let mainWindow = null;
let quickWindow = null;
let onboardingWindow = null;
let tray = null;
let quickTarget = null;
let dripTypeCancelled = false;
let dripTypeRunning = false;
let activeAppleScript = null;
let updateCheckTimer = null;
let lastNotifiedUpdateVersion = null;
let updateState = {
  status: app.isPackaged && process.platform === 'darwin' ? 'idle' : 'development',
  currentVersion: app.getVersion(),
  version: null,
  releaseName: null,
  releaseNotes: null,
  percent: 0,
  lastCheckedAt: null,
  message: 'Updates are checked automatically.'
};

const NEARBY = {
  a: 'sqwz', b: 'vngh', c: 'xvdf', d: 'sfcxer', e: 'wrsd', f: 'dgcvrt',
  g: 'fhvbty', h: 'gjbnyu', i: 'ujko', j: 'hknmui', k: 'jlmio', l: 'kop',
  m: 'njk', n: 'bmhj', o: 'iklp', p: 'ol', q: 'wa', r: 'edft', s: 'awdxze',
  t: 'rfgy', u: 'yhji', v: 'cbfg', w: 'qase', x: 'zsdc', y: 'tghu', z: 'xsa',
  '1': '2q', '2': '13qw', '3': '24we', '4': '35er', '5': '46rt',
  '6': '57ty', '7': '68yu', '8': '79ui', '9': '80io', '0': '9p'
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

function numberSetting(key, fallback) {
  const value = Number(store.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function typoChar(character) {
  const pool = NEARBY[character.toLowerCase()];
  if (!pool) return character;
  const typo = pool[Math.floor(Math.random() * pool.length)];
  return character === character.toUpperCase() ? typo.toUpperCase() : typo;
}

function humanMs(base) {
  const gaussian = () => {
    let u = 0;
    let v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  let delay = base + gaussian() * base * 0.6;
  if (Math.random() < 0.02) delay += 200 + Math.random() * 400;
  return Math.max(15, Math.round(delay));
}

function escapeAppleScript(character) {
  return character.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function cleanMarkdown(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
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
    return net.fetch(pathToFileURL(path.join(__dirname, resource)).href);
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
  if (/404|latest-mac\.yml|no published versions/i.test(message)) {
    return 'The secure update channel is not published yet. Try again later.';
  }
  if (/net::|ENOTFOUND|ECONN|network|offline/i.test(message)) {
    return 'Drip Type could not reach the update service. Check your connection and try again.';
  }
  return 'The signed update could not be verified. Try again later.';
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
    body: 'Open Drip Type to review what’s new and download the signed update.',
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
  for (const key of ['hotkeyStart', 'hotkeyStop']) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    const value = typeof settings[key] === 'string' ? settings[key].trim() : '';
    if (value && value.length <= 64) store.set(key, value);
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
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: store.get('launchAtLogin', DEFAULTS.launchAtLogin),
    openAsHidden: true
  });
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
  const automation = store.get('automationPermissionChecked', false)
    ? await isAutomationTrusted()
    : false;
  const shortcuts = [store.get('hotkeyStart'), store.get('hotkeyStop')]
    .filter(Boolean)
    .every((shortcut) => globalShortcut.isRegistered(shortcut));
  const installedInApplications = !app.isPackaged || process.platform !== 'darwin'
    || process.execPath.startsWith('/Applications/');
  return { accessibility, automation, shortcuts, installedInApplications };
}

function configureUpdater() {
  if (!app.isPackaged || process.platform !== 'darwin') {
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
    message: 'Checking the signed release channel…'
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
      message: 'You have the latest signed version.'
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
  if (process.platform !== 'darwin' || !target?.bundleId) return;
  if (!/^[A-Za-z0-9.-]+$/.test(target.bundleId)) return;
  try {
    await execFileAsync('/usr/bin/open', ['-b', target.bundleId], { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 250));
  } catch (_) {}
}

function buildCharacterSteps(text, speed, typoRate, pauseChance, burstChance) {
  return [...text].map((character, index) => {
    const commands = [];

    if (Math.random() < pauseChance && index > 0) {
      commands.push(`delay ${(1 + Math.random() * 2.5).toFixed(4)}`);
    }

    const characterSpeed = Math.random() < burstChance ? speed * 0.5 : speed;
    const delay = humanMs(characterSpeed) / 1000;

    if (/[a-zA-Z]/.test(character) && Math.random() < typoRate) {
      const wrong = typoChar(character);
      commands.push(`keystroke "${escapeAppleScript(wrong)}"`);
      commands.push(`delay ${(0.3 + Math.random() * 0.5).toFixed(4)}`);
      commands.push('key code 51');
      commands.push(`delay ${(0.08 + Math.random() * 0.12).toFixed(4)}`);
      if (wrong !== character) commands.push(`delay ${(0.05 + Math.random() * 0.1).toFixed(4)}`);
      commands.push(`keystroke "${escapeAppleScript(character)}"`);
      commands.push(`delay ${delay.toFixed(4)}`);
    } else if (character === '\n') {
      commands.push('key code 36');
      commands.push(`delay ${(delay + 0.3 + Math.random() * 0.5).toFixed(4)}`);
    } else if (character === '\t') {
      commands.push('key code 48');
      commands.push(`delay ${delay.toFixed(4)}`);
    } else if ('.!?'.includes(character)) {
      commands.push(`keystroke "${escapeAppleScript(character)}"`);
      commands.push(`delay ${(delay + 0.4 + Math.random() * 0.8).toFixed(4)}`);
    } else if (character === ',') {
      commands.push(`keystroke "${escapeAppleScript(character)}"`);
      commands.push(`delay ${(delay + 0.1 + Math.random() * 0.3).toFixed(4)}`);
    } else {
      commands.push(`keystroke "${escapeAppleScript(character)}"`);
      commands.push(`delay ${delay.toFixed(4)}`);
    }

    return commands;
  });
}

function runAppleScript(scriptPath) {
  return new Promise((resolve, reject) => {
    activeAppleScript = execFile('/usr/bin/osascript', [scriptPath], { timeout: 120000 }, (error) => {
      activeAppleScript = null;
      if (error && !dripTypeCancelled) reject(error);
      else resolve();
    });
  });
}

function cancelDripType() {
  dripTypeCancelled = true;
  if (activeAppleScript) {
    try { activeAppleScript.kill('SIGTERM'); } catch (_) {}
    activeAppleScript = null;
  }
  broadcastState({ status: 'cancelled', message: 'Typing stopped.' });
}

async function dripType(input, options = {}) {
  const text = cleanMarkdown(input);
  if (!text) return { error: 'Enter some text first.' };
  if ([...text].length > MAX_TEXT_LENGTH) return { error: 'Text is limited to 100,000 characters per run.' };
  if (dripTypeRunning) return { error: 'Drip Type is already running.' };

  if (process.platform !== 'darwin') {
    clipboard.writeText(text);
    return { fallback: true, message: 'Automatic typing requires macOS. The text was copied instead.' };
  }

  if (!isAccessibilityTrusted(false)) {
    return {
      error: 'Accessibility access is required before Drip Type can type into another app.',
      code: 'ACCESSIBILITY_REQUIRED'
    };
  }

  dripTypeCancelled = false;
  dripTypeRunning = true;
  let runDirectory = null;

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
    runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'drip-type-'));

    broadcastState({ status: 'typing', progress: 0, message: 'Typing…' });

    for (let offset = 0; offset < steps.length; offset += chunkSize) {
      if (dripTypeCancelled) return { cancelled: true };

      const chunk = steps.slice(offset, offset + chunkSize);
      const script = `tell application "System Events"\n${chunk.flat().join('\n')}\nend tell`;
      const scriptPath = path.join(runDirectory, `chunk-${offset}.scpt`);
      fs.writeFileSync(scriptPath, script, { mode: 0o600, flag: 'wx' });

      try {
        await runAppleScript(scriptPath);
      } finally {
        try { fs.unlinkSync(scriptPath); } catch (_) {}
      }

      const completed = Math.min(offset + chunk.length, steps.length);
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
    const message = error.stderr?.trim() || error.message || 'Typing failed.';
    broadcastState({ status: 'error', message });
    return { error: message };
  } finally {
    dripTypeRunning = false;
    activeAppleScript = null;
    if (runDirectory) {
      try { fs.rmSync(runDirectory, { recursive: true, force: true }); } catch (_) {}
    }
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
    height: 340,
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
    settings: store.store
  });
}

function showMainWindow() {
  const window = createMainWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function showUpdatesPage() {
  const window = createMainWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  const navigate = () => sendToWindow(window, 'app:navigate', { page: 'setup', focus: 'updates' });
  if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', navigate);
  else navigate();
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const failures = [];
  const shortcuts = [
    { key: store.get('hotkeyStart'), action: showQuickComposer, label: 'Drip Composer' },
    { key: store.get('hotkeyStop'), action: cancelDripType, label: 'Stop typing' }
  ];

  for (const shortcut of shortcuts) {
    if (!shortcut.key) continue;
    try {
      if (!globalShortcut.register(shortcut.key, shortcut.action)) failures.push(shortcut.label);
    } catch (_) {
      failures.push(shortcut.label);
    }
  }

  return failures;
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) icon = icon.resize({ width: 18, height: 18 });
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
  registerShortcuts();
  onboardingWindow?.close();
  showMainWindow();
  return { success: true };
});

handleTrusted('settings:get', ['index.html', 'onboarding.html'], () => ({ ...store.store, defaults: DEFAULTS }));
handleTrusted('settings:save', ['index.html'], (_event, settings) => {
  applySettings(settings);
  if (Object.prototype.hasOwnProperty.call(settings || {}, 'launchAtLogin')) configureLoginItem();
  const shortcutFailures = registerShortcuts();
  if (tray) createTrayMenuOnly();
  return { settings: store.store, shortcutFailures };
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
handleTrusted('app:get-info', ['index.html'], () => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform,
  appId: APP_ID
}));
handleTrusted('updater:get-state', ['index.html'], () => ({ ...updateState }));
handleTrusted('updater:check', ['index.html'], async () => {
  if (!app.isPackaged || process.platform !== 'darwin') return { status: 'development' };
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
    publishUpdateState({ status: 'error', message: 'The signed update could not be downloaded.' });
  }
  return { ...updateState };
});
onTrusted('updater:install', ['index.html'], () => {
  if (updateState.status === 'downloaded') setImmediate(() => autoUpdater.quitAndInstall(false, true));
});

app.setName('Drip Type');

app.on('second-instance', () => {
  if (dripTypeRunning) return;
  showQuickComposer();
});

app.whenReady().then(() => {
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
  registerShortcuts();
  configureLoginItem();
  configureUpdater();
  const openedAtLogin = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
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
  globalShortcut.unregisterAll();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
