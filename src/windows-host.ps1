param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Target', 'Restore', 'Type')]
  [string]$Action,
  [string]$PlanPath = '',
  [UInt64]$WindowHandle = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class DripTypeWindowsHost {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public Int32 dx; public Int32 dy; public UInt32 mouseData; public UInt32 dwFlags;
    public UInt32 time; public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public UInt16 wVk; public UInt16 wScan; public UInt32 dwFlags;
    public UInt32 time; public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT { public UInt32 uMsg; public UInt16 wParamL; public UInt16 wParamH; }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public UInt32 type; public INPUTUNION U; }

  [DllImport("user32.dll", SetLastError = true)]
  static extern UInt32 SendInput(UInt32 nInputs, INPUT[] pInputs, Int32 cbSize);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern UInt32 GetWindowThreadProcessId(IntPtr hWnd, out UInt32 processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, Int32 nCmdShow);

  const UInt32 INPUT_KEYBOARD = 1;
  const UInt32 KEYEVENTF_KEYUP = 0x0002;
  const UInt32 KEYEVENTF_UNICODE = 0x0004;

  static void Send(UInt16 virtualKey, UInt16 scanCode, UInt32 flags) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.U.ki.wVk = virtualKey;
    input.U.ki.wScan = scanCode;
    input.U.ki.dwFlags = flags;
    INPUT[] inputs = new INPUT[] { input };
    if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
  }

  public static void UnicodeText(string value) {
    foreach (char unit in value.ToCharArray()) {
      Send(0, unit, KEYEVENTF_UNICODE);
      Send(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
    }
  }

  public static void Key(UInt16 virtualKey) {
    Send(virtualKey, 0, 0);
    Send(virtualKey, 0, KEYEVENTF_KEYUP);
  }
}
'@

if ($Action -eq 'Target') {
  $handle = [DripTypeWindowsHost]::GetForegroundWindow()
  if ($handle -eq [IntPtr]::Zero) { throw 'No foreground window is available.' }
  [UInt32]$processId = 0
  [void][DripTypeWindowsHost]::GetWindowThreadProcessId($handle, [ref]$processId)
  $process = Get-Process -Id $processId -ErrorAction Stop
  [pscustomobject]@{ name = $process.ProcessName; windowHandle = $handle.ToInt64().ToString() } |
    ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'Restore') {
  if ($WindowHandle -eq 0) { throw 'A valid destination window is required.' }
  $handle = [IntPtr]::new([Int64]$WindowHandle)
  [void][DripTypeWindowsHost]::ShowWindowAsync($handle, 9)
  if (-not [DripTypeWindowsHost]::SetForegroundWindow($handle)) {
    throw 'The destination window could not be focused.'
  }
  exit 0
}

if ([string]::IsNullOrWhiteSpace($PlanPath) -or -not (Test-Path -LiteralPath $PlanPath -PathType Leaf)) {
  throw 'A valid typing plan is required.'
}
$events = @(Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json)
if ($events.Count -gt 1000) { throw 'The typing plan is too large.' }

foreach ($event in $events) {
  $properties = @($event.PSObject.Properties.Name)
  if ($event.type -eq 'text' -and $properties.Count -eq 2 -and $properties -contains 'value') {
    $value = [string]$event.value
    if ([string]::IsNullOrEmpty($value) -or $value.Length -gt 2) { throw 'Invalid text event.' }
    [DripTypeWindowsHost]::UnicodeText($value)
  } elseif ($event.type -eq 'delay' -and $properties.Count -eq 2 -and $properties -contains 'ms') {
    $milliseconds = [int]$event.ms
    if ($milliseconds -lt 0 -or $milliseconds -gt 5000) { throw 'Invalid delay event.' }
    Start-Sleep -Milliseconds $milliseconds
  } elseif ($event.type -eq 'key' -and $properties.Count -eq 2 -and $properties -contains 'value') {
    $virtualKey = switch ([string]$event.value) {
      'backspace' { 0x08 }
      'enter' { 0x0D }
      'tab' { 0x09 }
      default { throw 'Invalid key event.' }
    }
    [DripTypeWindowsHost]::Key([UInt16]$virtualKey)
  } else {
    throw 'Invalid typing event.'
  }
}
