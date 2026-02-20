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
  systemPreferences,
  clipboard
} = require('electron');
const path = require('path');
const { exec } = require('child_process');
const Store = require('electron-store');

/* ─────────────────── Persistent Settings ─────────────────── */

const STORE_DEFAULTS = {
  apiKey:        'YOUR_PERPLEXITY_API_KEY',
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
  language:      'Spanish',
  theme:         'dark',
  lastMode:      'answer',
  phantomMode:   false,
  autoEngine:    true,
  maxTokens:     1024,
  dripSpeed:     40,
  typoRate:      0.06,
  invisibleOverlay: true,
  onboardingDone: false
};

let store;
try {
  store = new Store({ name: 'zap-config', defaults: STORE_DEFAULTS });
  // Test that the store is readable
  store.get('apiKey');
} catch (_) {
  // Config file is corrupted — delete it and start fresh
  const fs = require('fs');
  const configPath = path.join(app.getPath('userData'), 'zap-config.json');
  try { fs.unlinkSync(configPath); } catch (_) {}
  store = new Store({ name: 'zap-config', defaults: STORE_DEFAULTS });
}

/* ─────────────────── Window References ─────────────────── */

let overlayWin  = null;
let settingsWin = null;
let tray        = null;
let overlayUp   = false;

/* ─────────────────── Overlay Window ─────────────────── */

function makeOverlay() {
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

  try { if (store.get('phantomMode')) overlayWin.setContentProtection(true); } catch (_) {}

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
  settingsWin.on('closed', () => { settingsWin = null; });
}

/* ─────────────────── Screen Capture ─────────────────── */

async function grabScreen() {
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
    { label: 'Phantom Mode', type: 'checkbox', checked: store.get('phantomMode'),
      click: (m) => {
        store.set('phantomMode', m.checked);
        try { if (overlayWin) overlayWin.setContentProtection(m.checked); } catch (_) {}
      }
    },
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
    [store.get('hotkeyDripType'),  () => showWithMode('driptype')]
  ];
  for (const [key, fn] of map) {
    if (!key) continue;
    try { globalShortcut.register(key, fn); } catch (_) {}
  }
}

/* ─────────────────── Drip Type Engine ─────────────────── */

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

ipcMain.handle('drip-type', async (_ev, text) => {
  if (!text) return;
  if (overlayWin) { overlayWin.hide(); overlayUp = false; }
  await new Promise(r => setTimeout(r, 400));

  const speed = store.get('dripSpeed') || 40;
  const rate  = store.get('typoRate')  || 0.06;

  if (process.platform === 'darwin') {
    const cmds = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const ms = humanMs(speed) / 1000;

      if (/[a-zA-Z]/.test(ch) && Math.random() < rate) {
        const wrong = typoChar(ch);
        cmds.push(`keystroke "${escAS(wrong)}"`);
        cmds.push(`delay ${(humanMs(speed * 0.7) / 1000).toFixed(4)}`);
        cmds.push(`delay ${((80 + Math.random() * 250) / 1000).toFixed(4)}`);
        cmds.push('key code 51');
        cmds.push(`delay ${(humanMs(speed * 0.4) / 1000).toFixed(4)}`);
        cmds.push(`keystroke "${escAS(ch)}"`);
        cmds.push(`delay ${ms.toFixed(4)}`);
      } else if (ch === '\n') {
        cmds.push('key code 36');
        cmds.push(`delay ${(ms + 0.05).toFixed(4)}`);
      } else if (ch === '\t') {
        cmds.push('key code 48');
        cmds.push(`delay ${ms.toFixed(4)}`);
      } else {
        cmds.push(`keystroke "${escAS(ch)}"`);
        cmds.push(`delay ${ms.toFixed(4)}`);
      }
    }

    const CHUNK = 200;
    for (let c = 0; c < cmds.length; c += CHUNK) {
      const script = `tell application "System Events"\n${cmds.slice(c, c + CHUNK).join('\n')}\nend tell`;
      await new Promise(resolve => {
        exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 120000 }, () => resolve());
      });
    }
  } else {
    clipboard.writeText(text);
    return { fallback: true, message: 'Text copied to clipboard. Paste with Ctrl+V.' };
  }
});

/* ─────────────────── IPC Handlers ─────────────────── */

ipcMain.on('hide-overlay', () => {
  if (overlayWin) { overlayWin.hide(); overlayUp = false; }
});

ipcMain.on('open-settings', () => makeSettings());

ipcMain.handle('get-settings', () => store.store);

ipcMain.on('save-settings', (_ev, s) => {
  for (const [k, v] of Object.entries(s)) store.set(k, v);
  bindKeys();
  if (s.startAtLogin !== undefined) {
    try { app.setLoginItemSettings({ openAtLogin: s.startAtLogin }); } catch (_) {}
  }
  try { if (overlayWin) overlayWin.setContentProtection(store.get('phantomMode')); } catch (_) {}
  if (overlayWin)  overlayWin.webContents.send('load-settings', store.store);
  if (settingsWin) settingsWin.webContents.send('settings-saved');
});

/* ─────────────────── AI Request ─────────────────── */

ipcMain.handle('ai-request', async (_ev, { mode, text, imageDataUrl, region, language }) => {
  const apiKey   = store.get('apiKey');
  const endpoint = store.get('apiEndpoint');
  const model    = store.get('model');
  const tokens   = store.get('maxTokens');

  if (!apiKey || apiKey === 'YOUR_PERPLEXITY_API_KEY') return { error: 'API key not configured. Please reinstall Zap or contact support.' };

  const prompts = {
    answer:    "You are a helpful AI assistant. Answer the user's question based on the content provided. Be concise and direct.",
    translate: `You are a professional translator. Translate ALL the provided text into ${language || store.get('language')}. Only provide the translation, no explanations.`,
    summarize: 'You are an expert summarizer. Summarize the provided content in a clear, concise manner. Use bullet points for key takeaways.',
    explain:   'You are an expert teacher. Explain the concept or content provided in a clear and detailed way. Break down complex ideas simply.',
    rewrite:   'You are a professional editor. Rewrite the provided text to be clearer, more professional, and polished. Return only the rewritten text.'
  };

  const msgs = [{ role: 'system', content: prompts[mode] || prompts.answer }];

  if (endpoint.includes('perplexity.ai')) {
    msgs.push({ role: 'user', content: text || '[No text extracted]' });
  } else {
    const parts = [];
    if (text) parts.push({ type: 'text', text: 'Here is the selected text: ' + text });
    else      parts.push({ type: 'text', text: 'Analyze the selected screen region shown in the image.' });
    if (imageDataUrl) parts.push({ type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } });
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

/* ─────────────────── Welcome / First Launch ─────────────────── */

let welcomeWin = null;

function showWelcome() {
  if (welcomeWin) { welcomeWin.focus(); return; }

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
  welcomeWin.once('ready-to-show', () => { welcomeWin.show(); welcomeWin.focus(); });
  welcomeWin.on('closed', () => { welcomeWin = null; });
}

ipcMain.on('welcome-done', () => {
  store.set('onboardingDone', true);
  if (welcomeWin) { welcomeWin.close(); welcomeWin = null; }
});

/* ─────────────────── App Lifecycle ─────────────────── */

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    const perm = systemPreferences.getMediaAccessStatus('screen');
    if (perm !== 'granted') console.log('Grant Screen Recording in System Settings > Privacy & Security > Screen Recording');
  }

  makeOverlay();
  makeTray();
  bindKeys();

  // Show welcome tour on first launch
  if (!store.get('onboardingDone')) {
    showWelcome();
  }

  app.on('activate', () => { if (!overlayWin) makeOverlay(); });
});

app.on('window-all-closed', () => {});
app.on('will-quit', () => globalShortcut.unregisterAll());

process.on('unhandledRejection',  r => console.warn('Unhandled rejection:', r?.message || r));
process.on('uncaughtException', err => console.error('Uncaught exception:', err.message));

if (process.platform === 'darwin') app.dock?.hide();
