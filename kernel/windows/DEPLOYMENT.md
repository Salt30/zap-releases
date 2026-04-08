# Zap Shield — Windows Kernel Driver Deployment Guide

## Architecture Overview

```
┌──────────────────────────────────────────────────┐
│  Electron App (src/main.js)                      │
│    └── require('zap_shield_node.js')             │
│          └── ffi-napi loads zap_shield.dll       │
│                └── DeviceIoControl ────────────┐ │
└────────────────────────────────────────────────┼─┘
                                                 │
═══════════════════ KERNEL BOUNDARY ═════════════╪═══
                                                 │
┌────────────────────────────────────────────────▼─┐
│  zap_driver.sys (Ring 0)                         │
│    ├── DKOM: Unlinks EPROCESS from               │
│    │   ActiveProcessLinks (process invisible)    │
│    └── ObRegisterCallbacks: Strips               │
│        PROCESS_TERMINATE (process unkillable)    │
└──────────────────────────────────────────────────┘
```

## File Structure

```
kernel/windows/
├── build.bat               # Build both driver + DLL
├── install_driver.bat      # Install/uninstall driver service (admin)
├── sign_driver.bat         # Sign driver for test or production
├── DEPLOYMENT.md           # This file
├── driver/
│   ├── zap_driver.c        # Kernel driver source
│   ├── zap_driver.h        # Driver header + IOCTL codes
│   ├── zap_driver.inf      # Driver installation INF
│   └── zap_driver.vcxproj  # MSBuild project (WDK)
└── usermode/
    ├── zap_shield.c        # User-mode DLL source
    ├── zap_shield.h        # DLL header
    ├── zap_shield.def      # DLL export definitions
    └── zap_shield_node.js  # Node.js/Electron bridge (ffi-napi)
```

## Prerequisites

1. **Visual Studio 2022** — "Desktop development with C++" workload
2. **Windows Driver Kit (WDK) 10.0.22621.0+** — [Download](https://learn.microsoft.com/en-us/windows-hardware/drivers/download-the-wdk)
3. **Windows SDK 10.0.22621.0+** — Usually installed with VS
4. **EV Code Signing Certificate** — Required for production driver signing
5. **Microsoft Partner Center account** — For attestation (WHQL) signing

## Build Steps

### 1. Build Everything
Open **x64 Native Tools Command Prompt for VS 2022**, then:
```cmd
cd kernel\windows
build.bat           # Release build
build.bat debug     # Debug build
build.bat clean     # Remove artifacts
```

Output:
- `dist/driver/Release/zap_driver.sys` — Kernel driver
- `dist/shield/zap_shield.dll` — User-mode DLL

### 2. Sign for Development (Test Signing)
```cmd
REM Enable test signing on the dev machine (one-time, requires reboot)
bcdedit /set testsigning on

REM Sign the driver
sign_driver.bat test
```

### 3. Install Driver (Dev Machine)
Run as Administrator:
```cmd
install_driver.bat install    # Install + start
install_driver.bat status     # Check state
install_driver.bat uninstall  # Remove
```

### 4. Test Integration
```cmd
cd ..\..
npm install                   # Installs ffi-napi + ref-napi
npm start                     # Launch Zap
```

Enable Lockdown Mode in Settings — the kernel shield activates automatically.

## Production Signing Flow

Production Windows kernel drivers require **two signatures**:

### Step 1: EV Code Signing
Purchase an EV code signing certificate from a CA (DigiCert, Sectigo, etc.).
The certificate MUST be on a hardware token (USB HSM).

```cmd
sign_driver.bat prod
```

### Step 2: Microsoft Attestation Signing
1. Go to [Microsoft Partner Center](https://partner.microsoft.com/dashboard/hardware)
2. Create a new submission → "Attestation signing"
3. Package the driver:
   ```cmd
   makecab /f zap_driver.ddf
   ```
4. Upload the `.cab` package
5. Wait for Microsoft to process (usually 1-3 business days)
6. Download the Microsoft-signed driver package
7. Ship this Microsoft-signed `.sys` to users

### Step 3: Ship with Zap Installer
The NSIS installer (`electron-builder` win target) includes:
- `zap_shield.dll` → bundled via `extraResources` in package.json
- `zap_driver.sys` → installed by a post-install script or first-run admin prompt

## How It Works in Zap

### Automatic Activation
When the user enables **Lockdown Mode** in Settings:

1. `main.js` calls `activateKernelStealth()`
2. Node bridge → `zap_shield.dll` → `DeviceIoControl(IOCTL_ZAP_HIDE_PROCESS)`
3. Kernel driver unlinks the Electron process from Windows' process list
4. Node bridge → `zap_shield.dll` → `DeviceIoControl(IOCTL_ZAP_PROTECT_PROCESS)`
5. Kernel driver registers ObCallback stripping PROCESS_TERMINATE from all handle opens

**Result**: Zap is invisible in Task Manager and cannot be killed by lockdown browsers.

### Graceful Fallback
If the kernel driver is not installed (most users won't have it):
- `kernelShield.available()` returns `false`
- All stealth functions return `false`
- Zap falls back to user-mode stealth (process disguise, watchdog, etc.)
- Zero errors, zero crashes — completely transparent

### Self-Destruct
When triggered, `shutdownKernelShield()`:
1. Calls `stealthOff()` (unhide + unprotect)
2. Calls `close()` (release driver handle)
3. App can then exit normally

## EPROCESS Offset Note

The driver uses offset `0x448` for `ActiveProcessLinks` in `EPROCESS`.
This is correct for **Windows 11 22H2+** (builds 22621+).

For broader compatibility, implement dynamic offset resolution:
```c
// TODO: Download PDB symbols for ntoskrnl.exe at runtime
// and resolve EPROCESS.ActiveProcessLinks offset dynamically.
// This ensures compatibility across all Windows 10/11 builds.
```

Known offsets:
- Windows 10 1903-21H2: `0x2F0`
- Windows 10 22H2: `0x448`
- Windows 11 21H2: `0x448`
- Windows 11 22H2+: `0x448`

## Security Considerations

1. **Driver is ring-0 code** — bugs can BSOD the machine. Test thoroughly in VMs first.
2. **DKOM is not supported by Microsoft** — it works but could break with Windows updates.
3. **ObRegisterCallbacks is the official API** — this part is stable and supported.
4. **Never ship without Microsoft attestation signing** — unsigned drivers won't load on consumer Windows.
5. **The DLL gracefully degrades** — if ffi-napi fails to load, all functions return false.
