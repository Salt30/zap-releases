const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const {
  FuseState,
  FuseV1Options,
  getCurrentFuseWire
} = require('@electron/fuses');

async function main() {
  const appPath = path.resolve(process.argv[2] || 'dist/mac-universal/Drip Type.app');
  const isMac = appPath.endsWith('.app');
  const executablePath = isMac ? appPath : appPath;
  const resourcesPath = isMac
    ? path.join(appPath, 'Contents', 'Resources')
    : path.join(path.dirname(appPath), 'resources');
  const asarPath = path.join(resourcesPath, 'app.asar');
  const plistPath = isMac ? path.join(appPath, 'Contents', 'Info.plist') : null;

  if (!fs.existsSync(asarPath)) throw new Error(`Missing app.asar at ${asarPath}`);

  const fuseWire = await getCurrentFuseWire(executablePath);
  const expected = new Map([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
    [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE]
  ]);
  for (const [option, state] of expected) {
    if (fuseWire[option] !== state) {
      throw new Error(`Unexpected fuse state for ${FuseV1Options[option]}`);
    }
  }

  const files = asar.listPackage(asarPath);
  const required = [
    '/build-app/main.js', '/build-app/preload.js', '/build-app/index.html',
    '/build-app/index.js', '/build-app/quick.html', '/build-app/quick.js',
    '/build-app/onboarding.html', '/build-app/onboarding.js',
    '/build-app/windows-host.ps1'
  ];
  for (const file of required) {
    if (!files.includes(file)) throw new Error(`Packaged file is missing: ${file}`);
  }
  if (files.some((file) => file === '/src' || file.startsWith('/src/'))) {
    throw new Error('Raw source tree was included in app.asar.');
  }
  if (files.some((file) => file.endsWith('.map'))) {
    throw new Error('Source maps were included in app.asar.');
  }

  const unpackedWindowsHost = path.join(resourcesPath, 'app.asar.unpacked', 'build-app', 'windows-host.ps1');
  if (!fs.existsSync(unpackedWindowsHost)) throw new Error('The native Windows typing host was not unpacked.');

  if (isMac) {
    const plist = fs.readFileSync(plistPath, 'utf8');
    if (!plist.includes('<key>ElectronAsarIntegrity</key>') || !plist.includes('<string>SHA256</string>')) {
      throw new Error('ASAR integrity metadata is missing from Info.plist.');
    }
    if (!plist.includes('<key>CFBundleURLSchemes</key>') || !plist.includes('<string>driptype</string>')) {
      throw new Error('The activation URL scheme is missing from Info.plist.');
    }
  }

  console.log('Package security verification passed.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
