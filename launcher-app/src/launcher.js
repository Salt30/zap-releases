/**
 * Zap Pro Launcher — Discord-style auto-updating launcher
 *
 * How it works:
 * 1. Shows a splash screen
 * 2. Checks for latest version via Supabase proxy
 * 3. Downloads encrypted app.asar.enc if needed
 * 4. Decrypts and spawns the real app
 * 5. Cleans up decrypted files when the app exits
 */

const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');

// ── Config ──
const APP_NAME = 'Zap Pro';
const DOWNLOAD_API = 'https://vydtygcvszscgmjgyszl.supabase.co/functions/v1/download';

// ── Encryption key derivation (must match encrypt_asar.py) ──
const FRAG_A = Buffer.from([0x7a, 0x61, 0x70, 0x5f, 0x73, 0x65, 0x63, 0x72]);
const FRAG_B = Buffer.from([0x65, 0x74, 0x5f, 0x6b, 0x65, 0x79, 0x5f, 0x70]);
const FRAG_C = Buffer.from([0x72, 0x6f, 0x5f, 0x32, 0x30, 0x32, 0x36, 0x5f]);
const FRAG_D = Buffer.from([0x65, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74, 0x21]);
const KEY_SALT = Buffer.from('zap_launcher_v1_aes256gcm');

function deriveKey() {
  const seed = Buffer.concat([FRAG_A, FRAG_B, FRAG_C, FRAG_D, KEY_SALT]);
  return crypto.createHash('sha256').update(seed).digest();
}

// ── Paths ──
function getDataDir() {
  const base = app.getPath('userData').replace(/zap-launcher/i, 'ZapPro');
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  return base;
}

function getEncryptedPath() { return path.join(getDataDir(), 'app.asar.enc'); }
function getVersionPath()   { return path.join(getDataDir(), 'current_version.txt'); }
function getDecryptedDir()  {
  const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return path.join(getDataDir(), `_run_${ts}`);
}

// ── HTTPS helpers (using Supabase proxy — no GitHub auth needed) ──
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ZapLauncher/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : require('http').get;
    get(url, { headers: { 'User-Agent': 'ZapLauncher/1.0' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, dest, onProgress).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const file = fs.createWriteStream(dest);

      file.on('error', e => reject(e));
      file.on('finish', () => resolve());

      res.on('data', chunk => {
        received += chunk.length;
        if (onProgress && total > 0) onProgress(received / total);
      });
      res.on('error', e => { file.destroy(); reject(e); });

      res.pipe(file);
    }).on('error', reject);
  });
}

// ── Decryption ──
function decryptPayload(encryptedBuf) {
  const key = deriveKey();
  const nonce = encryptedBuf.subarray(0, 12);
  const ciphertext = encryptedBuf.subarray(12, encryptedBuf.length - 16);
  const authTag = encryptedBuf.subarray(encryptedBuf.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted;
}

// ── Splash window ──
let splashWin = null;

function createSplash() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  splashWin = new BrowserWindow({
    width: 320,
    height: 200,
    x: Math.round((width - 320) / 2),
    y: Math.round((height - 200) / 2),
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  splashWin.loadFile(path.join(__dirname, 'splash.html'));
  splashWin.setVisibleOnAllWorkspaces(true);
  return splashWin;
}

function updateSplash(msg, pct) {
  if (!splashWin || splashWin.isDestroyed()) return;
  splashWin.webContents.executeJavaScript(
    `document.getElementById('status').textContent = ${JSON.stringify(msg)};` +
    (pct !== undefined ? `document.getElementById('bar').style.width = '${Math.round(pct * 100)}%';` : '')
  ).catch(() => {});
}

function closeSplash() {
  if (splashWin && !splashWin.isDestroyed()) splashWin.close();
  splashWin = null;
}

// ── Cleanup ──
function secureCleanup(dir) {
  try {
    const asarPath = path.join(dir, 'app.asar');
    if (fs.existsSync(asarPath)) {
      const size = fs.statSync(asarPath).size;
      const fd = fs.openSync(asarPath, 'w');
      const zeros = Buffer.alloc(Math.min(size, 1024 * 1024));
      let remaining = size;
      while (remaining > 0) {
        const chunk = Math.min(remaining, zeros.length);
        fs.writeSync(fd, zeros, 0, chunk);
        remaining -= chunk;
      }
      fs.closeSync(fd);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function cleanupOldRuns() {
  try {
    const dataDir = getDataDir();
    const entries = fs.readdirSync(dataDir);
    for (const entry of entries) {
      if (entry.startsWith('_run_')) {
        secureCleanup(path.join(dataDir, entry));
      }
    }
  } catch (_) {}
}

// ── Main launch flow ──
async function launch() {
  createSplash();
  updateSplash('Starting...', 0);

  cleanupOldRuns();

  try {
    // 1. Check for latest release via Supabase proxy
    updateSplash('Checking for updates...', 0.1);
    let release;
    try {
      release = await fetchJSON(`${DOWNLOAD_API}?platform=latest`);
    } catch (e) {
      console.error('Failed to check updates:', e.message);
      if (fs.existsSync(getEncryptedPath())) {
        updateSplash('Using cached version...', 0.5);
        return await launchFromCache();
      }
      throw new Error('No internet connection and no cached version.');
    }

    // 2. Check if we need to download
    const currentVersion = (() => {
      try { return fs.readFileSync(getVersionPath(), 'utf8').trim(); }
      catch (_) { return ''; }
    })();

    const needsUpdate = currentVersion !== release.tag_name || !fs.existsSync(getEncryptedPath());

    if (needsUpdate) {
      updateSplash(`Downloading ${release.tag_name}...`, 0.15);

      // Download encrypted payload via Supabase proxy
      await downloadFile(`${DOWNLOAD_API}?platform=payload`, getEncryptedPath(), (pct) => {
        updateSplash(`Downloading... ${Math.round(pct * 100)}%`, 0.15 + pct * 0.6);
      });

      fs.writeFileSync(getVersionPath(), release.tag_name);
      updateSplash('Download complete!', 0.8);
    } else {
      updateSplash('Up to date!', 0.8);
    }

    // 3. Decrypt and launch
    await launchFromCache();

  } catch (err) {
    console.error('Launch error:', err);
    closeSplash();

    const { dialog } = require('electron');
    dialog.showErrorBox('Zap Pro', `Failed to start: ${err.message}`);
    app.quit();
  }
}

async function launchFromCache() {
  updateSplash('Decrypting...', 0.85);

  const encrypted = fs.readFileSync(getEncryptedPath());
  let decrypted;
  try {
    decrypted = decryptPayload(encrypted);
  } catch (e) {
    fs.unlinkSync(getEncryptedPath());
    try { fs.unlinkSync(getVersionPath()); } catch (_) {}
    throw new Error('Decryption failed. Please restart to re-download.');
  }

  const tempDir = getDecryptedDir();
  fs.mkdirSync(tempDir, { recursive: true });
  const asarPath = path.join(tempDir, 'app.asar');
  fs.writeFileSync(asarPath, decrypted);

  try { fs.chmodSync(asarPath, 0o400); } catch (_) {}

  decrypted.fill(0);

  updateSplash('Launching...', 0.95);

  const electronPath = process.execPath;
  const child = spawn(electronPath, [asarPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ZAP_TEMP_DIR: tempDir }
  });

  child.unref();

  setTimeout(() => {
    closeSplash();

    child.on('exit', () => {
      secureCleanup(tempDir);
    });

    process.on('exit', () => {
      secureCleanup(tempDir);
    });

    setTimeout(() => {
      app.quit();
    }, 2000);
  }, 1000);
}

// ── App lifecycle ──
app.whenReady().then(launch);

app.on('window-all-closed', () => {
  // Don't quit when splash closes — we quit manually after spawn
});
