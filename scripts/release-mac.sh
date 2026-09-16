#!/usr/bin/env bash
set -euo pipefail

for name in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: ${name}" >&2
    exit 1
  fi
done

if ! security find-identity -v -p codesigning | grep -Fq "Developer ID Application: VegaNext LLC (U46KNQN78Q)"; then
  echo "The VegaNext Developer ID Application identity was not found in the macOS keychain." >&2
  exit 1
fi

echo "Checking source…"
npm run check

echo "Installing locked dependencies…"
npm ci

echo "Building, signing, and notarizing the universal macOS release…"
npm run dist:mac

echo "Validating signatures, Gatekeeper acceptance, and stapled tickets…"
while IFS= read -r -d '' app_bundle; do
  codesign --verify --deep --strict --verbose=2 "$app_bundle"
  spctl --assess --verbose --type exec "$app_bundle"
  xcrun stapler validate "$app_bundle"
done < <(find dist -type d -name 'Zap.app' -print0)

shasum -a 256 dist/*.dmg dist/*.zip > dist/SHA256SUMS.txt

echo "Release artifacts are ready in dist/."
