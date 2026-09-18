# Zap 1.8.0

Release date: September 18, 2026.

- [Website](https://tryzap.net)
- [Universal Mac installer](https://drip-type-updates.vercel.app/Zap-1.8.0-mac.dmg)
- [Windows x64 installer](https://drip-type-updates.vercel.app/Zap-1.8.0-windows.exe)
- [Release pipeline](https://github.com/Salt30/Drip-type/actions/runs/35400557745)
- [Source and release assets](https://github.com/Salt30/Drip-type/releases/tag/v1.8.0)

## Delivered

Zap branding, the integrated AI workspace, Drip Type on Option/Alt+5, secure
browser sign-in and sign-out, account and website hardening, and bounded window
recovery are packaged in this release. Templates, Pro Studio, Profiles, and the
Clipboard workspace are removed. Phantom and Lockdown evasion mechanisms remain
excluded.

Release source: `28e06ae341d213c14e0682e33ce71d82dd005b76`, including the approved
integration and a Windows archive-path correction in the credential scanner.

## Verification

- Mac: universal Intel/Apple Silicon build, Developer ID signing, notarization,
  Gatekeeper acceptance, stapled-ticket validation, package hardening, credential
  scanning, and launch smoke test passed.
- Windows: native installer build, package hardening, credential scanning, and
  launch smoke test passed. The Windows installer is not code-signed.
- Public DMG, ZIP, and EXE files were downloaded in full and their SHA-256 and
  updater SHA-512 hashes matched the verified build. All six artifact/blockmap
  endpoints were available. Published updater metadata matched release assets.
- Existing 1.7.4 download redirects and blobs are retained.
- Website download buttons, account links, structured metadata, and CSP hashes
  are updated to the verified 1.8.0 release.

## AI availability

Hosted AI remains unavailable until a rotated `NVIDIA_API_KEY` is configured as a
sensitive Production server variable and the website/backend is redeployed.
The website and release notes disclose this limitation. No provider credential
is included in the desktop app. Drip Type remains available with an active
subscription. The credential shared earlier in chat was not reused.
