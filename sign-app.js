const sign = require('@electron/osx-sign');

const fn = sign.signAsync || sign.sign || sign;

fn({
  app: 'dist/mac-arm64/Zap.app',
  identity: 'Developer ID Application',
  entitlements: 'build/entitlements.mac.plist',
  entitlementsInherit: 'build/entitlements.mac.plist',
  hardenedRuntime: true,
  strictVerify: false,
  preAutoEntitlements: false
}).then(() => {
  console.log('Signing complete!');
}).catch(err => {
  console.error('Signing failed:', err);
});
