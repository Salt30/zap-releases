// Two isolated launches exercise Electron's actual macOS Keychain-name lifecycle.
// Only synthetic text and a unique test Keychain item are used, never user data.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { configureAppIdentity } = require('../src/app-identity');
const [mode, root, testName] = process.argv.slice(2);
if (process.platform !== 'darwin' || !['write', 'read'].includes(mode) || !root || !/^ZapUpgradeFixture-[0-9]+$/.test(testName || '')) {
  app.exit(1);
} else {
  const legacy = path.join(root, 'Drip Type');
  fs.mkdirSync(legacy, { recursive: true });
  const config = path.join(legacy, 'config.json');
  if (mode === 'write') {
    app.setPath('userData', legacy);
    app.setName(testName);
  } else {
    configureAppIdentity({
      getPath: (key) => key === 'appData' ? root : app.getPath(key),
      setName: (name) => app.setName(name === 'Drip Type' ? testName : `${testName}-Zap`),
      setPath: (key, value) => app.setPath(key, value),
      once: (event, callback) => app.once(event, callback)
    });
  }
  app.whenReady().then(() => {
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    if (mode === 'write') {
      fs.writeFileSync(config, JSON.stringify({ fixture: safeStorage.encryptString('Synthetic upgrade check').toString('base64') }), { mode: 0o600 });
    } else {
      assert.equal(app.getName(), `${testName}-Zap`);
      const encrypted = JSON.parse(fs.readFileSync(config, 'utf8')).fixture;
      assert.equal(safeStorage.decryptString(Buffer.from(encrypted, 'base64')), 'Synthetic upgrade check');
      console.log('macOS rebrand: encrypted fixture readable after the public name changed.');
    }
    app.quit();
  }).catch((error) => { console.error(error.message); app.exit(1); });
}
