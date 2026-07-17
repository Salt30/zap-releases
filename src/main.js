const { app, BrowserWindow, globalShortcut, ipcMain, clipboard, dialog } = require('electron');
const Store = require('electron-store');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = new Store({
  defaults: {
    dripWPM: 45,
    dripDelay: 10,
    typoRate: 0.03,
    dripPauseChance: 0.03,
    dripBurstChance: 0.08,
    hotkeyStart: 'Alt+5',
    hotkeyStop: 'Alt+0'
  }
});

let mainWindow;
let dripTypeCancelled = false;
let dripTypeRunning = false;

const NEARBY = {
  a: 'sqwz', b: 'vngh', c: 'xvdf', d: 'sfcxer', e: 'wrsd', f: 'dgcvrt',
  g: 'fhvbty', h: 'gjbnyu', i: 'ujko', j: 'hknmui', k: 'jlmio', l: 'kop',
  m: 'njk', n: 'bmhj', o: 'iklp', p: 'ol', q: 'wa', r: 'edft', s: 'awdxze',
  t: 'rfgy', u: 'yhji', v: 'cbfg', w: 'qase', x: 'zsdc', y: 'tghu', z: 'xsa',
  '1': '2q', '2': '13qw', '3': '24we', '4': '35er', '5': '46rt',
  '6': '57ty', '7': '68yu', '8': '79ui', '9': '80io', '0': '9p'
};

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
  if (character === '"') return '\\"';
  if (character === '\\') return '\\\\';
  return character;
}

function cleanMarkdown(text) {
  if (!text) return text;
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*{1,3}([^*]+?)\*{1,3}/g, '$1')
    .replace(/_{1,3}([^_]+?)_{1,3}/g, '$1')
    .replace(/~~([^~]+?)~~/g, '$1')
    .replace(/`([^`]+?)`/g, '$1')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, '').replace(/```/g, ''))
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/\[([^\]]+?)\]\([^)]+?\)/g, '$1')
    .replace(/!\[([^\]]*?)\]\([^)]+?\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function runAppleScript(scriptPath) {
  return new Promise((resolve, reject) => {
    execFile('osascript', [scriptPath], { timeout: 120000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function dripType(input) {
  let text = cleanMarkdown(input);
  if (!text) return { error: 'Enter some text first.' };
  if (dripTypeRunning) return { error: 'Drip Type is already running.' };

  if (process.platform !== 'darwin') {
    clipboard.writeText(text);
    return { fallback: true, message: 'Automatic typing currently requires macOS. Text was copied to the clipboard.' };
  }

  dripTypeCancelled = false;
  dripTypeRunning = true;

  try {
    const delaySeconds = Number(store.get('dripDelay')) || 10;
    for (let waited = 0; waited < delaySeconds * 1000; waited += 250) {
      if (dripTypeCancelled) return { cancelled: true };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const wpm = Number(store.get('dripWPM')) || 45;
    const speed = Math.round(60000 / (wpm * 5));
    const typoRate = Number(store.get('typoRate')) || 0;
    const pauseChance = Number(store.get('dripPauseChance')) || 0;
    const burstChance = Number(store.get('dripBurstChance')) || 0;
    const commands = [];

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];

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
    }

    const chunkSize = 150;
    for (let offset = 0; offset < commands.length; offset += chunkSize) {
      if (dripTypeCancelled) return { cancelled: true };
      const script = `tell application "System Events"\n${commands.slice(offset, offset + chunkSize).join('\n')}\nend tell`;
      const scriptPath = path.join(os.tmpdir(), `drip_type_${process.pid}_${offset}.scpt`);
      fs.writeFileSync(scriptPath, script, { mode: 0o600 });
      try {
        await runAppleScript(scriptPath);
      } finally {
        try { fs.unlinkSync(scriptPath); } catch (_) {}
      }
    }

    return { success: true };
  } catch (error) {
    return { error: error.message };
  } finally {
    dripTypeRunning = false;
  }
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const start = store.get('hotkeyStart');
  const stop = store.get('hotkeyStop');
  if (start) globalShortcut.register(start, () => mainWindow?.show());
  if (stop) globalShortcut.register(stop, () => { dripTypeCancelled = true; });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 700,
    minWidth: 620,
    minHeight: 600,
    title: 'Drip Type',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('drip-type:start', (_event, text) => dripType(text));
ipcMain.on('drip-type:cancel', () => { dripTypeCancelled = true; });
ipcMain.handle('settings:get', () => store.store);
ipcMain.handle('settings:save', (_event, settings) => {
  const allowed = ['dripWPM', 'dripDelay', 'typoRate', 'dripPauseChance', 'dripBurstChance', 'hotkeyStart', 'hotkeyStop'];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) store.set(key, settings[key]);
  }
  registerShortcuts();
  return store.store;
});

app.whenReady().then(() => {
  createWindow();
  registerShortcuts();
  if (process.platform === 'darwin' && !app.isAccessibilitySupportEnabled()) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Accessibility permission required',
      message: 'Drip Type needs Accessibility access to type into other applications.',
      detail: 'Open System Settings → Privacy & Security → Accessibility and enable Drip Type (or Electron while developing).'
    });
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
