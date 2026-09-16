const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (process.platform !== 'darwin') {
  console.log('macOS Keychain compatibility check skipped on this platform.');
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zap-upgrade-fixture-'));
  const testName = `ZapUpgradeFixture-${Date.now()}`;
  try {
    for (const mode of ['write', 'read']) {
      const result = spawnSync(require('electron'), [path.join(__dirname, 'test-mac-brand-storage.js'), mode, root, testName], { stdio: 'inherit', timeout: 20000 });
      if (result.status !== 0) throw new Error(`${mode} failed: ${result.error?.message || result.status}`);
    }
  } finally {
    for (const name of [testName, `${testName}-Zap`]) {
      spawnSync('/usr/bin/security', ['delete-generic-password', '-a', name, '-s', `${name} Safe Storage`], { stdio: 'ignore' });
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
