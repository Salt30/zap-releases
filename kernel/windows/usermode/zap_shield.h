/*
 * zap_shield.h — User-mode interface to Zap kernel driver
 *
 * This DLL provides a clean C API for the Electron app to communicate
 * with the kernel driver via IOCTL calls through DeviceIoControl.
 *
 * Copyright (c) 2026 Zap AI. PROPRIETARY AND CONFIDENTIAL.
 */

#pragma once

#ifdef ZAP_SHIELD_EXPORTS
#define ZAP_API __declspec(dllexport)
#else
#define ZAP_API __declspec(dllimport)
#endif

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// ── Status ──
typedef struct {
    bool     driverLoaded;
    bool     processHidden;
    bool     processProtected;
    uint32_t hiddenPid;
    uint32_t protectedPid;
    uint32_t driverVersion;
} ZapStatus;

// ── Core API ──

// Initialize connection to the kernel driver. Returns true if driver is loaded.
ZAP_API bool zap_init(void);

// Close the connection. Call before app exit.
ZAP_API void zap_close(void);

// Check if the kernel driver is available
ZAP_API bool zap_driver_available(void);

// Get current driver status
ZAP_API bool zap_get_status(ZapStatus* status);

// ── Process Stealth ──

// Hide the current process (or a specific PID) from Task Manager, etc.
// Process keeps running — just invisible to all user-mode enumeration.
ZAP_API bool zap_hide_self(void);
ZAP_API bool zap_hide_process(uint32_t pid);
ZAP_API bool zap_unhide_process(uint32_t pid);

// ── Process Protection ──

// Make the current process (or a specific PID) unkillable by other processes.
// Strips PROCESS_TERMINATE from all handles opened by other processes.
ZAP_API bool zap_protect_self(void);
ZAP_API bool zap_protect_process(uint32_t pid);
ZAP_API bool zap_unprotect_process(uint32_t pid);

// ── Self-Destruct ──

// Tell the driver to remove all protections so the app can clean up and exit.
ZAP_API bool zap_self_destruct(void);

// ── Convenience ──

// Do everything: hide + protect current process in one call
ZAP_API bool zap_stealth_mode(void);

// Undo everything: unhide + unprotect in one call
ZAP_API bool zap_stealth_off(void);

#ifdef __cplusplus
}
#endif
