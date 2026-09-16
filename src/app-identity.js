const fs = require('node:fs');
const path = require('node:path');

// Keep the same vault, device binding, and preferences when upgrading. Changing
// the display name must not create a second account/device on an existing install.
function configureAppIdentity(app, exists = fs.existsSync, platform = process.platform) {
  const appData = app.getPath('appData');
  const current = path.join(appData, 'Zap');
  const candidates = [current, path.join(appData, 'Drip Type'), path.join(appData, 'drip-type')];
  const userData = candidates.find((directory) => exists(path.join(directory, 'config.json'))) || current;
  // Electron 43 binds macOS Safe Storage to the internal name before `ready`.
  // Preserve that key for existing vaults, then restore the public name before
  // windows or menus are created. The bundle and executable are always Zap.
  // https://github.com/electron/electron/blob/v43.1.1/shell/browser/electron_browser_main_parts.cc
  if (platform === 'darwin' && userData !== current) {
    app.setName('Drip Type');
    app.once('ready', () => app.setName('Zap'));
  } else {
    app.setName('Zap');
  }
  app.setPath('userData', userData);
  return userData;
}

module.exports = { configureAppIdentity };
