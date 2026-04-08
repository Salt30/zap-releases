/*
 * zap_driver.c — Zap Kernel Driver Implementation
 *
 * Ring-0 Windows kernel driver providing:
 * - Process hiding via DKOM (ActiveProcessLinks unlinking)
 * - Anti-termination via ObRegisterCallbacks
 * - IOCTL interface for user-mode communication
 * - Self-destruct capability
 *
 * BUILD: Requires Windows Driver Kit (WDK) 10+
 *   msbuild zap_driver.vcxproj /p:Configuration=Release /p:Platform=x64
 *
 * Copyright (c) 2026 Zap AI. PROPRIETARY AND CONFIDENTIAL.
 */

#include "zap_driver.h"

// ── Global driver state ──
static ZAP_DRIVER_STATE g_State = { 0 };

// ── Undocumented EPROCESS offsets (Windows 10/11 22H2+) ──
// These must be updated per Windows build. Use PDBs or dynamic resolution.
// TODO: Implement dynamic offset resolution via PDB symbols
#define EPROCESS_ACTIVEPROCESSLINKS_OFFSET  0x448  // Win11 22H2+
#define EPROCESS_IMAGEFILENAME_OFFSET       0x5A8
#define EPROCESS_PID_OFFSET                 0x440

/* ═══════════════════════════════════════════════════════════
 *  DRIVER ENTRY / UNLOAD
 * ═══════════════════════════════════════════════════════════ */

NTSTATUS DriverEntry(
    _In_ PDRIVER_OBJECT  DriverObject,
    _In_ PUNICODE_STRING RegistryPath
) {
    UNREFERENCED_PARAMETER(RegistryPath);

    NTSTATUS status;
    UNICODE_STRING deviceName, symlinkName;
    PDEVICE_OBJECT deviceObject = NULL;

    DbgPrint("[ZAP] Driver loading...\n");

    // Initialize state
    ExInitializeFastMutex(&g_State.StateLock);

    // Create device object
    RtlInitUnicodeString(&deviceName, ZAP_DEVICE_NAME);
    status = IoCreateDevice(
        DriverObject,
        0,
        &deviceName,
        FILE_DEVICE_UNKNOWN,
        FILE_DEVICE_SECURE_OPEN,
        FALSE,
        &deviceObject
    );
    if (!NT_SUCCESS(status)) {
        DbgPrint("[ZAP] Failed to create device: 0x%X\n", status);
        return status;
    }

    // Create symbolic link for user-mode access
    RtlInitUnicodeString(&symlinkName, ZAP_SYMLINK_NAME);
    status = IoCreateSymbolicLink(&symlinkName, &deviceName);
    if (!NT_SUCCESS(status)) {
        DbgPrint("[ZAP] Failed to create symlink: 0x%X\n", status);
        IoDeleteDevice(deviceObject);
        return status;
    }

    // Set up dispatch routines
    DriverObject->MajorFunction[IRP_MJ_CREATE]         = ZapDispatchCreate;
    DriverObject->MajorFunction[IRP_MJ_CLOSE]          = ZapDispatchClose;
    DriverObject->MajorFunction[IRP_MJ_DEVICE_CONTROL] = ZapDispatchIoctl;
    DriverObject->DriverUnload                         = ZapDriverUnload;

    // Use direct I/O for buffer transfers
    deviceObject->Flags |= DO_DIRECT_IO;
    deviceObject->Flags &= ~DO_DEVICE_INITIALIZING;

    g_State.DeviceObject = deviceObject;

    DbgPrint("[ZAP] Driver loaded successfully. Device: %wZ\n", &deviceName);
    return STATUS_SUCCESS;
}

VOID ZapDriverUnload(_In_ PDRIVER_OBJECT DriverObject) {
    UNICODE_STRING symlinkName;

    DbgPrint("[ZAP] Driver unloading...\n");

    // Clean up — unhide/unprotect any active processes
    if (g_State.ProcessHidden) {
        ZapUnhideProcess(g_State.HiddenPid);
    }
    if (g_State.ProcessProtected) {
        ZapUnprotectProcess(g_State.ProtectedPid);
    }

    // Delete symbolic link and device
    RtlInitUnicodeString(&symlinkName, ZAP_SYMLINK_NAME);
    IoDeleteSymbolicLink(&symlinkName);
    IoDeleteDevice(DriverObject->DeviceObject);

    DbgPrint("[ZAP] Driver unloaded.\n");
}

/* ═══════════════════════════════════════════════════════════
 *  DISPATCH ROUTINES
 * ═══════════════════════════════════════════════════════════ */

NTSTATUS ZapDispatchCreate(
    _In_ PDEVICE_OBJECT DeviceObject,
    _In_ PIRP Irp
) {
    UNREFERENCED_PARAMETER(DeviceObject);
    Irp->IoStatus.Status = STATUS_SUCCESS;
    Irp->IoStatus.Information = 0;
    IoCompleteRequest(Irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

NTSTATUS ZapDispatchClose(
    _In_ PDEVICE_OBJECT DeviceObject,
    _In_ PIRP Irp
) {
    UNREFERENCED_PARAMETER(DeviceObject);
    Irp->IoStatus.Status = STATUS_SUCCESS;
    Irp->IoStatus.Information = 0;
    IoCompleteRequest(Irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

NTSTATUS ZapDispatchIoctl(
    _In_ PDEVICE_OBJECT DeviceObject,
    _In_ PIRP Irp
) {
    UNREFERENCED_PARAMETER(DeviceObject);

    NTSTATUS status = STATUS_SUCCESS;
    PIO_STACK_LOCATION irpSp = IoGetCurrentIrpStackLocation(Irp);
    ULONG ioctl = irpSp->Parameters.DeviceIoControl.IoControlCode;
    PVOID inputBuffer = Irp->AssociatedIrp.SystemBuffer;
    PVOID outputBuffer = Irp->AssociatedIrp.SystemBuffer;
    ULONG inputLen = irpSp->Parameters.DeviceIoControl.InputBufferLength;
    ULONG outputLen = irpSp->Parameters.DeviceIoControl.OutputBufferLength;
    ULONG bytesReturned = 0;

    switch (ioctl) {

    case IOCTL_ZAP_HIDE_PROCESS: {
        if (inputLen < sizeof(ZAP_PROCESS_REQUEST)) {
            status = STATUS_BUFFER_TOO_SMALL;
            break;
        }
        PZAP_PROCESS_REQUEST req = (PZAP_PROCESS_REQUEST)inputBuffer;
        DbgPrint("[ZAP] IOCTL: Hide process PID %u\n", req->ProcessId);
        status = ZapHideProcess(req->ProcessId);
        break;
    }

    case IOCTL_ZAP_UNHIDE_PROCESS: {
        if (inputLen < sizeof(ZAP_PROCESS_REQUEST)) {
            status = STATUS_BUFFER_TOO_SMALL;
            break;
        }
        PZAP_PROCESS_REQUEST req = (PZAP_PROCESS_REQUEST)inputBuffer;
        DbgPrint("[ZAP] IOCTL: Unhide process PID %u\n", req->ProcessId);
        status = ZapUnhideProcess(req->ProcessId);
        break;
    }

    case IOCTL_ZAP_PROTECT_PROCESS: {
        if (inputLen < sizeof(ZAP_PROCESS_REQUEST)) {
            status = STATUS_BUFFER_TOO_SMALL;
            break;
        }
        PZAP_PROCESS_REQUEST req = (PZAP_PROCESS_REQUEST)inputBuffer;
        DbgPrint("[ZAP] IOCTL: Protect process PID %u\n", req->ProcessId);
        status = ZapProtectProcess(req->ProcessId);
        break;
    }

    case IOCTL_ZAP_UNPROTECT_PROCESS: {
        if (inputLen < sizeof(ZAP_PROCESS_REQUEST)) {
            status = STATUS_BUFFER_TOO_SMALL;
            break;
        }
        PZAP_PROCESS_REQUEST req = (PZAP_PROCESS_REQUEST)inputBuffer;
        status = ZapUnprotectProcess(req->ProcessId);
        break;
    }

    case IOCTL_ZAP_GET_STATUS: {
        if (outputLen < sizeof(ZAP_STATUS)) {
            status = STATUS_BUFFER_TOO_SMALL;
            break;
        }
        PZAP_STATUS st = (PZAP_STATUS)outputBuffer;
        ExAcquireFastMutex(&g_State.StateLock);
        st->DriverLoaded    = TRUE;
        st->ProcessHidden   = g_State.ProcessHidden;
        st->ProcessProtected = g_State.ProcessProtected;
        st->HiddenPid       = g_State.HiddenPid;
        st->ProtectedPid    = g_State.ProtectedPid;
        st->DriverVersion   = ZAP_DRIVER_VERSION;
        ExReleaseFastMutex(&g_State.StateLock);
        bytesReturned = sizeof(ZAP_STATUS);
        break;
    }

    case IOCTL_ZAP_SELF_DESTRUCT: {
        DbgPrint("[ZAP] IOCTL: Self-destruct initiated!\n");
        status = ZapSelfDestruct();
        break;
    }

    default:
        status = STATUS_INVALID_DEVICE_REQUEST;
        break;
    }

    Irp->IoStatus.Status = status;
    Irp->IoStatus.Information = bytesReturned;
    IoCompleteRequest(Irp, IO_NO_INCREMENT);
    return status;
}

/* ═══════════════════════════════════════════════════════════
 *  PROCESS HIDING — DKOM (Direct Kernel Object Manipulation)
 *
 *  Unlinks the target EPROCESS from the ActiveProcessLinks
 *  doubly-linked list. This hides it from:
 *  - Task Manager
 *  - Process Explorer
 *  - NtQuerySystemInformation (SystemProcessInformation)
 *  - Any user-mode process enumeration
 *
 *  The process still runs — it's just invisible.
 * ═══════════════════════════════════════════════════════════ */

// Saved links for re-linking on unhide
static LIST_ENTRY g_SavedFlink = { 0 };
static LIST_ENTRY g_SavedBlink = { 0 };
static PEPROCESS  g_HiddenProcess = NULL;

NTSTATUS ZapHideProcess(ULONG ProcessId) {
    NTSTATUS status;
    PEPROCESS process = NULL;

    status = PsLookupProcessByProcessId((HANDLE)(ULONG_PTR)ProcessId, &process);
    if (!NT_SUCCESS(status)) {
        DbgPrint("[ZAP] Failed to find process %u: 0x%X\n", ProcessId, status);
        return status;
    }

    // Get the ActiveProcessLinks entry for this EPROCESS
    PLIST_ENTRY processLinks = (PLIST_ENTRY)((ULONG_PTR)process + EPROCESS_ACTIVEPROCESSLINKS_OFFSET);

    // Save the original links so we can restore later
    ExAcquireFastMutex(&g_State.StateLock);

    g_SavedFlink.Flink = processLinks->Flink;
    g_SavedBlink.Blink = processLinks->Blink;
    g_HiddenProcess = process;

    // Unlink from the doubly-linked list
    // Previous->Flink = Current->Flink (skip us going forward)
    // Next->Blink = Current->Blink (skip us going backward)
    processLinks->Flink->Blink = processLinks->Blink;
    processLinks->Blink->Flink = processLinks->Flink;

    // Point our links to ourselves (so we don't corrupt if accessed)
    processLinks->Flink = processLinks;
    processLinks->Blink = processLinks;

    g_State.ProcessHidden = TRUE;
    g_State.HiddenPid = ProcessId;

    ExReleaseFastMutex(&g_State.StateLock);

    ObDereferenceObject(process);
    DbgPrint("[ZAP] Process %u hidden from enumeration.\n", ProcessId);
    return STATUS_SUCCESS;
}

NTSTATUS ZapUnhideProcess(ULONG ProcessId) {
    UNREFERENCED_PARAMETER(ProcessId);

    ExAcquireFastMutex(&g_State.StateLock);

    if (!g_State.ProcessHidden || !g_HiddenProcess) {
        ExReleaseFastMutex(&g_State.StateLock);
        return STATUS_NOT_FOUND;
    }

    // Re-link the process back into ActiveProcessLinks
    PLIST_ENTRY processLinks = (PLIST_ENTRY)((ULONG_PTR)g_HiddenProcess + EPROCESS_ACTIVEPROCESSLINKS_OFFSET);

    processLinks->Flink = g_SavedFlink.Flink;
    processLinks->Blink = g_SavedBlink.Blink;
    g_SavedFlink.Flink->Blink = processLinks;
    g_SavedBlink.Blink->Flink = processLinks;

    g_State.ProcessHidden = FALSE;
    g_State.HiddenPid = 0;
    g_HiddenProcess = NULL;

    ExReleaseFastMutex(&g_State.StateLock);

    DbgPrint("[ZAP] Process unhidden.\n");
    return STATUS_SUCCESS;
}

/* ═══════════════════════════════════════════════════════════
 *  PROCESS PROTECTION — ObRegisterCallbacks
 *
 *  Intercepts handle creation/duplication to strip
 *  PROCESS_TERMINATE and PROCESS_SUSPEND_RESUME rights.
 *  This prevents any user-mode process (including lockdown
 *  browsers) from killing or suspending Zap.
 * ═══════════════════════════════════════════════════════════ */

OB_PREOP_CALLBACK_STATUS ZapObPreCallback(
    _In_ PVOID RegistrationContext,
    _Inout_ POB_PRE_OPERATION_INFORMATION OpInfo
) {
    UNREFERENCED_PARAMETER(RegistrationContext);

    if (OpInfo->ObjectType != *PsProcessType) return OB_PREOP_SUCCESS;
    if (!g_State.ProcessProtected) return OB_PREOP_SUCCESS;

    PEPROCESS targetProcess = (PEPROCESS)OpInfo->Object;
    ULONG targetPid = (ULONG)(ULONG_PTR)PsGetProcessId(targetProcess);

    if (targetPid != g_State.ProtectedPid) return OB_PREOP_SUCCESS;

    // Don't strip access from our own process
    PEPROCESS callerProcess = PsGetCurrentProcess();
    ULONG callerPid = (ULONG)(ULONG_PTR)PsGetProcessId(callerProcess);
    if (callerPid == g_State.ProtectedPid) return OB_PREOP_SUCCESS;

    // Strip dangerous access rights from handles opened by OTHER processes
    if (OpInfo->Operation == OB_OPERATION_HANDLE_CREATE) {
        OpInfo->Parameters->CreateHandleInformation.DesiredAccess &=
            ~(PROCESS_TERMINATE | PROCESS_VM_WRITE | PROCESS_VM_OPERATION |
              PROCESS_CREATE_THREAD | PROCESS_SUSPEND_RESUME);
    }
    if (OpInfo->Operation == OB_OPERATION_HANDLE_DUPLICATE) {
        OpInfo->Parameters->DuplicateHandleInformation.DesiredAccess &=
            ~(PROCESS_TERMINATE | PROCESS_VM_WRITE | PROCESS_VM_OPERATION |
              PROCESS_CREATE_THREAD | PROCESS_SUSPEND_RESUME);
    }

    return OB_PREOP_SUCCESS;
}

NTSTATUS ZapProtectProcess(ULONG ProcessId) {
    NTSTATUS status;
    OB_CALLBACK_REGISTRATION callbackReg;
    OB_OPERATION_REGISTRATION opReg;

    if (g_State.ProcessProtected) {
        // Already protecting a process — unprotect first
        ZapUnprotectProcess(g_State.ProtectedPid);
    }

    // Register the object callback
    RtlZeroMemory(&callbackReg, sizeof(callbackReg));
    RtlZeroMemory(&opReg, sizeof(opReg));

    opReg.ObjectType = PsProcessType;
    opReg.Operations = OB_OPERATION_HANDLE_CREATE | OB_OPERATION_HANDLE_DUPLICATE;
    opReg.PreOperation = ZapObPreCallback;
    opReg.PostOperation = NULL;

    callbackReg.Version = OB_FLT_REGISTRATION_VERSION;
    callbackReg.OperationRegistrationCount = 1;
    callbackReg.OperationRegistration = &opReg;

    // Altitude string — must be unique per driver
    UNICODE_STRING altitude;
    RtlInitUnicodeString(&altitude, L"321000");
    callbackReg.Altitude = altitude;
    callbackReg.RegistrationContext = NULL;

    status = ObRegisterCallbacks(&callbackReg, &g_State.ObCallbackHandle);
    if (!NT_SUCCESS(status)) {
        DbgPrint("[ZAP] ObRegisterCallbacks failed: 0x%X\n", status);
        return status;
    }

    ExAcquireFastMutex(&g_State.StateLock);
    g_State.ProcessProtected = TRUE;
    g_State.ProtectedPid = ProcessId;
    ExReleaseFastMutex(&g_State.StateLock);

    DbgPrint("[ZAP] Process %u is now protected from termination.\n", ProcessId);
    return STATUS_SUCCESS;
}

NTSTATUS ZapUnprotectProcess(ULONG ProcessId) {
    UNREFERENCED_PARAMETER(ProcessId);

    ExAcquireFastMutex(&g_State.StateLock);

    if (g_State.ObCallbackHandle) {
        ObUnRegisterCallbacks(g_State.ObCallbackHandle);
        g_State.ObCallbackHandle = NULL;
    }

    g_State.ProcessProtected = FALSE;
    g_State.ProtectedPid = 0;

    ExReleaseFastMutex(&g_State.StateLock);

    DbgPrint("[ZAP] Process protection removed.\n");
    return STATUS_SUCCESS;
}

/* ═══════════════════════════════════════════════════════════
 *  SCREEN CAPTURE (placeholder — actual impl uses DXGI)
 *
 *  Kernel-level screen capture is complex. The recommended
 *  approach is a Display-Only Miniport Driver or using the
 *  DXGI Desktop Duplication API from user-mode with the
 *  process hidden by this driver. The driver protects the
 *  capture process — the actual capture stays user-mode.
 * ═══════════════════════════════════════════════════════════ */

NTSTATUS ZapCaptureScreen(
    PZAP_CAPTURE_REQUEST Request,
    PVOID OutputBuffer,
    ULONG OutputBufferLength
) {
    UNREFERENCED_PARAMETER(Request);
    UNREFERENCED_PARAMETER(OutputBuffer);
    UNREFERENCED_PARAMETER(OutputBufferLength);

    // Screen capture is best done from user-mode via DXGI Desktop Duplication
    // with the process hidden + protected by this driver. Kernel-mode display
    // capture requires a Display Miniport Driver which is a separate project.
    // For now, the driver's job is stealth — capture stays in user-mode.

    return STATUS_NOT_IMPLEMENTED;
}

/* ═══════════════════════════════════════════════════════════
 *  SELF-DESTRUCT
 *  Unhides process, unprotects, and prepares for removal.
 * ═══════════════════════════════════════════════════════════ */

NTSTATUS ZapSelfDestruct(void) {
    DbgPrint("[ZAP] Self-destruct: cleaning up...\n");

    // 1. Unhide the process
    if (g_State.ProcessHidden) {
        ZapUnhideProcess(g_State.HiddenPid);
    }

    // 2. Remove protection
    if (g_State.ProcessProtected) {
        ZapUnprotectProcess(g_State.ProtectedPid);
    }

    // 3. The user-mode component handles file deletion and cleanup
    // The driver just removes its own protections so the app can be killed cleanly

    DbgPrint("[ZAP] Self-destruct complete. Driver protections removed.\n");
    return STATUS_SUCCESS;
}

/* ═══════════════════════════════════════════════════════════
 *  FILE HIDING (placeholder for minifilter integration)
 * ═══════════════════════════════════════════════════════════ */

NTSTATUS ZapHideFile(PCWSTR FilePath) {
    UNREFERENCED_PARAMETER(FilePath);
    // File hiding requires a minifilter driver (FltRegisterFilter).
    // This would intercept IRP_MJ_DIRECTORY_CONTROL and remove
    // Zap's files from directory listings. This is a separate
    // component — see kernel/windows/minifilter/ for implementation.
    return STATUS_NOT_IMPLEMENTED;
}
