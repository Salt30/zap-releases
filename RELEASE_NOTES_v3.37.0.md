# Zap v3.37.0

## New

- **In-process D3D11 overlay** (`kernel/windows/overlay/zap_overlay.dll`)
  Injects into the host, hooks `IDXGISwapChain::Present` (idx 8) and
  `IDXGISwapChain::ResizeBuffers` (idx 13), renders inside the host's own
  render loop. No top-level overlay window for enumeration scanners to find.
- **Node bridge** (`kernel/windows/overlay/zap_overlay_node.js`)
  Loads the DLL via ffi-napi, exposes `available/init/ready/shutdown`.
  Gracefully no-ops when ffi-napi or the DLL are missing.

## Build changes

- CI now vendors [MinHook](https://github.com/TsudaKageyu/minhook) at build
  time, compiles `zap_shield.dll` + `zap_overlay.dll` on `windows-latest`,
  and bundles both into `dist/shield/` for electron-builder to pick up.
- Mac/Linux jobs write zero-byte stubs so electron-builder's
  `extraResources` filter still resolves cross-platform.

## Fixes vs the standalone hook snippet

- Added `ResizeBuffers` hook — original would crash the host on window
  resize (RTV held stale texture).
- Host GPU state (RTV/DSV, viewport) is snapshotted and restored around
  the draw callback so the host's next-frame bindings aren't clobbered.
- Init moved off DllMain via `CreateThread` — avoids loader-lock deadlock.
- Mutex + atomics around device/rtv/callback state.
