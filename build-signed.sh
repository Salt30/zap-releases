#!/bin/bash
set -e
echo "=== Zap Build (Signed + Notarized) ==="
if [ -z "$APPLE_ID" ] || [ -z "$APPLE_APP_SPECIFIC_PASSWORD" ] || [ -z "$APPLE_TEAM_ID" ]; then
  echo "ERROR: Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID first"
  exit 1
fi
IDENTITY=$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | grep -o '"[^"]*"' | tr -d '"')
if [ -z "$IDENTITY" ]; then echo "ERROR: No Developer ID Application certificate"; exit 1; fi
echo "Signing identity: $IDENTITY"
echo "Step 1: Cleaning..."
rm -rf dist
echo "Step 2: Clearing electron cache..."
rm -rf ~/Library/Caches/electron ~/Library/Caches/electron-builder
echo "Step 3: Installing dependencies..."
npm install
echo "Step 4: Stripping xattrs from dependencies..."
find node_modules -exec xattr -c {} + 2>/dev/null || true
echo "Step 5: Building unsigned app..."
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg zip
APP="dist/mac-arm64/Zap.app"
echo "Step 6: Stripping all extended attributes..."
dot_clean "$APP" 2>/dev/null || true
find "$APP" -print0 | xargs -0 xattr -c 2>/dev/null || true
find "$APP" -print0 | xargs -0 xattr -d com.apple.FinderInfo 2>/dev/null || true
find "$APP" -print0 | xargs -0 xattr -d com.apple.quarantine 2>/dev/null || true
REMAINING=$(find "$APP" -exec xattr -l {} + 2>/dev/null | head -5)
if [ -n "$REMAINING" ]; then
  echo "Extra cleanup with ditto..."
  ditto --norsrc "$APP" "${APP}-clean"
  rm -rf "$APP"
  mv "${APP}-clean" "$APP"
  find "$APP" -print0 | xargs -0 xattr -c 2>/dev/null || true
fi
echo "Step 7: Code signing..."
find "$APP/Contents/Frameworks" -name "*.framework" -o -name "*.app" | while read -r component; do
  echo "  Signing: $(basename "$component")"
  codesign --force --sign "$IDENTITY" --options runtime --entitlements build/entitlements.mac.plist --timestamp "$component" 2>&1 || {
    xattr -cr "$component"; codesign --force --sign "$IDENTITY" --options runtime --entitlements build/entitlements.mac.plist --timestamp "$component"
  }
done
echo "  Signing: Zap (main binary)"
codesign --force --sign "$IDENTITY" --options runtime --entitlements build/entitlements.mac.plist --timestamp "$APP/Contents/MacOS/Zap" 2>&1 || {
  xattr -c "$APP/Contents/MacOS/Zap"; codesign --force --sign "$IDENTITY" --options runtime --entitlements build/entitlements.mac.plist --timestamp "$APP/Contents/MacOS/Zap"
}
echo "  Signing: Zap.app (bundle)"
codesign --force --sign "$IDENTITY" --options runtime --entitlements build/entitlements.mac.plist --timestamp "$APP"
echo "Step 8: Verifying signature..."
codesign --verify --verbose=2 "$APP"
echo "Signature valid!"
echo "Step 9: Creating DMG..."
rm -f dist/Zap-1.0.0-arm64.dmg
hdiutil create -volname "Zap" -srcfolder "$APP" -ov -format UDZO dist/Zap-1.0.0-arm64.dmg
echo "Step 10: Notarizing with Apple..."
xcrun notarytool submit dist/Zap-1.0.0-arm64.dmg --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
echo "Step 11: Stapling..."
xcrun stapler staple dist/Zap-1.0.0-arm64.dmg
echo "=== BUILD COMPLETE ==="
echo "Your signed + notarized DMG: dist/Zap-1.0.0-arm64.dmg"
