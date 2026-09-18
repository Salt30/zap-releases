# Zap

Zap is a native-feeling macOS utility that turns prepared text into natural keystrokes in any application.

## Zap AI workspace

The desktop app includes Zap AI alongside Drip Type. AI is provided by Zap
through NVIDIA; users connect their existing Zap account in **Billing** and do
not enter API keys. An active Zap subscription is required. Usage is
limited to 100 requests per subscription per UTC day, including failed provider
attempts. NVIDIA service availability and limits also apply.

- Answer, quick answer, translate, rewrite, summarize, explain, solve, and code
- Research briefs from supplied material and model knowledge (no live web search)
- Screen capture with display selection, preview, and visual or keyboard cropping
- Up to four screenshot attachments, combined locally into one image for NVIDIA
- Interactive flashcards, a floating pinned answer, and bounded session history
- Form response drafting for review and transfer into Composer
- Send results to the existing composer with its current typing controls,
  subscription checks, permission checks, and stop shortcut
- Option/Alt+3 opens Zap; change or disable it in AI settings. If standalone
  Zap Pro owns that shortcut, quit it or choose another combination.

Clicking **Ask Zap**, **Research**, or **Make flashcards** sends the entered text,
custom instructions, and attached screenshots through Zap's server to NVIDIA.
Capture alone never uploads anything. Screenshots and the last 20 results stay
in window memory; closing the window clears them. Clear history removes results,
and screenshots can be removed individually. There is no automatic clipboard or
screen monitoring. Drip Type composition and typing stay local.

The combined app uses the existing account, billing, updates, appearance, and
current typing engine. The installed Zap Pro app is not modified. Legacy embedded
credentials, separate authentication and billing, automatic form clicking,
process concealment, kernel components, persistence, and self-deletion routines
are not imported. This integrates its productive workflows into the current app.

See [docs/ZAP_INTEGRATION.md](docs/ZAP_INTEGRATION.md) for server configuration,
validation, and release requirements.

## How it works

1. Press `Option+5` from the app you want to type into.
2. Paste or write anything in the Drip Type overlay.
3. Press `Command+Enter`.
4. Zap returns to the previous app and begins after the configured delay.

`Option+0` immediately stops a running session. Both shortcuts are customizable.

## Product features

- First-run onboarding, interactive typing demo, and enforced native permission checklist
- Translucent global-hotkey composer
- Explicit local clipboard paste and in-memory-only drafts
- Automatic return to the previously active app
- Adjustable WPM, start delay, typo rate, thinking pauses, and speed bursts
- Direct controls for speed, delay, corrected typos, thinking pauses, and bursts
- System, light, and dark appearance modes across every window
- Nearby-key typos followed by realistic corrections
- Natural timing variation and punctuation-aware pauses
- Markdown cleanup before typing
- Live countdown, progress, cancellation, and error states
- Menu-bar access and keyboard-first operation
- Optional launch-at-login mode that starts quietly without opening settings
- Local writing and settings with no writing-content analytics or shared draft database
- 14-day Core trial with a native subscription status and billing screen
- Stripe-hosted checkout, device-bound signed entitlements, and macOS Keychain credential storage
- Live Accessibility and Automation status with direct macOS permission recovery
- One signed and notarized universal Mac download for Apple Silicon and Intel
- Signed automatic updates with visible download and install progress
- Native update notifications, release notes, and a menu-bar update indicator
- Hardened Runtime, locked Electron fuses, and embedded ASAR integrity checks
- Minified production bundles with raw source excluded from distributable files
- Automated macOS quality gates on every push, pull request, and release

The live Core and Pro packages and signed entitlement architecture are
documented in [docs/PRODUCT_AND_SUBSCRIPTIONS.md](docs/PRODUCT_AND_SUBSCRIPTIONS.md).

## Development

Requirements:

- macOS
- Node.js 22 or newer

```bash
npm ci
npm start
```

During development, enable **Electron** under **System Settings → Privacy & Security → Accessibility**. Packaged builds appear as **Zap** instead.

## Local release build

Apple requires distributed macOS applications to be signed with a Developer ID certificate and notarized. Install your **Developer ID Application** certificate in Keychain Access, then set:

```bash
export APPLE_ID="developer@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDEFGHIJ"
```

Build the universal Apple Silicon and Intel release:

```bash
npm run release:mac
```

Signed and notarized `.dmg` and `.zip` files are written to `dist/`, alongside
the signed-update metadata and a `SHA256SUMS.txt` verification file.

Never commit credentials, app-specific passwords, `.p12` files, or certificate passwords.

## Automated signed releases

The release workflow runs when a protected `release/v*` branch is created from the exact reviewed `main` commit. Add these repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `MAC_CERTIFICATE_P12_BASE64` | Base64-encoded Developer ID Application `.p12` certificate |
| `CSC_KEY_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from account.apple.com |
| `APPLE_TEAM_ID` | Ten-character Apple Developer Team ID |
| `VERCEL_TOKEN` | Vercel access token allowed to deploy the `drip-type-updates` project |

Encode the certificate on macOS:

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy
```

Paste the clipboard contents into `MAC_CERTIFICATE_P12_BASE64`. Then publish a release:

```bash
git branch release/v1.6.2
git push origin release/v1.6.2
```

GitHub Actions builds one universal application, signs it with the VegaNext
Developer ID identity, submits it to Apple notarization, validates Gatekeeper
acceptance and the stapled ticket, generates SHA-256 checksums, and atomically
publishes the final files and update metadata to the dedicated Vercel update
service. It also creates a GitHub Release as an administrative backup. The
source repository and signing credentials remain private.

Signed production builds check `https://drip-type-updates.vercel.app/` shortly
after launch and every six hours. Users can also choose **Check for Updates…**
from the app or menu bar. Downloads begin only after user approval; Zap
shows release notes and progress, then offers **Restart to update**.

## Distribution security

- The repository is private and the package is marked `UNLICENSED` to prevent
  accidental npm publication or permissive source redistribution.
- Release builds never include the raw `src/` tree. Main, preload, and renderer
  code is bundled and minified without source maps before it enters `app.asar`.
- Electron fuses disable `ELECTRON_RUN_AS_NODE`, Node option injection, and
  production debugger flags. The app only loads the integrity-checked ASAR.
- macOS code signing detects modifications to the application bundle, and
  Apple notarization provides Gatekeeper trust for direct downloads.
- Automatic updates require a valid signed application and SHA-512 release
  metadata generated by electron-builder.
- Certificates and passwords live only in GitHub Actions secrets and are
  ignored by Git.

No client-side desktop software can be made impossible to reverse engineer.
These controls prevent casual source extraction, make modification detectable,
and materially raise the effort required to copy implementation details.

## Scaling model

Every typing session and writing draft stays local, so additional users do not
add writing-processing load to an API or database. A small stateless entitlement
service verifies Stripe subscription state and issues short-lived signed access
tokens; Vercel's edge network supplies the website and update distribution layer.
Release jobs use locked dependencies, a universal build, atomic deployments,
and concurrency protection to prevent duplicate publication for the same tag.

Source should remain in this private repository. Public distribution at scale
should use a separate public, binary-only release repository or an object-storage
CDN; never make the source repository public merely to expose downloads.

If a future version adds accounts, sync, analytics, or remote configuration, those services should be introduced behind a versioned API with rate limits, queue-backed event ingestion, health checks, and independent failure handling. None are needed for the current local-first product.

## Responsible use

Use automation only in applications and workflows where you have permission. Do not use it to impersonate another person or evade rules, monitoring, or assessment requirements.

## License

Proprietary. Copyright © 2026 VegaNext LLC. All rights reserved.

## Zap branding and upgrade compatibility

Zap is the app name, including desktop titles, installers, website, and logos.
Drip Type is its typing feature, opened with Option+5 on Mac or Alt+5 on Windows
by default. Existing custom shortcuts are preserved.

The application ID, activation URL scheme, signing audience, Keychain services,
and update-host domain remain stable so existing subscriptions and updates work.
On upgrade, Zap reuses an existing Drip Type settings directory, including its
encrypted vault and device binding. On macOS, the legacy internal name is kept
only until Electron binds the existing Safe Storage key; before opening windows,
the app restores the Zap name. New installs use the Zap settings directory.
Run `npm run test:branding:mac` to verify this across two isolated Electron
launches using synthetic text and a temporary Keychain item.

Published 1.7.4 download URLs and update metadata remain immutable. New packages
are named `Zap-${version}-mac.dmg` / `.zip` and `Zap-${version}-windows.exe`;
publish the next version through the release workflow before changing live links.
Local branding changes do not deploy the website or replace installed applications.
