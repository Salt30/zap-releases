const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Tray,
  Menu,
  screen,
  desktopCapturer,
  nativeImage,
  clipboard
} = require('electron');
const path = require('path');
const { exec } = require('child_process');
const Store = require('electron-store');

/* ─────────────────── Persistent Settings ─────────────────── */

// This gets replaced by sed during CI build — do NOT change the placeholder string
const BUILT_IN_API_KEY = 'YOUR_PERPLEXITY_API_KEY';
// Constructed so sed doesn't replace it — used to detect if key was injected
const API_PLACEHOLDER = 'YOUR_PERPLEXITY' + '_API_KEY';

// OpenAI GPT-4o key — injected at build time via sed
const OPENAI_API_KEY = 'YOUR_OPENAI_API_KEY';
const OPENAI_KEY_PLACEHOLDER = 'YOUR_OPENAI' + '_API_KEY';

// Stripe configuration — injected at build time via sed
const STRIPE_SECRET_KEY = 'YOUR_STRIPE_SECRET_KEY';
const STRIPE_KEY_PLACEHOLDER = 'YOUR_STRIPE' + '_SECRET_KEY';
const STRIPE_PRICE_ID = 'price_1T7p8qDu0Wu9yqrt7NG7SsY5';

// GitHub token for support tickets (Issues API) — injected at build time via sed
const GITHUB_SUPPORT_TOKEN = 'YOUR_GH_SUPPORT_TOKEN';
const GITHUB_SUPPORT_PLACEHOLDER = 'YOUR_GH' + '_SUPPORT_TOKEN';
const GITHUB_REPO = 'Salt30/Zap';

const STORE_DEFAULTS = {
  apiKey:        BUILT_IN_API_KEY,
  openaiKey:     OPENAI_API_KEY,
  apiEndpoint:   'https://api.openai.com/v1/chat/completions',
  model:         'gpt-4o',
  overlayOpacity: 0.0,
  accentColor:   '#facc15',
  fontSize:      14,
  fontFamily:    'system-ui, -apple-system, sans-serif',
  borderRadius:  12,
  hotkey:          'Alt+3',
  hotkeyAnswer:    'Alt+1',
  hotkeyTranslate: 'Alt+2',
  hotkeyAutopilot: 'Alt+4',
  hotkeyDripType:  'Alt+5',
  hotkeyStopDrip:  'Alt+0',
  hotkeySimple:    'Alt+6',
  hotkeySolve:     'Alt+7',
  hotkeyEssay:     'Alt+8',
  hotkeyCode:      'Alt+9',
  hotkeyResearch:  'CmdOrCtrl+Alt+1',
  hotkeyEmail:     'CmdOrCtrl+Alt+2',
  hotkeyFlashcards:'CmdOrCtrl+Alt+3',
  hotkeyApp:       'Alt+M',
  language:      'Spanish',
  theme:         'dark',
  lastMode:      'answer',
  simpleMode:    false,
  phantomMode:   false,
  autoEngine:    true,
  credibleSourcesOnly: false,
  maxTokens:     1024,
  dripSpeed:     40,
  dripWPM:       45,
  dripDelay:     10,
  typoRate:      0.06,
  dripPauseChance: 0.03,
  dripBurstChance: 0.08,
  invisibleOverlay: true,
  lockdownMode: false,
  authDone: false,
  authName: '',
  authEmail: '',
  authPasswordHash: '',
  onboardingDone: false,
  licenseKey: '',
  licenseValid: false,
  licenseEmail: '',
  stripeCustomerId: '',
  stripeSubscriptionId: '',
  subscriptionStatus: 'inactive',
  lastSubscriptionCheck: 0,
  trialStarted: 0,
  trialDays: 3,
  // Usage Analytics
  statsFirstLaunch: 0,
  statsTotalSessions: 0,
  statsAnswerCount: 0,
  statsSimpleCount: 0,
  statsTranslateCount: 0,
  statsRewriteCount: 0,
  statsDripTypeCount: 0,
  statsSummarizeCount: 0,
  statsExplainCount: 0,
  statsTotalRequests: 0,
  statsLastUsed: 0,
  // Support Tickets (local log)
  supportTickets: []
};

let store = null;

function initStore() {
  if (store) return store;
  try {
    store = new Store({ name: 'zap-config', defaults: STORE_DEFAULTS });
    // Test that the store is readable
    store.get('apiKey');
  } catch (_) {
    // Config file is corrupted — delete it and start fresh
    const fs = require('fs');
    try {
      const configPath = path.join(app.getPath('userData'), 'zap-config.json');
      fs.unlinkSync(configPath);
    } catch (_) {}
    store = new Store({ name: 'zap-config', defaults: STORE_DEFAULTS });
  }

  // If stored API key is the placeholder, update it with the built-in key
  const savedKey = store.get('apiKey');
  if ((!savedKey || savedKey === API_PLACEHOLDER) && BUILT_IN_API_KEY !== API_PLACEHOLDER) {
    store.set('apiKey', BUILT_IN_API_KEY);
  }

  // v3.15.1 migration: Rewrite mode removed — remap its hotkey to Autopilot
  if (store.get('hotkeyRewrite')) {
    const oldRewriteKey = store.get('hotkeyRewrite');
    // If autopilot has no hotkey or still has old default, give it rewrite's hotkey
    if (!store.get('hotkeyAutopilot') || store.get('hotkeyAutopilot') === 'CmdOrCtrl+Alt+4') {
      store.set('hotkeyAutopilot', oldRewriteKey);
    }
    store.delete('hotkeyRewrite');
  }

  return store;
}

/* ─────────────────── Stripe Client ─────────────────── */

let stripeClient = null;
function getStripe() {
  if (stripeClient) return stripeClient;
  if (STRIPE_SECRET_KEY === STRIPE_KEY_PLACEHOLDER) return null;
  const Stripe = require('stripe');
  stripeClient = new Stripe(STRIPE_SECRET_KEY);
  return stripeClient;
}

// Admin master keys — always valid
const ADMIN_KEYS = ['ZAP-ADMIN-MASTER-2026', 'ZAP-OWNER-ARHAAN-KEY'];

/* ─────────────────── Usage Analytics ─────────────────── */

const ADMIN_EMAILS = ['arhaand30@gmail.com'];

function isAdmin() {
  const key = store.get('licenseKey');
  const email = store.get('authEmail') || store.get('licenseEmail') || '';
  return ADMIN_KEYS.includes(key) || ADMIN_EMAILS.includes(email.toLowerCase());
}

function trackUsage(mode) {
  const key = 'stats' + mode.charAt(0).toUpperCase() + mode.slice(1) + 'Count';
  store.set(key, (store.get(key) || 0) + 1);
  store.set('statsTotalRequests', (store.get('statsTotalRequests') || 0) + 1);
  store.set('statsLastUsed', Date.now());
}

function initAnalytics() {
  if (!store.get('statsFirstLaunch')) store.set('statsFirstLaunch', Date.now());
  store.set('statsTotalSessions', (store.get('statsTotalSessions') || 0) + 1);
}

/* ─────────────────── Lockdown Mode ─────────────────── */

function isLockdown() {
  return !!(store && store.get('lockdownMode'));
}

/** In lockdown mode, re-assert overlay above everything on a fast timer */
let lockdownKeepAlive = null;

function startLockdownKeepAlive() {
  if (lockdownKeepAlive) return;
  lockdownKeepAlive = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    if (!overlayUp) return;
    applyOverlayLevel();
  }, 800);
}

function stopLockdownKeepAlive() {
  if (lockdownKeepAlive) { clearInterval(lockdownKeepAlive); lockdownKeepAlive = null; }
}

/* ─────────────────── Window References ─────────────────── */

let overlayWin     = null;
let settingsWin    = null;
let flashcardsWin  = null;
let tray           = null;
let overlayUp      = false;

/* ─────────────────── Screen Share Stealth ─────────────────── */

let screenBeingCaptured = false;
let screenCaptureSubId  = null;
let screenCapturePoll   = null;

/**
 * When screen recording/sharing is detected:
 *  - Set overlay window opacity to 0 (completely invisible in recordings)
 *  - Content protection makes it a black box, but opacity 0 makes even THAT invisible
 *  - The window remains active and functional — hotkeys, selections still work
 *  - Notify overlay renderer to show a tiny stealth indicator so user knows it's hidden
 *
 * When recording stops: restore full opacity
 */
function onScreenCaptureChanged(isCapturing) {
  screenBeingCaptured = isCapturing;
  if (!overlayWin || overlayWin.isDestroyed()) return;

  if (isCapturing) {
    // Make window completely invisible in screen capture
    try { overlayWin.setOpacity(0); } catch (_) {}
    // Notify renderer to show stealth indicator
    try { overlayWin.webContents.send('screen-share-status', true); } catch (_) {}
  } else {
    // Restore full visibility
    try { overlayWin.setOpacity(1); } catch (_) {}
    try { overlayWin.webContents.send('screen-share-status', false); } catch (_) {}
  }
}

function initScreenCaptureDetection() {
  if (process.platform === 'darwin') {
    // macOS: subscribe to system notification when screen capture state changes
    try {
      const { systemPreferences } = require('electron');
      screenCaptureSubId = systemPreferences.subscribeNotification(
        'com.apple.screenIsBeingCapturedDidChange',
        () => {
          // Query actual screen capture state via Python + CoreGraphics
          exec(
            `python3 -c "
import Quartz
session = Quartz.CGSessionCopyCurrentDictionary()
captured = session.get('kCGSSessionScreenIsBeingCaptured', 0) if session else 0
print('yes' if captured else 'no')
" 2>/dev/null`,
            { timeout: 3000 },
            (err, stdout) => {
              const capturing = stdout && stdout.trim() === 'yes';
              if (capturing !== screenBeingCaptured) {
                onScreenCaptureChanged(capturing);
              }
            }
          );
        }
      );

      // Also do an initial check on startup
      exec(
        `python3 -c "
import Quartz
session = Quartz.CGSessionCopyCurrentDictionary()
captured = session.get('kCGSSessionScreenIsBeingCaptured', 0) if session else 0
print('yes' if captured else 'no')
" 2>/dev/null`,
        { timeout: 3000 },
        (err, stdout) => {
          if (stdout && stdout.trim() === 'yes') onScreenCaptureChanged(true);
        }
      );
    } catch (_) {
      // Fallback: poll-based detection for older macOS
      startScreenCapturePoll();
    }
  } else if (process.platform === 'win32') {
    // Windows: poll for common screen recording processes
    startScreenCapturePoll();
  }
}

function startScreenCapturePoll() {
  if (screenCapturePoll) return;
  screenCapturePoll = setInterval(() => {
    if (process.platform === 'win32') {
      exec(
        `powershell -Command "Get-Process -Name obs64,obs32,ScreenClip,CamtasiaStudio -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.Name }"`,
        { timeout: 3000 },
        (err, stdout) => {
          const capturing = !!(stdout && stdout.trim());
          if (capturing !== screenBeingCaptured) onScreenCaptureChanged(capturing);
        }
      );
    }
  }, 3000);
}

function cleanupScreenCaptureDetection() {
  if (screenCaptureSubId !== null && process.platform === 'darwin') {
    try {
      const { systemPreferences } = require('electron');
      systemPreferences.unsubscribeNotification(screenCaptureSubId);
    } catch (_) {}
    screenCaptureSubId = null;
  }
  if (screenCapturePoll) { clearInterval(screenCapturePoll); screenCapturePoll = null; }
}

/* ─────────────────── Overlay Window ─────────────────── */

/** Apply content protection — hides window from ALL screen capture/share/recording */
function enforceContentProtection(win) {
  if (!win || win.isDestroyed()) return;
  try { win.setContentProtection(true); } catch (_) {}
}

/** Re-apply window level + workspace visibility + content protection */
function applyOverlayLevel() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  // 1. Content protection first
  enforceContentProtection(overlayWin);
  // 2. Visible on all workspaces INCLUDING fullscreen spaces
  try { overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  // 3. Highest window level — screen-saver renders above everything
  try { overlayWin.setAlwaysOnTop(true, 'screen-saver', 1); } catch (_) { overlayWin.setAlwaysOnTop(true); }
  if (process.platform === 'darwin') {
    try { overlayWin.setWindowButtonVisibility(false); } catch (_) {}
  }
  // 4. If screen is being captured, keep opacity at 0
  if (screenBeingCaptured) {
    try { overlayWin.setOpacity(0); } catch (_) {}
  }
}

function makeOverlay() {
  if (!store) initStore();
  const display = screen.getPrimaryDisplay();

  const winOpts = {
    x: 0, y: 0,
    width:  display.size.width,
    height: display.size.height,
    transparent:      true,
    frame:            false,
    alwaysOnTop:      true,
    skipTaskbar:      true,
    resizable:        false,
    movable:          false,
    fullscreenable:   false,
    hasShadow:        false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  };

  // Panel type on macOS — NSPanel can join fullscreen Spaces natively
  if (process.platform === 'darwin') winOpts.type = 'panel';

  overlayWin = new BrowserWindow(winOpts);
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));

  // Apply content protection immediately
  enforceContentProtection(overlayWin);

  // Re-apply content protection on EVERY visibility change
  // macOS can reset sharingType when panel windows change state
  overlayWin.on('show', () => {
    enforceContentProtection(overlayWin);
    // Double-apply after a short delay to catch any macOS resets
    setTimeout(() => enforceContentProtection(overlayWin), 50);
    setTimeout(() => enforceContentProtection(overlayWin), 200);
  });
  overlayWin.on('focus', () => enforceContentProtection(overlayWin));
  overlayWin.on('blur', () => enforceContentProtection(overlayWin));
  overlayWin.webContents.on('did-finish-load', () => enforceContentProtection(overlayWin));

  applyOverlayLevel();

  overlayWin.setIgnoreMouseEvents(false);
  overlayWin.hide();

  overlayWin.on('closed', () => { overlayWin = null; });
}

/* ─────────────────── Settings Window ─────────────────── */

function makeSettings() {
  if (settingsWin) { settingsWin.focus(); return; }

  settingsWin = new BrowserWindow({
    width: 700, height: 800,
    resizable: true, minimizable: true, maximizable: false,
    title: 'Zap Settings',
    backgroundColor: '#0a0a12',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  });

  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  try { settingsWin.setContentProtection(true); } catch (_) {}
  settingsWin.on('closed', () => { settingsWin = null; });
}

/* ─────────────────── Flashcards Window ─────────────────── */

function showFlashcards(cardsText) {
  if (flashcardsWin) { flashcardsWin.focus(); return; }
  if (process.platform === 'darwin') app.dock?.show();

  flashcardsWin = new BrowserWindow({
    width: 1024, height: 768,
    resizable: true, minimizable: true, maximizable: true,
    fullscreenable: true,
    title: 'Zap Flashcards',
    backgroundColor: '#0a0a12',
    show: false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  });

  flashcardsWin.loadFile(path.join(__dirname, 'flashcards.html'));
  try { flashcardsWin.setContentProtection(true); } catch (_) {}
  flashcardsWin.webContents.on('did-finish-load', () => {
    flashcardsWin.webContents.send('load-cards', cardsText || '');
  });
  flashcardsWin.once('ready-to-show', () => { flashcardsWin.show(); flashcardsWin.focus(); });
  flashcardsWin.on('closed', () => {
    flashcardsWin = null;
    if (process.platform === 'darwin' && isLicensed()) app.dock?.hide();
  });
}

/* ─────────────────── Screen Capture ─────────────────── */

async function grabScreen() {
  // Simple desktopCapturer — the original approach that worked
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const scale = display.scaleFactor || 2;
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) }
    });
    if (sources && sources.length > 0) return sources[0].thumbnail.toDataURL();
  } catch (_) {}
  return null;
}

/* ─────────────────── Show / Toggle Overlay ─────────────────── */

function showWithMode(mode) {
  // Block overlay if not licensed
  if (!isLicensed()) { showActivate(); return; }
  if (!overlayWin) makeOverlay();

  if (overlayUp) {
    overlayWin.webContents.send('set-mode', mode);
    return;
  }

  const finishShow = (img) => {
    if (!overlayWin) return;
    applyOverlayLevel();               // re-assert level before every show
    overlayWin.webContents.send('set-mode', mode);
    overlayWin.webContents.send('screen-captured', img);
    overlayWin.webContents.send('load-settings', store.store);
    overlayWin.showInactive();
    // Re-enforce content protection AFTER show — critical for panel windows
    enforceContentProtection(overlayWin);
    overlayUp = true;
    // In lockdown mode, start the keep-alive timer to stay above lockdown browsers
    if (isLockdown()) startLockdownKeepAlive();
  };

  // In lockdown mode, skip desktopCapturer entirely — it will be blocked by lockdown browsers
  if (isLockdown()) {
    finishShow(null);
    return;
  }

  grabScreen().then(img => finishShow(img)).catch(() => finishShow(null));
}

function toggle() {
  // Block overlay if not licensed
  if (!isLicensed()) { showActivate(); return; }
  if (!overlayWin) makeOverlay();
  if (overlayUp) { overlayWin.hide(); overlayUp = false; stopLockdownKeepAlive(); }
  else showWithMode(store.get('lastMode') || 'answer');
}

/* ─────────────────── Tray Icon ─────────────────── */

function makeTray() {
  const icon64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA2ElEQVR4nGNgGAWDAfD///8vBuL/eMT/M5AB/v//z4DHgP9QMU4NjFgMYGBgYPj/HwrwGPAfajAbNwMDVAMuA/5DNTNDDcEJ/v+HOuU/PkfhcwYTAwMDA8P/////J9YZYMDIwMDAwIjDgP9QNjMDHrBo0SJGZANYkTgcHBws2AxgRhJjYWRkhIux4HMGCwMDAwMrLgOQ/cyCywBmZBfgMoCZkZERT2CiGsCKLxCZGYkIRGY8schMIBaZscUiEwOe1MjMSCgaGRjwZ2hmIvIzCxYxqjXQGwAAL69DD1mFmEAAAAAASUVORK5CYII=';

  tray = new Tray(nativeImage.createFromDataURL('data:image/png;base64,' + icon64));

  const licensed = isLicensed();
  const menu = Menu.buildFromTemplate([
    { label: 'Toggle Overlay', accelerator: store.get('hotkey'), click: toggle, enabled: licensed },
    { type: 'separator' },
    { label: 'Answer Mode',    click: () => showWithMode('answer'),    enabled: licensed },
    { label: 'Simple Mode',    click: () => showWithMode('simple'),    enabled: licensed },
    { label: 'Translate Mode',  click: () => showWithMode('translate'),  enabled: licensed },
    { label: 'Autopilot Mode',  click: () => showWithMode('autopilot'), enabled: licensed },
    { label: 'Drip Type Mode',  click: () => showWithMode('driptype'),  enabled: licensed },
    { type: 'separator' },
    ...(licensed ? [] : [{ label: 'Subscribe to Unlock', click: showActivate }, { type: 'separator' }]),
    { label: 'Settings', click: makeSettings },
    { type: 'separator' },
    { label: 'Phantom Mode (Always On)', type: 'checkbox', checked: true, enabled: false },
    { type: 'separator' },
    { label: 'Quit Zap', click: () => app.quit() }
  ]);

  tray.setToolTip('Zap — AI Screen Overlay');
  tray.setContextMenu(menu);
  tray.on('click', toggle);
}

/* ─────────────────── Global Hotkeys ─────────────────── */

function bindKeys() {
  globalShortcut.unregisterAll();
  // App/settings hotkeys always work
  const appKeys = [
    [store.get('hotkeyApp'), makeSettings]
  ];
  for (const [key, fn] of appKeys) {
    if (!key) continue;
    try { globalShortcut.register(key, fn); } catch (_) {}
  }
  // Overlay/feature hotkeys only work if licensed
  if (!isLicensed()) return;

  // In lockdown mode, register BOTH normal hotkeys AND stealth hotkeys
  // Stealth hotkeys use F-key combos that lockdown browsers are less likely to intercept
  const featureKeys = [
    [store.get('hotkey'),          toggle],
    [store.get('hotkeyAnswer'),    () => showWithMode('answer')],
    [store.get('hotkeySimple'),    () => showWithMode('simple')],
    [store.get('hotkeyTranslate'), () => showWithMode('translate')],
    [store.get('hotkeyDripType'),  () => showWithMode('driptype')],
    [store.get('hotkeySolve'),     () => showWithMode('solve')],
    [store.get('hotkeyEssay'),     () => showWithMode('essay')],
    [store.get('hotkeyCode'),      () => showWithMode('code')],
    [store.get('hotkeyResearch'),  () => showWithMode('research')],
    [store.get('hotkeyEmail'),     () => showWithMode('email')],
    [store.get('hotkeyFlashcards'),() => showWithMode('flashcards')],
    [store.get('hotkeyAutopilot'), () => showWithMode('autopilot')],
    [store.get('hotkeyStopDrip'),  () => { dripTypeCancelled = true; }]
  ];
  for (const [key, fn] of featureKeys) {
    if (!key) continue;
    try { globalShortcut.register(key, fn); } catch (_) {}
  }

  // Stealth hotkeys for lockdown mode — letter-based combos that work without Fn key
  if (isLockdown()) {
    const stealthKeys = [
      ['Control+Shift+Z',  toggle],
      ['Control+Shift+A',  () => showWithMode('answer')],
      ['Control+Shift+S',  () => showWithMode('simple')],
      ['Control+Shift+T',  () => showWithMode('translate')],
      ['Control+Shift+D',  () => showWithMode('driptype')],
      ['Control+Shift+V',  () => showWithMode('solve')],
      ['Control+Shift+E',  () => showWithMode('essay')],
      ['Control+Shift+C',  () => showWithMode('code')],
      ['Control+Shift+F',  () => showWithMode('research')],
      ['Control+Shift+W',  () => showWithMode('email')],
      ['Control+Shift+Q',  () => showWithMode('flashcards')],
      ['Control+Shift+P',  () => showWithMode('autopilot')],
      ['Control+Shift+X',  () => { dripTypeCancelled = true; }]
    ];
    for (const [key, fn] of stealthKeys) {
      try { globalShortcut.register(key, fn); } catch (_) {}
    }
  }
}

/* ─────────────────── Drip Type Engine ─────────────────── */

let dripTypeCancelled = false;
let dripTypeRunning = false;

const NEARBY = {
  a:'sqwz', b:'vngh', c:'xvdf', d:'sfcxer', e:'wrsd', f:'dgcvrt',
  g:'fhvbty', h:'gjbnyu', i:'ujko', j:'hknmui', k:'jlmio', l:'kop',
  m:'njk', n:'bmhj', o:'iklp', p:'ol', q:'wa', r:'edft', s:'awdxze',
  t:'rfgy', u:'yhji', v:'cbfg', w:'qase', x:'zsdc', y:'tghu', z:'xsa',
  '1':'2q','2':'13qw','3':'24we','4':'35er','5':'46rt',
  '6':'57ty','7':'68yu','8':'79ui','9':'80io','0':'9p'
};

function typoChar(ch) {
  const pool = NEARBY[ch.toLowerCase()];
  if (!pool) return ch;
  const t = pool[Math.floor(Math.random() * pool.length)];
  return ch === ch.toUpperCase() ? t.toUpperCase() : t;
}

function humanMs(base) {
  const g = () => { let u=0,v=0; while(!u)u=Math.random(); while(!v)v=Math.random(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); };
  let d = base + g() * base * 0.6;
  if (Math.random() < 0.02) d += 200 + Math.random() * 400;
  return Math.max(15, Math.round(d));
}

function escAS(c) { return c === '"' ? '\\"' : c === '\\' ? '\\\\' : c; }

ipcMain.on('cancel-drip-type', () => { dripTypeCancelled = true; });

// Strip markdown so drip-typed text reads like natural human writing
function cleanMarkdown(t) {
  if (!t) return t;
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/\*{1,3}([^*]+?)\*{1,3}/g, '$1');
  t = t.replace(/_{1,3}([^_]+?)_{1,3}/g, '$1');
  t = t.replace(/~~([^~]+?)~~/g, '$1');
  t = t.replace(/`([^`]+?)`/g, '$1');
  t = t.replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?/g, '').replace(/```/g, ''));
  t = t.replace(/^[\s]*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+\.\s+/gm, '');
  t = t.replace(/^>\s?/gm, '');
  t = t.replace(/^[-*_]{3,}\s*$/gm, '');
  t = t.replace(/\[([^\]]+?)\]\([^)]+?\)/g, '$1');
  t = t.replace(/!\[([^\]]*?)\]\([^)]+?\)/g, '$1');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

ipcMain.handle('drip-type', async (_ev, text) => {
  if (!isLicensed()) return { error: 'Subscription required.' };
  if (!text) return;
  text = cleanMarkdown(text);
  trackUsage('dripType');
  if (overlayWin) { overlayWin.hide(); overlayUp = false; }

  dripTypeCancelled = false;
  dripTypeRunning = true;

  // Configurable delay before typing starts (default 10 seconds)
  const delaySec = store.get('dripDelay') || 10;
  // Check cancel during delay (check every 500ms)
  for (let waited = 0; waited < delaySec * 1000; waited += 500) {
    if (dripTypeCancelled) { dripTypeRunning = false; return { cancelled: true }; }
    await new Promise(r => setTimeout(r, 500));
  }

  // Convert WPM to ms per character (avg word = 5 chars)
  const wpm = store.get('dripWPM') || 45;
  const speed = Math.round(60000 / (wpm * 5));
  const rate  = store.get('typoRate')  || 0.06;
  const pauseChance = store.get('dripPauseChance') || 0.03;
  const burstChance = store.get('dripBurstChance') || 0.08;

  if (process.platform === 'darwin') {
    const cmds = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      // Human-like thinking pause (random mid-sentence pause)
      if (Math.random() < pauseChance && i > 0) {
        cmds.push(`delay ${(1.0 + Math.random() * 2.5).toFixed(4)}`);
      }

      // Burst typing (briefly speed up like typing a familiar word)
      let charSpeed = speed;
      if (Math.random() < burstChance) charSpeed = speed * 0.5;

      const ms = humanMs(charSpeed) / 1000;

      if (/[a-zA-Z]/.test(ch) && Math.random() < rate) {
        // Type wrong character, pause (realize mistake), backspace, type correct
        const wrong = typoChar(ch);
        cmds.push(`keystroke "${escAS(wrong)}"`);
        cmds.push(`delay ${(humanMs(charSpeed * 0.7) / 1000).toFixed(4)}`);
        cmds.push(`delay ${((150 + Math.random() * 400) / 1000).toFixed(4)}`);
        cmds.push('key code 51');
        cmds.push(`delay ${(humanMs(charSpeed * 0.4) / 1000).toFixed(4)}`);
        cmds.push(`keystroke "${escAS(ch)}"`);
        cmds.push(`delay ${ms.toFixed(4)}`);
      } else if (ch === '\n') {
        cmds.push('key code 36');
        cmds.push(`delay ${(ms + 0.3 + Math.random() * 0.5).toFixed(4)}`);
      } else if (ch === '\t') {
        cmds.push('key code 48');
        cmds.push(`delay ${ms.toFixed(4)}`);
      } else if ('.!?'.includes(ch)) {
        // End of sentence — longer pause
        cmds.push(`keystroke "${escAS(ch)}"`);
        cmds.push(`delay ${(ms + 0.4 + Math.random() * 0.8).toFixed(4)}`);
      } else if (ch === ',') {
        // Comma — slight pause
        cmds.push(`keystroke "${escAS(ch)}"`);
        cmds.push(`delay ${(ms + 0.1 + Math.random() * 0.3).toFixed(4)}`);
      } else {
        cmds.push(`keystroke "${escAS(ch)}"`);
        cmds.push(`delay ${ms.toFixed(4)}`);
      }
    }

    const CHUNK = 200;
    for (let c = 0; c < cmds.length; c += CHUNK) {
      if (dripTypeCancelled) { dripTypeRunning = false; return { cancelled: true }; }
      const script = `tell application "System Events"\n${cmds.slice(c, c + CHUNK).join('\n')}\nend tell`;
      await new Promise(resolve => {
        exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 120000 }, () => resolve());
      });
    }
    dripTypeRunning = false;
  } else {
    clipboard.writeText(text);
    return { fallback: true, message: 'Text copied to clipboard. Paste with Ctrl+V.' };
  }
});

/* ─────────────────── IPC Handlers ─────────────────── */

ipcMain.on('hide-overlay', () => {
  if (overlayWin) { overlayWin.hide(); overlayUp = false; stopLockdownKeepAlive(); }
  // Also cancel drip type if running
  if (dripTypeRunning) dripTypeCancelled = true;
});

ipcMain.on('open-flashcards', (_ev, cards) => showFlashcards(cards));

ipcMain.handle('paste-to-screen', async () => {
  // Hide overlay first so the target app gets focus
  if (overlayWin) { overlayWin.hide(); overlayUp = false; stopLockdownKeepAlive(); }
  // Small delay to let the previous app regain focus
  await new Promise(r => setTimeout(r, 150));
  // Simulate Cmd+V (macOS) or Ctrl+V (Windows) to paste clipboard contents
  if (process.platform === 'darwin') {
    return new Promise(resolve => {
      exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`, { timeout: 5000 }, (err) => {
        resolve({ success: !err });
      });
    });
  } else {
    return new Promise(resolve => {
      exec(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"`, { timeout: 5000 }, (err) => {
        resolve({ success: !err });
      });
    });
  }
});

/* ─────────────────── Autopilot Execution ─────────────────── */

function execPromise(cmd, timeout) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeout || 5000 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// macOS: click at absolute screen coordinates — tries multiple methods
async function macClickAt(x, y) {
  const fs = require('fs');
  const os = require('os');

  // Method 1: Bundled Swift binary
  const clickerPath = path.join(process.resourcesPath, 'helpers', 'zap-clicker');
  if (fs.existsSync(clickerPath)) {
    try {
      console.log('[Autopilot] Method 1 (Swift binary):', clickerPath, x, y);
      await execPromise(`chmod +x "${clickerPath}" && "${clickerPath}" ${x} ${y}`, 5000);
      return;
    } catch (e) { console.log('[Autopilot] Swift binary failed:', e.message); }
  } else {
    console.log('[Autopilot] Swift binary not found at:', clickerPath);
  }

  // Method 2: Python3 + Quartz (available on most Macs with Xcode CLI tools)
  try {
    console.log('[Autopilot] Method 2 (Python Quartz):', x, y);
    const pyScript = `import time;from Quartz.CoreGraphics import *;p=(${x},${y});e=CGEventCreateMouseEvent(None,kCGEventMouseMoved,p,0);CGEventPost(kCGHIDEventTap,e);time.sleep(0.03);d=CGEventCreateMouseEvent(None,kCGEventLeftMouseDown,p,kCGMouseButtonLeft);CGEventPost(kCGHIDEventTap,d);time.sleep(0.05);u=CGEventCreateMouseEvent(None,kCGEventLeftMouseUp,p,kCGMouseButtonLeft);CGEventPost(kCGHIDEventTap,u)`;
    await execPromise(`/usr/bin/python3 -c "${pyScript}"`, 5000);
    return;
  } catch (e) { console.log('[Autopilot] Python Quartz failed:', e.message); }

  // Method 3: JXA via temp file (last resort)
  try {
    console.log('[Autopilot] Method 3 (JXA temp file):', x, y);
    const scriptPath = path.join(os.tmpdir(), 'zap_click.js');
    const script = `ObjC.import("Cocoa");var p=$.CGPointMake(${x},${y});var m=$.CGEventCreateMouseEvent(null,5,p,0);$.CGEventPost(0,m);delay(0.03);var d=$.CGEventCreateMouseEvent(null,1,p,0);$.CGEventPost(0,d);delay(0.05);var u=$.CGEventCreateMouseEvent(null,2,p,0);$.CGEventPost(0,u);`;
    fs.writeFileSync(scriptPath, script);
    await execPromise(`osascript -l JavaScript "${scriptPath}"`, 5000);
    return;
  } catch (e) { console.log('[Autopilot] JXA failed:', e.message); }

  throw new Error('All click methods failed — check Console.app for details');
}

// Windows: click at absolute screen coordinates using user32.dll
function winClickAt(x, y) {
  return execPromise(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -MemberDefinition '[DllImport(\\\"user32.dll\\\")]public static extern bool SetCursorPos(int x,int y);[DllImport(\\\"user32.dll\\\")]public static extern void mouse_event(int f,int x,int y,int d,int e);' -Name U -Namespace W; [W.U]::SetCursorPos(${x},${y}); [W.U]::mouse_event(2,0,0,0,0); [W.U]::mouse_event(4,0,0,0,0)"`, 5000);
}

ipcMain.handle('autopilot-execute', async (_ev, { fields }) => {
  if (!fields || !fields.length) return { success: false, error: 'No fields to fill' };

  console.log('[Autopilot] Executing', fields.length, 'fields:', JSON.stringify(fields));

  // ── macOS: check Accessibility permission (required for CGEvent clicks) ──
  if (process.platform === 'darwin') {
    const { systemPreferences } = require('electron');
    // Passing true shows the macOS prompt asking the user to grant access
    const trusted = systemPreferences.isTrustedAccessibilityClient(true);
    console.log('[Autopilot] Accessibility trusted:', trusted);
    if (!trusted) {
      // Show overlay with error telling user to grant permission
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('autopilot-result', {
          success: false,
          error: 'Zap needs Accessibility permission. Go to System Settings → Privacy & Security → Accessibility → enable Zap, then try again.'
        });
      }
      return { success: false, error: 'accessibility_not_granted' };
    }
  }

  // Hide overlay so we can interact with the underlying app
  if (overlayWin) { overlayWin.hide(); overlayUp = false; stopLockdownKeepAlive(); stopScreenShareDetection(); }
  await sleep(500);

  // Bring the previously-active app to front (the one behind our overlay)
  if (process.platform === 'darwin') {
    try {
      // Activate the frontmost non-Zap process
      await execPromise(`osascript -e 'tell application "System Events"' -e 'set procs to every process whose visible is true and name is not "Zap"' -e 'if (count of procs) > 0 then' -e 'set frontmost of item 1 of procs to true' -e 'end if' -e 'end tell'`, 3000);
    } catch(e) { console.log('[Autopilot] Focus error (non-fatal):', e.message); }
    await sleep(300);
  }

  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  console.log('[Autopilot] Display scale factor:', scale);
  const results = [];

  for (const field of fields) {
    if (!field.clickX || !field.clickY) {
      results.push({ label: field.label || '?', ok: false, reason: 'no coordinates' });
      continue;
    }

    // AI returns coordinates in image pixels; divide by scale to get screen points
    const x = Math.round(field.clickX / scale);
    const y = Math.round(field.clickY / scale);
    console.log(`[Autopilot] Field "${field.label}" type=${field.type} answer="${field.answer}" raw=(${field.clickX},${field.clickY}) scaled=(${x},${y})`);

    try {
      if (process.platform === 'darwin') {
        await macClickAt(x, y);
        console.log(`[Autopilot] Click done at (${x},${y})`);
      } else {
        await winClickAt(x, y);
      }
      await sleep(400);

      // If text/select field, type the answer after clicking
      if ((field.type === 'text' || field.type === 'select') && field.answer) {
        if (process.platform === 'darwin') {
          await execPromise(`osascript -e 'tell application "System Events" to keystroke "a" using command down'`, 3000);
          await sleep(100);
          const escaped = field.answer.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "'\\''");
          await execPromise(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`, 15000);
        } else {
          await execPromise(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^a'); Start-Sleep -Milliseconds 100; [System.Windows.Forms.SendKeys]::SendWait('${field.answer.replace(/[+^%~(){}[\]]/g, '{$&}')}')"`, 15000);
        }
      }

      results.push({ label: field.label || '?', ok: true });
      await sleep(300);
    } catch (err) {
      console.log(`[Autopilot] Click error:`, err.message);
      results.push({ label: field.label || '?', ok: false, reason: err.message });
    }
  }

  // Show overlay again with results
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.show();
    overlayUp = true;
    initScreenCaptureDetection();
  }

  return { success: true, results, filled: results.filter(r => r.ok).length, total: results.length };
});

ipcMain.on('open-settings', () => makeSettings());

ipcMain.on('open-app', () => {
  // Show the settings window as the "main app"
  makeSettings();
});

ipcMain.handle('get-settings', () => store.store);

ipcMain.on('save-settings', (_ev, s) => {
  // Block renderer from modifying license/auth fields
  const protectedKeys = ['licenseKey','licenseValid','licenseEmail','stripeCustomerId','stripeSubscriptionId','subscriptionStatus','authDone','authPasswordHash','onboardingDone'];
  for (const [k, v] of Object.entries(s)) { if (!protectedKeys.includes(k)) store.set(k, v); }
  bindKeys();
  applyProcessDisguise(); // Re-apply disguise if lockdown mode was toggled
  if (s.startAtLogin !== undefined) {
    try { app.setLoginItemSettings({ openAtLogin: s.startAtLogin }); } catch (_) {}
  }
  // Content protection always on
  try { if (overlayWin) overlayWin.setContentProtection(true); } catch (_) {}
  if (overlayWin)  overlayWin.webContents.send('load-settings', store.store);
  if (settingsWin) settingsWin.webContents.send('settings-saved');
});

/* ─────────────────── AI Request ─────────────────── */

ipcMain.handle('ai-request', async (_ev, { mode, text, imageDataUrl, region, language }) => {
  // Block AI usage for unlicensed users
  if (!isLicensed()) return { error: 'Subscription required. Please subscribe to use Zap.' };
  // Track usage analytics
  trackUsage(mode || 'answer');

  // Determine which AI provider to use:
  // - Research mode → Perplexity (has web search built in)
  // - Everything else → OpenAI GPT-4o (better vision, accuracy, JSON)
  const usePerplexity = (mode === 'research');

  let apiKey, endpoint, model;
  const tokens = store.get('maxTokens');

  if (usePerplexity) {
    // Perplexity for research
    apiKey = BUILT_IN_API_KEY;
    if (apiKey === API_PLACEHOLDER) {
      const stored = store.get('apiKey');
      if (stored && stored !== API_PLACEHOLDER && stored.length > 10) apiKey = stored;
    }
    endpoint = 'https://api.perplexity.ai/chat/completions';
    model = 'sonar-pro';
  } else {
    // OpenAI GPT-4o for all other modes
    apiKey = OPENAI_API_KEY;
    if (apiKey === OPENAI_KEY_PLACEHOLDER) {
      const stored = store.get('openaiKey');
      if (stored && stored !== OPENAI_KEY_PLACEHOLDER && stored.length > 10) apiKey = stored;
    }
    // Fallback to Perplexity if OpenAI key not available
    if (!apiKey || apiKey === OPENAI_KEY_PLACEHOLDER) {
      apiKey = BUILT_IN_API_KEY;
      if (apiKey === API_PLACEHOLDER) {
        const stored = store.get('apiKey');
        if (stored && stored !== API_PLACEHOLDER && stored.length > 10) apiKey = stored;
      }
      endpoint = 'https://api.perplexity.ai/chat/completions';
      model = 'sonar-pro';
    } else {
      endpoint = 'https://api.openai.com/v1/chat/completions';
      model = 'gpt-4o';
    }
  }

  if (!apiKey || apiKey === API_PLACEHOLDER || apiKey === OPENAI_KEY_PLACEHOLDER) {
    return { error: 'API key not configured. Please reinstall Zap or contact support.' };
  }

  console.log(`[AI] Mode: ${mode}, Provider: ${endpoint.includes('openai') ? 'OpenAI GPT-4o' : 'Perplexity'}`);


  // If we have nothing (no text, no image), show helpful error
  if (!text && !imageDataUrl) {
    if (isLockdown()) {
      return { error: 'Lockdown Mode is active — screen capture is disabled.\nPress Tab to type your question, then press Enter.' };
    }
    return { error: 'Screen capture failed. Please try:\n1. Open System Settings → Privacy & Security → Screen Recording\n2. Toggle Zap OFF then ON again\n3. Quit Zap completely (right-click tray → Quit) and reopen it' };
  }

  const prompts = {
    answer:    "You are a helpful AI assistant. ALWAYS start your response with the direct answer on the first line, clearly stated. Then leave a blank line and provide a brief explanation if needed. For math problems: state the final answer first (e.g. 'Answer: 42' or 'The integral equals 2x³ + C'), then show key steps below. FORMATTING RULES: Never use LaTeX commands like \\frac{}{}, \\left, \\right, \\int, \\sum, \\sqrt, etc. Instead write math in plain readable text: use / for fractions (e.g. '3/4' not '\\frac{3}{4}'), ^ for exponents (e.g. 'x^2'), sqrt() for roots, and Unicode symbols where helpful (∫, Σ, π, ∞, ², ³). Keep responses concise — no more than 8-10 lines. If the content contains math or science notation in the image, read it VERY carefully. Pay close attention to exponents, fractions, subscripts, and special symbols.",
    simple:    "You are a helpful AI assistant. Give ONLY the final answer — no explanation, no steps, no reasoning, no extra words. If it's a math problem, just the number or expression. If it's a question, just the answer. If it's multiple choice, just the letter. Nothing else. NEVER use LaTeX commands — write math in plain text with / for fractions, ^ for exponents, sqrt() for roots. Read mathematical notation from the image extremely carefully.",
    translate: `You are a professional translator. Translate ALL the provided text into ${language || store.get('language')}. Only provide the translation, no explanations.`,
    summarize: 'You are an expert summarizer. Start with a one-line summary, then key takeaways. Be concise. Never use LaTeX formatting.',
    explain:   'You are an expert teacher. Start with the direct answer, then explain step by step. Keep it clear and readable. NEVER use LaTeX commands like \\frac, \\left, \\right — write math in plain text with / for fractions, ^ for exponents, sqrt() for roots, and Unicode symbols (∫, Σ, π, ², ³). If the content contains math or science, read all notation from the image VERY carefully.',
    solve:     'You are an expert tutor. Solve the problem step-by-step, showing ALL work exactly as a student would write it on paper. Number each step clearly. State the final answer on its own line at the end (e.g. "Final Answer: 42"). NEVER use LaTeX — write math in plain text with / for fractions, ^ for exponents, sqrt() for roots, and Unicode symbols (∫, Σ, π, ∞, ², ³). Read all notation from the image VERY carefully.',
    essay:     'You are an academic essay writer. Write a well-structured essay on the topic shown. Include: a clear thesis statement, 3-4 body paragraphs with topic sentences and supporting evidence, and a strong conclusion. Use formal academic tone. Aim for 500-800 words. Write in proper paragraph form — no bullet points or lists.',
    code:      'You are an expert programmer. Write clean, well-documented code to solve the problem shown. Use markdown code blocks with the correct language specifier (e.g. ```python, ```javascript, ```java, ```cpp). Include comments explaining key logic. Follow best practices: meaningful variable names, error handling, efficiency. If the language is not specified, infer it from context.',
    research:  store.get('credibleSourcesOnly')
      ? 'You are a research specialist. Provide a thorough analysis using ONLY credible academic and institutional sources (.edu, .org, .gov domains). Do NOT cite .com or commercial sources. Structure: 1) Brief overview, 2) Key findings with data from credible sources only, 3) References — list only .edu/.org/.gov URLs. Be factual and thorough.'
      : 'You are a research specialist. Provide a thorough, well-organized analysis of the topic shown. Structure your response as: 1) Brief overview, 2) Key findings with specific details and data, 3) Sources and references at the end. Use real, credible sources where possible. Be factual and detailed.',
    email:     'You are a professional communication expert. Draft a polished email reply based on the context shown on screen. Match the tone and formality of the original message. Include an appropriate greeting, clear and concise body, and professional closing. Return ONLY the email text — no Subject line, no "To:" field, no metadata.',
    flashcards:'You are an educational content creator. Generate 5-8 Q&A flashcards from the material shown on screen. Format each as: **Q:** [question] followed by **A:** [concise answer]. Focus on key concepts, definitions, formulas, and important facts. Number each flashcard.',
    autopilot: 'You are a quiz/form auto-fill AI. Analyze the screenshot and identify ALL visible questions and form fields. Return ONLY valid JSON — no markdown, no code fences, no explanation. Format: {"fields":[{"label":"question or field label","type":"radio","answer":"the correct answer","clickX":123,"clickY":456}],"nextBtn":null}. Field types: "radio" for multiple choice (clickX/clickY = center of the correct radio button/option to click), "checkbox" for checkboxes, "text" for text inputs or textareas (clickX/clickY = center of the input field), "select" for dropdowns. Coordinates must be in pixels matching the image dimensions, measured from top-left corner. For multiple choice: identify the CORRECT answer and provide coordinates of that specific option. Answer every question correctly using your knowledge. Be extremely precise with coordinates — they will be used to click.'
  };

  // If simpleMode toggle is ON, override 'answer' mode to use 'simple' prompt
  const effectiveMode = (mode === 'answer' && store.get('simpleMode')) ? 'simple' : mode;
  const msgs = [{ role: 'system', content: prompts[effectiveMode] || prompts.answer }];

  // Build user message — include image if available (GPT-4o has excellent vision)
  const parts = [];
  if (text && imageDataUrl) {
    // Both OCR text and image available — tell AI to prefer the image for math
    parts.push({ type: 'text', text: text + '\n\n[NOTE: The above text was extracted via OCR and may contain errors, especially with math notation like exponents, fractions, and symbols. ALWAYS rely on the attached image for the exact notation — the image is the ground truth.]' });
  } else if (text) {
    parts.push({ type: 'text', text: text });
  } else {
    parts.push({ type: 'text', text: 'Analyze the selected screen region shown in the image. Read any visible text carefully and respond accordingly. Pay extra attention to mathematical notation — exponents, fractions, integrals, subscripts, and special symbols.' });
  }
  if (imageDataUrl) {
    parts.push({ type: 'image_url', image_url: { url: imageDataUrl } });
  }
  // If we only have text (no image), send as simple string for compatibility
  if (parts.length === 1 && parts[0].type === 'text') {
    msgs.push({ role: 'user', content: parts[0].text });
  } else {
    msgs.push({ role: 'user', content: parts });
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages: msgs, max_tokens: tokens, temperature: 0 })
    });
    if (!res.ok) return { error: `API Error (${res.status}): ${await res.text()}` };
    const data = await res.json();
    return { result: data.choices?.[0]?.message?.content || 'No response received.', usage: data.usage };
  } catch (err) {
    return { error: 'Request failed: ' + err.message };
  }
});

/* ─────────────────── License / Activation ─────────────────── */

let activateWin = null;

function isLicensed() {
  // Only a valid license key grants access — no trials
  return !!(store.get('licenseValid') && store.get('licenseKey'));
}

function trialDaysLeft() {
  const trialStart = store.get('trialStarted');
  if (!trialStart) return 0;
  const trialDays = store.get('trialDays') || 7;
  const elapsed = (Date.now() - trialStart) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.ceil(trialDays - elapsed));
}

function showActivate() {
  if (activateWin) { activateWin.focus(); return; }

  // Show dock so the activate window can be focused on macOS
  if (process.platform === 'darwin') app.dock?.show();

  activateWin = new BrowserWindow({
    width: 520, height: 620,
    resizable: false, minimizable: false, maximizable: false,
    title: 'Activate Zap',
    backgroundColor: '#0a0a12',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  activateWin.loadFile(path.join(__dirname, 'activate.html'));
  try { activateWin.setContentProtection(true); } catch (_) {}
  activateWin.once('ready-to-show', () => { activateWin.show(); activateWin.focus(); });
  activateWin.on('closed', () => {
    activateWin = null;
    if (isLicensed()) {
      if (process.platform === 'darwin') app.dock?.hide();
    } else {
      // Don't quit — stay in tray so user can re-open via hotkey or tray menu
      if (process.platform === 'darwin') app.dock?.hide();
    }
  });
}

ipcMain.on('start-trial', () => {
  // Trial disabled — license key required for access
  // Do nothing — user must enter a license key
});

// Admin master keys defined at top of file

function proceedAfterLicense() {
  // Close activate window (the closed handler will check isLicensed and hide dock)
  if (activateWin) { activateWin.close(); activateWin = null; }
  // Now that user is licensed, create overlay and bind hotkeys
  if (!overlayWin) makeOverlay();
  bindKeys();
  // Tour already happened before payment — just hide dock and run
  if (process.platform === 'darwin') app.dock?.hide();
}

// Admin key validation (still works for admin access)
ipcMain.handle('validate-license', async (_ev, key) => {
  if (!key || key.trim().length < 5) return { valid: false, error: 'Please enter a valid key.' };

  if (ADMIN_KEYS.includes(key.trim())) {
    store.set('licenseKey', key.trim());
    store.set('licenseValid', true);
    store.set('licenseEmail', 'admin@tryzap.net');
    proceedAfterLicense();
    return { valid: true, email: 'admin@tryzap.net', admin: true };
  }

  return { valid: false, error: 'Please use the Subscribe button to get access.' };
});

// Create Stripe Checkout Session for monthly subscription
ipcMain.handle('create-checkout-session', async (_ev, email) => {
  try {
    const stripe = getStripe();
    if (!stripe) return { error: 'Payment system not configured. Please reinstall Zap or contact support.' };

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: email || undefined,
      subscription_data: { trial_period_days: 3 },
      success_url: 'https://tryzap.net/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://tryzap.net/checkout/cancel',
      metadata: { app: 'zap', hostname: require('os').hostname() }
    });

    return { sessionId: session.id, url: session.url };
  } catch (err) {
    console.error('Stripe session creation failed:', err.message);
    return { error: err.message };
  }
});

// Open Stripe Checkout in a popup BrowserWindow
let checkoutWin = null;
let checkoutSucceeded = false;

ipcMain.handle('open-checkout-window', async (_ev, url, sessionId) => {
  if (checkoutWin) { checkoutWin.focus(); return { opened: true }; }

  checkoutSucceeded = false;

  // Show dock so checkout window can be focused
  if (process.platform === 'darwin') app.dock?.show();

  checkoutWin = new BrowserWindow({
    width: 500, height: 700,
    resizable: true, minimizable: false, maximizable: false,
    title: 'Zap — Subscribe',
    backgroundColor: '#0a0a12',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  checkoutWin.loadURL(url);
  try { checkoutWin.setContentProtection(true); } catch (_) {}

  // Monitor navigation — detect success redirect
  checkoutWin.webContents.on('will-redirect', async (_e, redirectUrl) => {
    if (redirectUrl.includes('/checkout/success') && redirectUrl.includes('session_id=')) {
      const sid = new URL(redirectUrl).searchParams.get('session_id') || sessionId;
      const result = await activateFromSession(sid);
      if (result.valid) {
        checkoutSucceeded = true;
        if (checkoutWin && !checkoutWin.isDestroyed()) checkoutWin.close();
      }
    }
    // Handle cancel URL — auto-close checkout window
    if (redirectUrl.includes('/checkout/cancel')) {
      if (checkoutWin && !checkoutWin.isDestroyed()) checkoutWin.close();
    }
  });

  // Also check on any navigation (some redirects don't fire will-redirect)
  checkoutWin.webContents.on('did-navigate', async (_e, navUrl) => {
    if (navUrl.includes('/checkout/success')) {
      const sid = (() => { try { return new URL(navUrl).searchParams.get('session_id'); } catch (_) { return sessionId; } })();
      const result = await activateFromSession(sid || sessionId);
      if (result.valid) {
        checkoutSucceeded = true;
        if (checkoutWin && !checkoutWin.isDestroyed()) checkoutWin.close();
      }
    }
    // Handle cancel URL
    if (navUrl.includes('/checkout/cancel')) {
      if (checkoutWin && !checkoutWin.isDestroyed()) checkoutWin.close();
    }
  });

  checkoutWin.on('closed', () => {
    checkoutWin = null;
    if (process.platform === 'darwin' && isLicensed()) app.dock?.hide();

    // Notify activate window that checkout closed without success
    if (!checkoutSucceeded && activateWin && !activateWin.isDestroyed()) {
      activateWin.webContents.send('checkout-cancelled');
    }
  });

  return { opened: true };
});

// Validate subscription from a Checkout Session and activate
async function activateFromSession(sessionId) {
  try {
    const stripe = getStripe();
    if (!stripe) return { valid: false, error: 'Stripe not configured' };

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session.subscription) return { valid: false, error: 'No subscription in session' };

    const sub = await stripe.subscriptions.retrieve(session.subscription);

    if (sub.status === 'active' || sub.status === 'trialing') {
      const customer = typeof sub.customer === 'string'
        ? await stripe.customers.retrieve(sub.customer)
        : sub.customer;

      store.set('licenseKey', sub.id);
      store.set('stripeCustomerId', typeof sub.customer === 'string' ? sub.customer : sub.customer.id);
      store.set('stripeSubscriptionId', sub.id);
      store.set('stripeEmail', customer.email || '');
      store.set('subscriptionStatus', sub.status);
      store.set('licenseValid', true);
      store.set('licenseEmail', customer.email || '');
      store.set('lastSubscriptionCheck', Date.now());

      proceedAfterLicense();
      return { valid: true, email: customer.email };
    }

    // Provide clear, actionable error messages
    const statusErrors = {
      past_due: 'Payment failed. Please update your card and try again.',
      canceled: 'This subscription has been cancelled.',
      unpaid: 'Payment is overdue. Please update your payment method.',
      incomplete: 'Payment did not complete. Please try again.',
      incomplete_expired: 'Payment session expired. Please subscribe again.'
    };

    return { valid: false, error: statusErrors[sub.status] || ('Subscription status: ' + sub.status) };
  } catch (err) {
    console.error('activateFromSession failed:', err.message);
    return { valid: false, error: err.message };
  }
}

// Validate subscription from stored session ID (called from renderer)
ipcMain.handle('validate-stripe-subscription', async (_ev, sessionId) => {
  return activateFromSession(sessionId);
});

// Check subscription status on app start (once per 24 hours)
async function checkSubscriptionStatus() {
  const subId = store.get('stripeSubscriptionId');
  if (!subId) return; // No Stripe subscription — might be admin key

  const lastCheck = store.get('lastSubscriptionCheck') || 0;
  const ONE_DAY = 24 * 60 * 60 * 1000;
  if (Date.now() - lastCheck < ONE_DAY) return; // Checked recently

  try {
    const stripe = getStripe();
    if (!stripe) return;

    const sub = await stripe.subscriptions.retrieve(subId);

    store.set('subscriptionStatus', sub.status);

    if (sub.status === 'active' || sub.status === 'trialing') {
      store.set('licenseValid', true);
      store.set('lastSubscriptionCheck', Date.now());
    } else {
      // past_due, canceled, unpaid, incomplete, expired — revoke access
      store.set('licenseValid', false);
    }
  } catch (err) {
    console.warn('Subscription check failed:', err.message);
    // If offline, keep current license state — don't lock out
  }
}

ipcMain.handle('get-license-status', () => {
  return {
    licensed: isLicensed(),
    hasKey: !!store.get('licenseKey'),
    licenseValid: store.get('licenseValid'),
    trialActive: store.get('trialStarted') > 0 && trialDaysLeft() > 0,
    trialDaysLeft: trialDaysLeft(),
    email: store.get('licenseEmail') || '',
    subscriptionId: store.get('stripeSubscriptionId') || '',
    subscriptionStatus: store.get('subscriptionStatus') || 'inactive'
  };
});

/* ─────────────────── Subscription Management ─────────────────── */

ipcMain.handle('get-subscription-info', async () => {
  const subId = store.get('stripeSubscriptionId');
  const info = {
    active: isLicensed(),
    email: store.get('licenseEmail') || store.get('authEmail') || '',
    subscriptionId: subId || '',
    status: store.get('subscriptionStatus') || 'inactive',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    isAdmin: ADMIN_KEYS.includes(store.get('licenseKey'))
  };

  // Fetch live data from Stripe if we have a subscription
  if (subId) {
    try {
      const stripe = getStripe();
      if (stripe) {
        const sub = await stripe.subscriptions.retrieve(subId);
        info.status = sub.status;
        info.cancelAtPeriodEnd = sub.cancel_at_period_end;
        info.currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null;
        store.set('subscriptionStatus', sub.status);
      }
    } catch (_) {}
  }

  return info;
});

ipcMain.handle('cancel-subscription', async () => {
  const subId = store.get('stripeSubscriptionId');
  if (!subId) return { success: false, error: 'No subscription found.' };

  try {
    const stripe = getStripe();
    if (!stripe) return { success: false, error: 'Payment system not configured.' };

    // Cancel at period end — user keeps access until billing cycle ends
    const sub = await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
    store.set('subscriptionStatus', sub.status);
    return {
      success: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('reactivate-subscription', async () => {
  const subId = store.get('stripeSubscriptionId');
  if (!subId) return { success: false, error: 'No subscription found.' };

  try {
    const stripe = getStripe();
    if (!stripe) return { success: false, error: 'Payment system not configured.' };

    const sub = await stripe.subscriptions.update(subId, { cancel_at_period_end: false });
    store.set('subscriptionStatus', sub.status);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('create-billing-portal', async () => {
  const customerId = store.get('stripeCustomerId');
  if (!customerId) return { error: 'No customer record found.' };

  try {
    const stripe = getStripe();
    if (!stripe) return { error: 'Payment system not configured.' };

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: 'https://tryzap.net'
    });

    return { url: session.url };
  } catch (err) {
    return { error: err.message };
  }
});

/* ─────────────────── Auth / Sign Up / Sign In ─────────────────── */

let authWin = null;

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash.toString(36);
}

function showAuth() {
  if (authWin) { authWin.focus(); return; }

  // Show dock temporarily so auth window can be focused on macOS
  if (process.platform === 'darwin') app.dock?.show();

  authWin = new BrowserWindow({
    width: 520, height: 660,
    resizable: false, minimizable: false, maximizable: false,
    title: 'Zap — Sign In',
    backgroundColor: '#0a0a12',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  authWin.loadFile(path.join(__dirname, 'auth.html'));
  try { authWin.setContentProtection(true); } catch (_) {}
  authWin.once('ready-to-show', () => { authWin.show(); authWin.focus(); });
  authWin.on('closed', () => {
    authWin = null;
    // Hide dock again after auth window closes
    if (process.platform === 'darwin') app.dock?.hide();
  });
}

ipcMain.handle('auth-signup', async (_ev, { name, email, password }) => {
  if (!name || !email || !password) return { success: false, error: 'All fields are required.' };
  if (password.length < 6) return { success: false, error: 'Password must be at least 6 characters.' };

  // Check if account already exists with different email
  const existingEmail = store.get('authEmail');
  if (existingEmail && existingEmail !== email) {
    return { success: false, error: 'An account already exists. Please sign in instead.' };
  }

  // Store account locally
  store.set('authName', name);
  store.set('authEmail', email);
  store.set('authPasswordHash', simpleHash(password));
  store.set('authDone', true);

  return { success: true };
});

ipcMain.handle('auth-signin', async (_ev, { email, password }) => {
  if (!email || !password) return { success: false, error: 'Email and password are required.' };

  const storedEmail = store.get('authEmail');
  const storedHash = store.get('authPasswordHash');

  if (!storedEmail) {
    return { success: false, error: 'No account found. Please sign up first.' };
  }

  if (email !== storedEmail) {
    return { success: false, error: 'Invalid email or password.' };
  }

  if (simpleHash(password) !== storedHash) {
    return { success: false, error: 'Invalid email or password.' };
  }

  store.set('authDone', true);
  return { success: true };
});

ipcMain.on('auth-done', () => {
  store.set('authDone', true);
  if (authWin) { authWin.close(); authWin = null; }

  // After auth, show tour first, then payment
  if (!store.get('onboardingDone')) {
    showWelcome();
  } else if (!isLicensed()) {
    showActivate();
  }
});

/* ─────────────────── Welcome / First Launch ─────────────────── */

let welcomeWin = null;

function showWelcome() {
  if (welcomeWin) { welcomeWin.focus(); return; }

  // Show dock temporarily so welcome window can be focused on macOS
  if (process.platform === 'darwin') app.dock?.show();

  welcomeWin = new BrowserWindow({
    width: 760, height: 600,
    resizable: false, minimizable: false, maximizable: false,
    title: 'Welcome to Zap',
    backgroundColor: '#0a0a12',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  welcomeWin.loadFile(path.join(__dirname, 'welcome.html'));
  try { welcomeWin.setContentProtection(true); } catch (_) {}
  welcomeWin.once('ready-to-show', () => { welcomeWin.show(); welcomeWin.focus(); });
  welcomeWin.on('closed', () => {
    welcomeWin = null;
    // Hide dock again after welcome window closes
    if (process.platform === 'darwin') app.dock?.hide();
  });
}

ipcMain.on('welcome-done', () => {
  store.set('onboardingDone', true);
  if (welcomeWin) { welcomeWin.close(); welcomeWin = null; }

  // After tour, require payment if not licensed
  if (!isLicensed()) {
    showActivate();
  } else {
    if (process.platform === 'darwin') app.dock?.hide();
  }
});

/* ─────────────────── Replay Tour ─────────────────── */

ipcMain.on('replay-tour', () => {
  showWelcome();
});

/* ─────────────────── Changelog ─────────────────── */

ipcMain.handle('get-changelog', async () => {
  try {
    const res = await fetch('https://api.github.com/repos/Salt30/Zap/releases?per_page=10');
    if (!res.ok) return [];
    const releases = await res.json();
    return releases.map(r => ({
      version: (r.tag_name || '').replace(/^v/, ''),
      name: r.name || r.tag_name,
      date: r.published_at ? new Date(r.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
      body: r.body || ''
    }));
  } catch (_) {
    return [];
  }
});

/* ─────────────────── Auto Update ─────────────────── */

ipcMain.handle('get-app-version', () => {
  return require('../package.json').version;
});

ipcMain.handle('open-external', async (_ev, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { success: true };
  }
  return { success: false };
});

// Proper semver comparison: returns true if a > b (e.g. "3.4.0" > "3.3.3")
function isNewerVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false; // equal
}

ipcMain.handle('check-for-updates', async () => {
  try {
    const currentVersion = require('../package.json').version;
    const res = await fetch('https://api.github.com/repos/Salt30/Zap/releases/latest');
    if (!res.ok) return { upToDate: true, current: currentVersion };
    const data = await res.json();
    const latest = (data.tag_name || '').replace(/^v/, '');
    if (!latest) return { upToDate: true, current: currentVersion };

    // Only show update if latest release is actually newer than current version
    if (!isNewerVersion(latest, currentVersion)) return { upToDate: true, current: currentVersion };

    // Find all platform download URLs
    const assets = data.assets || [];
    const find = (ext) => { const a = assets.find(x => x.name.endsWith(ext)); return a ? a.browser_download_url : null; };
    return {
      upToDate: false,
      current: currentVersion,
      latest: latest,
      downloads: {
        macDmg: find('.dmg'),
        macZip: find('-mac.zip'),
        winExe: find('.exe'),
        winZip: find('-win.zip')
      },
      releaseUrl: data.html_url
    };
  } catch (_) {
    return { upToDate: true, error: 'Could not check for updates' };
  }
});

/* ─────────────────── Admin & Support ─────────────────── */

ipcMain.handle('is-admin', () => isAdmin());

ipcMain.handle('get-admin-stats', () => {
  if (!isAdmin()) return { error: 'Not authorized' };
  const firstLaunch = store.get('statsFirstLaunch') || Date.now();
  const daysSince = Math.max(1, Math.ceil((Date.now() - firstLaunch) / (1000 * 60 * 60 * 24)));
  return {
    firstLaunch: new Date(firstLaunch).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    totalSessions: store.get('statsTotalSessions') || 0,
    totalRequests: store.get('statsTotalRequests') || 0,
    lastUsed: store.get('statsLastUsed') ? new Date(store.get('statsLastUsed')).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never',
    daysSinceInstall: daysSince,
    avgRequestsPerDay: ((store.get('statsTotalRequests') || 0) / daysSince).toFixed(1),
    modes: {
      answer: store.get('statsAnswerCount') || 0,
      translate: store.get('statsTranslateCount') || 0,
      autopilot: store.get('statsAutopilotCount') || 0,
      dripType: store.get('statsDripTypeCount') || 0,
      summarize: store.get('statsSummarizeCount') || 0,
      explain: store.get('statsExplainCount') || 0
    },
    user: {
      name: store.get('authName') || 'Unknown',
      email: store.get('authEmail') || 'Unknown',
      licenseKey: store.get('licenseKey') || 'None',
      licenseEmail: store.get('licenseEmail') || '',
      platform: process.platform,
      version: require('../package.json').version,
      electronVersion: process.versions.electron
    },
    tickets: store.get('supportTickets') || []
  };
});

/* ─────────────────── Support Tickets (GitHub Issues Backend) ─────────────────── */

function getGitHubToken() {
  if (GITHUB_SUPPORT_TOKEN !== GITHUB_SUPPORT_PLACEHOLDER) return GITHUB_SUPPORT_TOKEN;
  return null;
}

async function ghAPI(method, endpoint, body) {
  const token = getGitHubToken();
  if (!token) throw new Error('Support system not configured.');
  const opts = {
    method,
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Zap-App'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.github.com${endpoint}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }
  return res.json();
}

ipcMain.handle('submit-ticket', async (_ev, { subject, description, email }) => {
  if (!subject || !description) return { success: false, error: 'Subject and description are required.' };

  const userEmail = email || store.get('authEmail') || '';
  const userName = store.get('authName') || 'Anonymous';
  const version = require('../package.json').version;

  // Build GitHub Issue body with metadata
  const body = [
    description.trim(),
    '',
    '---',
    `**User:** ${userName}`,
    `**Email:** ${userEmail}`,
    `**Platform:** ${process.platform}`,
    `**Version:** v${version}`,
    `**Submitted:** ${new Date().toISOString()}`
  ].join('\n');

  try {
    const issue = await ghAPI('POST', `/repos/${GITHUB_REPO}/issues`, {
      title: `[Support] ${subject.trim()}`,
      body,
      labels: ['support']
    });

    // Also cache locally for offline viewing
    const ticket = {
      id: String(issue.number),
      ghNumber: issue.number,
      subject: subject.trim(),
      description: description.trim(),
      email: userEmail,
      userName,
      platform: process.platform,
      version,
      status: 'open',
      createdAt: issue.created_at,
      ghUrl: issue.html_url
    };
    const tickets = store.get('supportTickets') || [];
    tickets.unshift(ticket);
    store.set('supportTickets', tickets);

    return { success: true, ticketId: '#' + issue.number, url: issue.html_url };
  } catch (err) {
    // Fallback to local-only if GitHub API fails
    const ticket = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      subject: subject.trim(),
      description: description.trim(),
      email: userEmail,
      userName,
      platform: process.platform,
      version,
      status: 'open',
      createdAt: new Date().toISOString()
    };
    const tickets = store.get('supportTickets') || [];
    tickets.unshift(ticket);
    store.set('supportTickets', tickets);
    return { success: true, ticketId: ticket.id, offline: true };
  }
});

ipcMain.handle('get-tickets', async () => {
  // Try fetching from GitHub first for the user's email
  const token = getGitHubToken();
  const userEmail = store.get('authEmail') || store.get('licenseEmail') || '';

  if (token && userEmail) {
    try {
      // Fetch support issues, match by email in the body
      const issues = await ghAPI('GET', `/repos/${GITHUB_REPO}/issues?labels=support&state=all&per_page=50&sort=created&direction=desc`);
      const userTickets = issues.filter(i => i.body && i.body.includes(userEmail));

      // Fetch comments for each ticket to get admin replies
      const tickets = await Promise.all(userTickets.map(async (i) => {
        let status = 'open';
        if (i.state === 'closed') status = 'resolved';
        if (i.labels.some(l => l.name === 'in-progress')) status = 'in-progress';
        if (i.labels.some(l => l.name === 'resolved')) status = 'resolved';
        if (i.labels.some(l => l.name === 'wont-fix')) status = 'closed';

        // Get the latest admin reply from comments
        let adminReply = null;
        try {
          const comments = await ghAPI('GET', `/repos/${GITHUB_REPO}/issues/${i.number}/comments?per_page=10`);
          const adminComments = comments.filter(c => c.body && c.body.startsWith('**Admin Reply:**'));
          if (adminComments.length > 0) {
            adminReply = adminComments[adminComments.length - 1].body.replace('**Admin Reply:**\n\n', '').trim();
          }
        } catch (_) {}

        return {
          id: String(i.number),
          ghNumber: i.number,
          subject: (i.title || '').replace(/^\[Support\]\s*/, ''),
          status,
          createdAt: i.created_at,
          ghUrl: i.html_url,
          adminReply
        };
      }));

      // Update local cache
      store.set('supportTickets', tickets);
      return tickets;
    } catch (_) {
      // Fall back to local cache
    }
  }

  // For admin, fetch ALL support tickets
  if (isAdmin() && token) {
    try {
      const issues = await ghAPI('GET', `/repos/${GITHUB_REPO}/issues?labels=support&state=all&per_page=100&sort=created&direction=desc`);
      return issues.map(i => {
        let status = 'open';
        if (i.state === 'closed') status = 'resolved';
        if (i.labels.some(l => l.name === 'in-progress')) status = 'in-progress';
        if (i.labels.some(l => l.name === 'resolved')) status = 'resolved';
        if (i.labels.some(l => l.name === 'wont-fix')) status = 'closed';

        // Extract email from body
        const emailMatch = (i.body || '').match(/\*\*Email:\*\*\s*(.+)/);
        const nameMatch = (i.body || '').match(/\*\*User:\*\*\s*(.+)/);

        return {
          id: String(i.number),
          ghNumber: i.number,
          subject: (i.title || '').replace(/^\[Support\]\s*/, ''),
          description: (i.body || '').split('\n---')[0].trim(),
          email: emailMatch ? emailMatch[1].trim() : '',
          userName: nameMatch ? nameMatch[1].trim() : '',
          status,
          createdAt: i.created_at,
          ghUrl: i.html_url
        };
      });
    } catch (_) {}
  }

  return store.get('supportTickets') || [];
});

function extractAdminReply(body) {
  if (!body) return null;
  const match = body.match(/\*\*Admin Reply:\*\*\s*([\s\S]+?)(?:\n---|$)/);
  return match ? match[1].trim() : null;
}

ipcMain.handle('update-ticket-status', async (_ev, { ticketId, status, reply }) => {
  if (!isAdmin()) return { error: 'Not authorized' };

  const token = getGitHubToken();
  if (!token) return { error: 'Support system not configured.' };

  const issueNumber = parseInt(ticketId);
  if (!issueNumber) return { error: 'Invalid ticket ID.' };

  try {
    // Update labels based on status
    const labelsToSet = ['support'];
    let ghState = 'open';

    if (status === 'in-progress') labelsToSet.push('in-progress');
    if (status === 'resolved') { labelsToSet.push('resolved'); ghState = 'closed'; }
    if (status === 'closed' || status === 'wont-fix') { labelsToSet.push('wont-fix'); ghState = 'closed'; }

    await ghAPI('PATCH', `/repos/${GITHUB_REPO}/issues/${issueNumber}`, {
      state: ghState,
      labels: labelsToSet
    });

    // Add admin reply as a comment if provided
    if (reply && reply.trim()) {
      await ghAPI('POST', `/repos/${GITHUB_REPO}/issues/${issueNumber}/comments`, {
        body: `**Admin Reply:**\n\n${reply.trim()}`
      });
    }

    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

/* ─────────────────── Process Disguise (Lockdown Mode) ─────────────────── */

function applyProcessDisguise() {
  if (!isLockdown()) return;
  // Disguise process title so lockdown browsers don't recognize "Zap" or "Electron"
  try { process.title = 'SystemUIServer'; } catch (_) {}
  // On macOS, set app name to something innocuous
  if (process.platform === 'darwin') {
    try { app.setName('System Preferences Helper'); } catch (_) {}
  } else {
    try { app.setName('WindowsSecurityHealth'); } catch (_) {}
  }
}

/* ─────────────────── App Lifecycle ─────────────────── */

app.whenReady().then(async () => {
  // Initialize store AFTER app is ready so getPath('userData') works
  initStore();
  initAnalytics();
  applyProcessDisguise(); // Disguise process name if lockdown mode is active
  await checkSubscriptionStatus(); // Verify Stripe subscription — blocks until resolved

  // Tray is always available (for Quit, Settings, etc.)
  makeTray();

  // Only create overlay and bind hotkeys if user is fully licensed
  if (isLicensed()) {
    makeOverlay();
    bindKeys();
  }

  // Start screen capture detection — hides overlay during screen recording/sharing
  initScreenCaptureDetection();

  // Flow: Auth → Welcome Tour → Payment → App
  if (!store.get('authDone')) {
    showAuth();
  } else if (!store.get('onboardingDone')) {
    showWelcome();
  } else if (!isLicensed()) {
    showActivate();
  } else {
    if (process.platform === 'darwin') app.dock?.hide();
  }

  // Periodic re-validation: check Stripe subscription every 30 minutes
  setInterval(async () => {
    if (isLicensed()) {
      await checkSubscriptionStatus();
      // If subscription was revoked, destroy overlay and unregister keys
      if (!isLicensed()) {
        globalShortcut.unregisterAll();
        if (overlayWin && !overlayWin.isDestroyed()) { overlayWin.hide(); overlayWin.close(); overlayWin = null; overlayUp = false; }
        showActivate();
      }
    }
  }, 30 * 60 * 1000);

  app.on('activate', () => { if (isLicensed() && !overlayWin) makeOverlay(); });
});

app.on('window-all-closed', () => {});
app.on('will-quit', () => { globalShortcut.unregisterAll(); cleanupScreenCaptureDetection(); });

process.on('unhandledRejection',  r => console.warn('Unhandled rejection:', r?.message || r));
process.on('uncaughtException', err => console.error('Uncaught exception:', err.message));

// Dock hide moved into whenReady — see showAuth/showWelcome for temporary show/hide
