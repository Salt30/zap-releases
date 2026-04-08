/*
 * zap_shield.c — User-mode DLL to communicate with Zap kernel driver
 *
 * Provides a simple C API that the Electron app calls via node-ffi-napi.
 * All communication goes through DeviceIoControl to the kernel driver.
 *
 * BUILD:
 *   cl /LD /O2 /DZAP_SHIELD_EXPORTS zap_shield.c /Fe:zap_shield.dll
 *
 * Copyright (c) 2026 Zap AI. PROPRIETARY AND CONFIDENTIAL.
 */

#define ZAP_SHIELD_EXPORTS
#include "zap_shield.h"

#include <windows.h>
#include <winioctl.h>
#include <stdio.h>

// ── IOCTL codes (must match kernel driver) ──
#define IOCTL_ZAP_HIDE_PROCESS      CTL_CODE(0x8000, 0x800, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_UNHIDE_PROCESS    CTL_CODE(0x8000, 0x801, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_PROTECT_PROCESS   CTL_CODE(0x8000, 0x802, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_UNPROTECT_PROCESS CTL_CODE(0x8000, 0x803, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_CAPTURE_SCREEN    CTL_CODE(0x8000, 0x804, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_GET_STATUS        CTL_CODE(0x8000, 0x805, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_HIDE_FILE         CTL_CODE(0x8000, 0x806, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_SELF_DESTRUCT     CTL_CODE(0x8000, 0x807, METHOD_BUFFERED, FILE_ANY_ACCESS)

// Device path
#define ZAP_DEVICE_PATH L"\\\\.\\ZapShield"

// Global handle to the driver
static HANDLE g_DriverHandle = INVALID_HANDLE_VALUE;

/* ═══════════════════════════════════════════════════════════
 *  INIT / CLOSE
 * ═══════════════════════════════════════════════════════════ */

ZAP_API bool zap_init(void) {
    if (g_DriverHandle != INVALID_HANDLE_VALUE) return true;

    g_DriverHandle = CreateFileW(
        ZAP_DEVICE_PATH,
        GENERIC_READ | GENERIC_WRITE,
        0,
        NULL,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        NULL
    );

    if (g_DriverHandle == INVALID_HANDLE_VALUE) {
        // Driver not loaded — fall back to user-mode stealth
        return false;
    }

    return true;
}

ZAP_API void zap_close(void) {
    if (g_DriverHandle != INVALID_HANDLE_VALUE) {
        CloseHandle(g_DriverHandle);
        g_DriverHandle = INVALID_HANDLE_VALUE;
    }
}

ZAP_API bool zap_driver_available(void) {
    if (g_DriverHandle == INVALID_HANDLE_VALUE) {
        zap_init();
    }
    return g_DriverHandle != INVALID_HANDLE_VALUE;
}

// Helper: send IOCTL with a PID
static bool send_pid_ioctl(DWORD ioctl, uint32_t pid) {
    if (g_DriverHandle == INVALID_HANDLE_VALUE) return false;

    DWORD bytesReturned = 0;
    uint32_t inputPid = pid;

    BOOL result = DeviceIoControl(
        g_DriverHandle,
        ioctl,
        &inputPid,
        sizeof(inputPid),
        NULL,
        0,
        &bytesReturned,
        NULL
    );

    return result != FALSE;
}

/* ═══════════════════════════════════════════════════════════
 *  STATUS
 * ═══════════════════════════════════════════════════════════ */

// Kernel-side status struct (must match driver layout)
#pragma pack(push, 1)
typedef struct {
    uint8_t  driverLoaded;
    uint8_t  processHidden;
    uint8_t  processProtected;
    uint32_t hiddenPid;
    uint32_t protectedPid;
    uint32_t driverVersion;
} KernelStatus;
#pragma pack(pop)

ZAP_API bool zap_get_status(ZapStatus* status) {
    if (!status) return false;
    if (g_DriverHandle == INVALID_HANDLE_VALUE) {
        status->driverLoaded = false;
        return false;
    }

    KernelStatus ks = { 0 };
    DWORD bytesReturned = 0;

    BOOL result = DeviceIoControl(
        g_DriverHandle,
        IOCTL_ZAP_GET_STATUS,
        NULL, 0,
        &ks, sizeof(ks),
        &bytesReturned,
        NULL
    );

    if (!result) return false;

    status->driverLoaded    = ks.driverLoaded;
    status->processHidden   = ks.processHidden;
    status->processProtected = ks.processProtected;
    status->hiddenPid       = ks.hiddenPid;
    status->protectedPid    = ks.protectedPid;
    status->driverVersion   = ks.driverVersion;

    return true;
}

/* ═══════════════════════════════════════════════════════════
 *  PROCESS HIDING
 * ═══════════════════════════════════════════════════════════ */

ZAP_API bool zap_hide_self(void) {
    return zap_hide_process(GetCurrentProcessId());
}

ZAP_API bool zap_hide_process(uint32_t pid) {
    return send_pid_ioctl(IOCTL_ZAP_HIDE_PROCESS, pid);
}

ZAP_API bool zap_unhide_process(uint32_t pid) {
    return send_pid_ioctl(IOCTL_ZAP_UNHIDE_PROCESS, pid);
}

/* ═══════════════════════════════════════════════════════════
 *  PROCESS PROTECTION
 * ═══════════════════════════════════════════════════════════ */

ZAP_API bool zap_protect_self(void) {
    return zap_protect_process(GetCurrentProcessId());
}

ZAP_API bool zap_protect_process(uint32_t pid) {
    return send_pid_ioctl(IOCTL_ZAP_PROTECT_PROCESS, pid);
}

ZAP_API bool zap_unprotect_process(uint32_t pid) {
    return send_pid_ioctl(IOCTL_ZAP_UNPROTECT_PROCESS, pid);
}

/* ═══════════════════════════════════════════════════════════
 *  SELF-DESTRUCT
 * ═══════════════════════════════════════════════════════════ */

ZAP_API bool zap_self_destruct(void) {
    if (g_DriverHandle == INVALID_HANDLE_VALUE) return false;

    DWORD bytesReturned = 0;
    BOOL result = DeviceIoControl(
        g_DriverHandle,
        IOCTL_ZAP_SELF_DESTRUCT,
        NULL, 0,
        NULL, 0,
        &bytesReturned,
        NULL
    );

    return result != FALSE;
}

/* ═══════════════════════════════════════════════════════════
 *  CONVENIENCE
 * ═══════════════════════════════════════════════════════════ */

ZAP_API bool zap_stealth_mode(void) {
    if (!zap_init()) return false;

    uint32_t pid = GetCurrentProcessId();
    bool hidden = zap_hide_process(pid);
    bool protect = zap_protect_process(pid);

    return hidden && protect;
}

ZAP_API bool zap_stealth_off(void) {
    if (g_DriverHandle == INVALID_HANDLE_VALUE) return false;

    uint32_t pid = GetCurrentProcessId();
    zap_unhide_process(pid);
    zap_unprotect_process(pid);

    return true;
}

/* ═══════════════════════════════════════════════════════════
 *  DLL ENTRY POINT
 * ═══════════════════════════════════════════════════════════ */

BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID reserved) {
    (void)hModule;
    (void)reserved;

    switch (reason) {
    case DLL_PROCESS_ATTACH:
        // Auto-init when DLL is loaded
        zap_init();
        break;
    case DLL_PROCESS_DETACH:
        zap_close();
        break;
    }
    return TRUE;
}
