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

const STORE_DEFAULTS = {
  apiKey:        BUILT_IN_API_KEY,
  apiEndpoint:   'https://api.perplexity.ai/chat/completions',
  model:         'sonar-pro',
  overlayOpacity: 0.0,
  accentColor:   '#facc15',
  fontSize:      14,
  fontFamily:    'system-ui, -apple-system, sans-serif',
  borderRadius:  12,
  hotkey:          'Alt+3',
  hotkeyAnswer:    'Alt+1',
  hotkeyTranslate: 'Alt+2',
  hotkeyRewrite:   'Alt+4',
  hotkeyDripType:  'Alt+5',
  hotkeyStopDrip:  'Alt+0',
  hotkeyApp:       'Alt+M',
  language:      'Spanish',
  theme:         'dark',
  lastMode:      'answer',
  phantomMode:   false,
  autoEngine:    true,
  maxTokens:     1024,
  dripSpeed:     40,
  dripWPM:       45,
  dripDelay:     10,
  typoRate:      0.06,
  dripPauseChance: 0.03,
  dripBurstChance: 0.08,
  invisibleOverlay: true,
  authDone: false,
  authName: '',
  authEmail: '',
  authPasswordHash: '',
  onboardingDone: false,
  licenseKey: '',
  licenseValid: false,
  licenseEmail: '',
  trialStarted: 0,
  trialDays: 7
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

  return store;
}

/* ─────────────────── Window References ─────────────────── */

let overlayWin  = null;
let settingsWin = null;
let tray        = null;
let overlayUp   = false;

/* ─────────────────── Overlay Window ─────────────────── */

function makeOverlay() {
  if (!store) initStore();
  const display = screen.getPrimaryDisplay();

  overlayWin = new BrowserWindow({
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
  });

  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));

  try { overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  try { overlayWin.setAlwaysOnTop(true, 'floating', 1); } catch (_) { overlayWin.setAlwaysOnTop(true); }

  overlayWin.setIgnoreMouseEvents(false);
  overlayWin.hide();

  // Always enable content protection — fully undetectable
  try { overlayWin.setContentProtection(true); } catch (_) {}

  overlayWin.on('closed', () => { overlayWin = null; });
}

/* ─────────────────── Settings Window ─────────────────── */

function makeSettings() {
  if (settingsWin) { settingsWin.focus(); return; }

  settingsWin = new BrowserWindow({
    width: 600, height: 750,
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

  grabScreen().then(img => {
    if (!overlayWin) return;
    overlayWin.webContents.send('set-mode', mode);
    overlayWin.webContents.send('screen-captured', img);
    overlayWin.webContents.send('load-settings', store.store);
    overlayWin.show();
    overlayWin.focus();
    overlayUp = true;
  }).catch(() => {
    if (!overlayWin) return;
    overlayWin.webContents.send('set-mode', mode);
    overlayWin.webContents.send('screen-captured', null);
    overlayWin.webContents.send('load-settings', store.store);
    overlayWin.show();
    overlayWin.focus();
    overlayUp = true;
  });
}

function toggle() {
  // Block overlay if not licensed
  if (!isLicensed()) { showActivate(); return; }
  if (!overlayWin) makeOverlay();
  if (overlayUp) { overlayWin.hide(); overlayUp = false; }
  else showWithMode(store.get('lastMode') || 'answer');
}

/* ─────────────────── Tray Icon ─────────────────── */

function makeTray() {
  const icon64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA2ElEQVR4nGNgGAWDAfD///8vBuL/eMT/M5AB/v//z4DHgP9QMU4NjFgMYGBgYPj/HwrwGPAfajAbNwMDVAMuA/5DNTNDDcEJ/v+HOuU/PkfhcwYTAwMDA8P/////J9YZYMDIwMDAwIjDgP9QNjMDHrBo0SJGZANYkTgcHBws2AxgRhJjYWRkhIux4HMGCwMDAwMrLgOQ/cyCywBmZBfgMoCZkZERT2CiGsCKLxCZGYkIRGY8schMIBaZscUiEwOe1MjMSCgaGRjwZ2hmIvIzCxYxqjXQGwAAL69DD1mFmEAAAAAASUVORK5CYII=';

  tray = new Tray(nativeImage.createFromDataURL('data:image/png;base64,' + icon64));

  const menu = Menu.buildFromTemplate([
    { label: 'Toggle Overlay', accelerator: store.get('hotkey'), click: toggle },
    { type: 'separator' },
    { label: 'Answer Mode',    click: () => showWithMode('answer')    },
    { label: 'Translate Mode',  click: () => showWithMode('translate')  },
    { label: 'Rewrite Mode',   click: () => showWithMode('rewrite')   },
    { label: 'Drip Type Mode',  click: () => showWithMode('driptype')  },
    { type: 'separator' },
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
  const map = [
    [store.get('hotkey'),          toggle],
    [store.get('hotkeyAnswer'),    () => showWithMode('answer')],
    [store.get('hotkeyTranslate'), () => showWithMode('translate')],
    [store.get('hotkeyRewrite'),   () => showWithMode('rewrite')],
    [store.get('hotkeyDripType'),  () => showWithMode('driptype')],
    [store.get('hotkeyStopDrip'),  () => { dripTypeCancelled = true; }],
    [store.get('hotkeyApp'),       makeSettings],
    // Alt+8 = open overlay menu, Alt+9 = open app (settings)
    ['Alt+8', toggle],
    ['Alt+9', makeSettings]
  ];
  for (const [key, fn] of map) {
    if (!key) continue;
    try { globalShortcut.register(key, fn); } catch (_) {}
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


ipcMain.handle('drip-type', async (_ev, text) => {
  if (!text) return;
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
  if (overlayWin) { overlayWin.hide(); overlayUp = false; }
  // Also cancel drip type if running
  if (dripTypeRunning) dripTypeCancelled = true;
});

ipcMain.on('open-settings', () => makeSettings());

ipcMain.on('open-app', () => {
  // Show the settings window as the "main app"
  makeSettings();
});

ipcMain.handle('get-settings', () => store.store);

ipcMain.on('save-settings', (_ev, s) => {
  for (const [k, v] of Object.entries(s)) store.set(k, v);
  bindKeys();
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
  // Always prefer the built-in key (injected at build time) over stored key
  let apiKey = BUILT_IN_API_KEY;
  // Only use stored key if built-in is still placeholder AND stored key looks real
  if (apiKey === API_PLACEHOLDER) {
    const stored = store.get('apiKey');
    if (stored && stored !== API_PLACEHOLDER && stored.length > 10) apiKey = stored;
  }

  const endpoint = store.get('apiEndpoint');
  const model    = store.get('model');
  const tokens   = store.get('maxTokens');

  if (!apiKey || apiKey === API_PLACEHOLDER) return { error: 'API key not configured. Please reinstall Zap or contact support.' };

  // If we have nothing (no text, no image), show helpful error
  if (!text && !imageDataUrl) {
    return { error: 'Screen capture failed. Please try:\n1. Open System Settings → Privacy & Security → Screen Recording\n2. Toggle Zap OFF then ON again\n3. Quit Zap completely (right-click tray → Quit) and reopen it' };
  }

  const prompts = {
    answer:    "You are a helpful AI assistant. Answer the user's question based on the content provided. Be concise and direct.",
    translate: `You are a professional translator. Translate ALL the provided text into ${language || store.get('language')}. Only provide the translation, no explanations.`,
    summarize: 'You are an expert summarizer. Summarize the provided content in a clear, concise manner. Use bullet points for key takeaways.',
    explain:   'You are an expert teacher. Explain the concept or content provided in a clear and detailed way. Break down complex ideas simply.',
    rewrite:   'You are a professional editor. Rewrite the provided text to be clearer, more professional, and polished. Return only the rewritten text.'
  };

  const msgs = [{ role: 'system', content: prompts[mode] || prompts.answer }];

  // Build user message — include image if available (Perplexity sonar-pro supports vision)
  const parts = [];
  if (text) {
    parts.push({ type: 'text', text: text });
  } else {
    parts.push({ type: 'text', text: 'Analyze the selected screen region shown in the image. Read any visible text and respond accordingly.' });
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
      body: JSON.stringify({ model, messages: msgs, max_tokens: tokens, temperature: 0.3 })
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
    width: 480, height: 520,
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
    // If they closed without activating, quit the app
    if (!isLicensed()) {
      app.quit();
    } else {
      // Hide dock again
      if (process.platform === 'darwin') app.dock?.hide();
    }
  });
}

ipcMain.on('start-trial', () => {
  // Trial disabled — license key required for access
  // Do nothing — user must enter a license key
});

// Admin master keys — always valid
const ADMIN_KEYS = ['ZAP-ADMIN-MASTER-2026', 'ZAP-OWNER-ARHAAN-KEY'];

function proceedAfterLicense() {
  // Close activate window (the closed handler will check isLicensed and hide dock)
  if (activateWin) { activateWin.close(); activateWin = null; }
  // Show welcome tour if not done, otherwise just hide dock
  if (!store.get('onboardingDone')) {
    showWelcome();
  } else {
    if (process.platform === 'darwin') app.dock?.hide();
  }
}

ipcMain.handle('validate-license', async (_ev, key) => {
  if (!key || key.trim().length < 5) return { valid: false, error: 'Please enter a valid license key.' };

  // Check admin keys first
  if (ADMIN_KEYS.includes(key.trim())) {
    store.set('licenseKey', key.trim());
    store.set('licenseValid', true);
    store.set('licenseEmail', 'admin@tryzap.net');
    proceedAfterLicense();
    return { valid: true, email: 'admin@tryzap.net', admin: true };
  }

  try {
    // LemonSqueezy license validation API
    const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: key.trim(), instance_name: require('os').hostname() })
    });

    const data = await res.json();

    if (data.valid || data.license_key?.status === 'active') {
      store.set('licenseKey', key.trim());
      store.set('licenseValid', true);
      store.set('licenseEmail', data.meta?.customer_email || '');
      proceedAfterLicense();
      return { valid: true, email: data.meta?.customer_email };
    } else {
      return { valid: false, error: data.error || 'Invalid or expired license key.' };
    }
  } catch (err) {
    // If offline, accept key optimistically if it looks valid
    if (key.trim().length >= 16) {
      store.set('licenseKey', key.trim());
      store.set('licenseValid', true);
      proceedAfterLicense();
      return { valid: true, offline: true };
    }
    return { valid: false, error: 'Could not verify license. Check your internet connection.' };
  }
});

ipcMain.handle('get-license-status', () => {
  return {
    licensed: isLicensed(),
    hasKey: !!store.get('licenseKey'),
    licenseValid: store.get('licenseValid'),
    trialActive: store.get('trialStarted') > 0 && trialDaysLeft() > 0,
    trialDaysLeft: trialDaysLeft(),
    email: store.get('licenseEmail') || ''
  };
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
    width: 440, height: 580,
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

  // After auth, require license key
  if (!isLicensed()) {
    showActivate();
  } else if (!store.get('onboardingDone')) {
    showWelcome();
  }
});

/* ─────────────────── Welcome / First Launch ─────────────────── */

let welcomeWin = null;

function showWelcome() {
  if (welcomeWin) { welcomeWin.focus(); return; }

  // Show dock temporarily so welcome window can be focused on macOS
  if (process.platform === 'darwin') app.dock?.show();

  welcomeWin = new BrowserWindow({
    width: 680, height: 520,
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

ipcMain.handle('check-for-updates', async () => {
  try {
    const currentVersion = require('../package.json').version;
    const res = await fetch('https://api.github.com/repos/Salt30/Zap/releases/latest');
    if (!res.ok) return { upToDate: true, current: currentVersion };
    const data = await res.json();
    const latest = (data.tag_name || '').replace(/^v/, '');
    if (!latest || latest === currentVersion) return { upToDate: true, current: currentVersion };

    // Find DMG download URL
    const dmgAsset = (data.assets || []).find(a => a.name.endsWith('.dmg'));
    return {
      upToDate: false,
      current: currentVersion,
      latest: latest,
      downloadUrl: dmgAsset ? dmgAsset.browser_download_url : data.html_url,
      releaseUrl: data.html_url
    };
  } catch (_) {
    return { upToDate: true, error: 'Could not check for updates' };
  }
});

/* ─────────────────── App Lifecycle ─────────────────── */

app.whenReady().then(() => {
  // Initialize store AFTER app is ready so getPath('userData') works
  initStore();

  makeOverlay();
  makeTray();
  bindKeys();

  // Flow: Auth → License → Welcome Tour → App
  if (!store.get('authDone')) {
    showAuth();
  } else if (!isLicensed()) {
    showActivate();
  } else if (!store.get('onboardingDone')) {
    showWelcome();
  } else {
    if (process.platform === 'darwin') app.dock?.hide();
  }

  app.on('activate', () => { if (!overlayWin) makeOverlay(); });
});

app.on('window-all-closed', () => {});
app.on('will-quit', () => globalShortcut.unregisterAll());

process.on('unhandledRejection',  r => console.warn('Unhandled rejection:', r?.message || r));
process.on('uncaughtException', err => console.error('Uncaught exception:', err.message));

// Dock hide moved into whenReady — see showAuth/showWelcome for temporary show/hide
