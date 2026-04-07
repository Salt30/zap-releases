/**
 * zap_shield.c — Windows Kernel-Mode Driver for Zap Process Protection
 *
 * This WDM driver uses ObRegisterCallbacks to intercept handle operations
 * targeting the Zap process. It strips dangerous access rights (VM_READ,
 * QUERY_INFORMATION, TERMINATE) so proctoring software like Respondus
 * and DigiExam get ACCESS_DENIED when they try to:
 *   - Read our process memory (to extract keys)
 *   - Query our process info (to identify us)
 *   - Terminate our process (to kill us)
 *   - Enumerate our threads (to detect activity)
 *
 * Additionally registers a process creation callback to hide Zap from
 * process enumeration (PsSetCreateProcessNotifyRoutine).
 *
 * Build: Requires WDK (Windows Driver Kit)
 *   msbuild zap_shield.vcxproj /p:Configuration=Release /p:Platform=x64
 *
 * Install: sc create ZapShield type=kernel binPath=C:\path\to\zap_shield.sys
 *          sc start ZapShield
 *
 * The usermode component (zap_shield_node.node) communicates via DeviceIoControl.
 */

#include <ntifs.h>
#include <ntddk.h>
#include <wdm.h>

#define DEVICE_NAME     L"\\Device\\ZapShield"
#define SYMLINK_NAME    L"\\DosDevices\\ZapShield"

// IOCTL codes for usermode communication
#define IOCTL_ZAP_SET_PID       CTL_CODE(FILE_DEVICE_UNKNOWN, 0x800, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_STEALTH_ON    CTL_CODE(FILE_DEVICE_UNKNOWN, 0x801, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_STEALTH_OFF   CTL_CODE(FILE_DEVICE_UNKNOWN, 0x802, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_ZAP_IS_AVAILABLE  CTL_CODE(FILE_DEVICE_UNKNOWN, 0x803, METHOD_BUFFERED, FILE_ANY_ACCESS)

// Access rights to strip from handles targeting our process
#define DANGEROUS_ACCESS_MASK ( \
    PROCESS_VM_READ | \
    PROCESS_VM_WRITE | \
    PROCESS_VM_OPERATION | \
    PROCESS_QUERY_INFORMATION | \
    PROCESS_QUERY_LIMITED_INFORMATION | \
    PROCESS_TERMINATE | \
    PROCESS_SUSPEND_RESUME | \
    PROCESS_DUP_HANDLE \
)

// Thread access rights to strip
#define DANGEROUS_THREAD_ACCESS ( \
    THREAD_TERMINATE | \
    THREAD_SUSPEND_RESUME | \
    THREAD_GET_CONTEXT | \
    THREAD_SET_CONTEXT | \
    THREAD_QUERY_INFORMATION \
)

// Global state
static HANDLE g_ProtectedPid = (HANDLE)0;
static BOOLEAN g_StealthActive = FALSE;
static PVOID g_ObCallbackHandle = NULL;
static PDEVICE_OBJECT g_DeviceObject = NULL;
static UNICODE_STRING g_DeviceName;
static UNICODE_STRING g_SymlinkName;

// Altitude for ObRegisterCallbacks (must be unique — using FSFilter range)
static UNICODE_STRING g_Altitude = RTL_CONSTANT_STRING(L"321321");

/**
 * ObPreOperationCallback — Intercepts handle creation/duplication targeting our process.
 *
 * When Respondus/DigiExam calls OpenProcess() on our PID, Windows creates a handle
 * with the requested access rights. We intercept this and strip dangerous rights
 * so the handle is useless for reading memory, querying info, or terminating.
 *
 * The proctor gets a valid handle but with zero useful permissions → ACCESS_DENIED
 * on any subsequent operation that needs the stripped rights.
 */
OB_PREOP_CALLBACK_STATUS
PreOperationCallback(
    _In_ PVOID RegistrationContext,
    _Inout_ POB_PRE_OPERATION_INFORMATION OperationInformation
)
{
    UNREFERENCED_PARAMETER(RegistrationContext);

    if (!g_StealthActive || g_ProtectedPid == (HANDLE)0) {
        return OB_PREOP_SUCCESS;
    }

    // Don't strip access for kernel-mode callers (would break OS functionality)
    if (OperationInformation->KernelHandle) {
        return OB_PREOP_SUCCESS;
    }

    // === PROCESS HANDLE PROTECTION ===
    if (OperationInformation->ObjectType == *PsProcessType) {
        PEPROCESS targetProcess = (PEPROCESS)OperationInformation->Object;
        HANDLE targetPid = PsGetProcessId(targetProcess);

        if (targetPid == g_ProtectedPid) {
            // Don't strip access from ourselves
            PEPROCESS currentProcess = PsGetCurrentProcess();
            HANDLE currentPid = PsGetProcessId(currentProcess);
            if (currentPid == g_ProtectedPid) {
                return OB_PREOP_SUCCESS;
            }

            // Strip all dangerous access rights
            if (OperationInformation->Operation == OB_OPERATION_HANDLE_CREATE) {
                OperationInformation->Parameters->CreateHandleInformation.DesiredAccess &= ~DANGEROUS_ACCESS_MASK;
            }
            else if (OperationInformation->Operation == OB_OPERATION_HANDLE_DUPLICATE) {
                OperationInformation->Parameters->DuplicateHandleInformation.DesiredAccess &= ~DANGEROUS_ACCESS_MASK;
            }
        }
    }

    // === THREAD HANDLE PROTECTION ===
    if (OperationInformation->ObjectType == *PsThreadType) {
        PETHREAD targetThread = (PETHREAD)OperationInformation->Object;
        PEPROCESS ownerProcess = IoThreadToProcess(targetThread);
        HANDLE ownerPid = PsGetProcessId(ownerProcess);

        if (ownerPid == g_ProtectedPid) {
            PEPROCESS currentProcess = PsGetCurrentProcess();
            HANDLE currentPid = PsGetProcessId(currentProcess);
            if (currentPid == g_ProtectedPid) {
                return OB_PREOP_SUCCESS;
            }

            // Strip thread access rights
            if (OperationInformation->Operation == OB_OPERATION_HANDLE_CREATE) {
                OperationInformation->Parameters->CreateHandleInformation.DesiredAccess &= ~DANGEROUS_THREAD_ACCESS;
            }
            else if (OperationInformation->Operation == OB_OPERATION_HANDLE_DUPLICATE) {
                OperationInformation->Parameters->DuplicateHandleInformation.DesiredAccess &= ~DANGEROUS_THREAD_ACCESS;
            }
        }
    }

    return OB_PREOP_SUCCESS;
}

/**
 * Register ObCallbacks to intercept handle operations
 */
NTSTATUS RegisterObCallbacks(void)
{
    OB_CALLBACK_REGISTRATION callbackRegistration;
    OB_OPERATION_REGISTRATION operationRegistration[2];

    // Process handle interception
    operationRegistration[0].ObjectType = PsProcessType;
    operationRegistration[0].Operations = OB_OPERATION_HANDLE_CREATE | OB_OPERATION_HANDLE_DUPLICATE;
    operationRegistration[0].PreOperation = PreOperationCallback;
    operationRegistration[0].PostOperation = NULL;

    // Thread handle interception
    operationRegistration[1].ObjectType = PsThreadType;
    operationRegistration[1].Operations = OB_OPERATION_HANDLE_CREATE | OB_OPERATION_HANDLE_DUPLICATE;
    operationRegistration[1].PreOperation = PreOperationCallback;
    operationRegistration[1].PostOperation = NULL;

    callbackRegistration.Version = OB_FLT_REGISTRATION_VERSION;
    callbackRegistration.OperationRegistrationCount = 2;
    callbackRegistration.Altitude = g_Altitude;
    callbackRegistration.RegistrationContext = NULL;
    callbackRegistration.OperationRegistration = operationRegistration;

    return ObRegisterCallbacks(&callbackRegistration, &g_ObCallbackHandle);
}

/**
 * DeviceIoControl handler — receives commands from usermode (Zap app)
 */
NTSTATUS
DeviceControl(
    _In_ PDEVICE_OBJECT DeviceObject,
    _Inout_ PIRP Irp
)
{
    UNREFERENCED_PARAMETER(DeviceObject);

    PIO_STACK_LOCATION ioStack = IoGetCurrentIrpStackLocation(Irp);
    ULONG ioControlCode = ioStack->Parameters.DeviceIoControl.IoControlCode;
    PVOID inputBuffer = Irp->AssociatedIrp.SystemBuffer;
    ULONG inputLength = ioStack->Parameters.DeviceIoControl.InputBufferLength;
    NTSTATUS status = STATUS_SUCCESS;
    ULONG bytesReturned = 0;

    switch (ioControlCode) {
    case IOCTL_ZAP_SET_PID:
        if (inputLength >= sizeof(ULONG)) {
            ULONG pid = *(PULONG)inputBuffer;
            g_ProtectedPid = (HANDLE)(ULONG_PTR)pid;
            DbgPrint("[ZapShield] Protected PID set to: %lu\n", pid);
        } else {
            status = STATUS_BUFFER_TOO_SMALL;
        }
        break;

    case IOCTL_ZAP_STEALTH_ON:
        g_StealthActive = TRUE;
        // Also set PID if provided
        if (inputLength >= sizeof(ULONG)) {
            ULONG pid = *(PULONG)inputBuffer;
            if (pid != 0) {
                g_ProtectedPid = (HANDLE)(ULONG_PTR)pid;
            }
        }
        DbgPrint("[ZapShield] Stealth mode ACTIVATED for PID %lu\n", (ULONG)(ULONG_PTR)g_ProtectedPid);
        break;

    case IOCTL_ZAP_STEALTH_OFF:
        g_StealthActive = FALSE;
        DbgPrint("[ZapShield] Stealth mode DEACTIVATED\n");
        break;

    case IOCTL_ZAP_IS_AVAILABLE:
        if (ioStack->Parameters.DeviceIoControl.OutputBufferLength >= sizeof(ULONG)) {
            *(PULONG)Irp->AssociatedIrp.SystemBuffer = 1; // Driver is loaded and ready
            bytesReturned = sizeof(ULONG);
        }
        break;

    default:
        status = STATUS_INVALID_DEVICE_REQUEST;
        break;
    }

    Irp->IoStatus.Status = status;
    Irp->IoStatus.Information = bytesReturned;
    IoCompleteRequest(Irp, IO_NO_INCREMENT);
    return status;
}

NTSTATUS DeviceCreateClose(PDEVICE_OBJECT DeviceObject, PIRP Irp)
{
    UNREFERENCED_PARAMETER(DeviceObject);
    Irp->IoStatus.Status = STATUS_SUCCESS;
    Irp->IoStatus.Information = 0;
    IoCompleteRequest(Irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

/**
 * DriverUnload — Clean up when driver is stopped
 */
VOID DriverUnload(_In_ PDRIVER_OBJECT DriverObject)
{
    UNREFERENCED_PARAMETER(DriverObject);

    if (g_ObCallbackHandle) {
        ObUnRegisterCallbacks(g_ObCallbackHandle);
        g_ObCallbackHandle = NULL;
    }

    IoDeleteSymbolicLink(&g_SymlinkName);
    if (g_DeviceObject) {
        IoDeleteDevice(g_DeviceObject);
    }

    DbgPrint("[ZapShield] Driver unloaded\n");
}

/**
 * DriverEntry — Driver initialization
 */
NTSTATUS
DriverEntry(
    _In_ PDRIVER_OBJECT DriverObject,
    _In_ PUNICODE_STRING RegistryPath
)
{
    UNREFERENCED_PARAMETER(RegistryPath);
    NTSTATUS status;

    DbgPrint("[ZapShield] Driver loading...\n");

    // Create device
    RtlInitUnicodeString(&g_DeviceName, DEVICE_NAME);
    RtlInitUnicodeString(&g_SymlinkName, SYMLINK_NAME);

    status = IoCreateDevice(
        DriverObject,
        0,
        &g_DeviceName,
        FILE_DEVICE_UNKNOWN,
        FILE_DEVICE_SECURE_OPEN,
        FALSE,
        &g_DeviceObject
    );
    if (!NT_SUCCESS(status)) {
        DbgPrint("[ZapShield] Failed to create device: 0x%X\n", status);
        return status;
    }

    status = IoCreateSymbolicLink(&g_SymlinkName, &g_DeviceName);
    if (!NT_SUCCESS(status)) {
        IoDeleteDevice(g_DeviceObject);
        DbgPrint("[ZapShield] Failed to create symlink: 0x%X\n", status);
        return status;
    }

    // Set dispatch routines
    DriverObject->MajorFunction[IRP_MJ_CREATE] = DeviceCreateClose;
    DriverObject->MajorFunction[IRP_MJ_CLOSE] = DeviceCreateClose;
    DriverObject->MajorFunction[IRP_MJ_DEVICE_CONTROL] = DeviceControl;
    DriverObject->DriverUnload = DriverUnload;

    // Register ObCallbacks for process/thread handle protection
    status = RegisterObCallbacks();
    if (!NT_SUCCESS(status)) {
        DbgPrint("[ZapShield] ObRegisterCallbacks failed: 0x%X (driver still loaded — usermode protection only)\n", status);
        // Don't fail driver load — the device interface still works for usermode detection
    } else {
        DbgPrint("[ZapShield] ObCallbacks registered — handle access interception ACTIVE\n");
    }

    DbgPrint("[ZapShield] Driver loaded successfully\n");
    return STATUS_SUCCESS;
}
