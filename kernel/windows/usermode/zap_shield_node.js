/**
 * zap_shield_node.js — Usermode bridge to the ZapShield kernel driver
 *
 * Communicates with the kernel driver via DeviceIoControl to:
 * - Check if driver is loaded (available())
 * - Activate stealth mode (stealthMode()) — protects our process from inspection
 * - Deactivate stealth mode (stealthOff())
 *
 * Falls back gracefully if driver is not installed — all functions return false.
 * This allows the app to run normally without the driver (just without kernel protection).
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DEVICE_PATH = '\\\\\\\\.\\\\ZapShield';

// IOCTL codes (must match driver — CTL_CODE(FILE_DEVICE_UNKNOWN, 0x800+, METHOD_BUFFERED, FILE_ANY_ACCESS))
const IOCTL_ZAP_SET_PID      = 0x222000;
const IOCTL_ZAP_STEALTH_ON   = 0x222004;
const IOCTL_ZAP_STEALTH_OFF  = 0x222008;
const IOCTL_ZAP_IS_AVAILABLE = 0x22200C;

/**
 * Send an IOCTL to the kernel driver via PowerShell
 * (Avoids native addon compilation — works on any Windows without build tools)
 */
function sendIoctl(ioctlCode, inputValue) {
  try {
    const ps = `$ErrorActionPreference='Stop';` +
      `$h=[System.IO.File]::Open('${DEVICE_PATH}','Open','ReadWrite','None');` +
      `$fs=$h.SafeFileHandle;` +
      `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;` +
      `public class ZI{[DllImport("kernel32.dll",SetLastError=true)]` +
      `public static extern bool DeviceIoControl(IntPtr h,uint code,byte[] i,uint il,byte[] o,uint ol,out uint r,IntPtr ov);}';` +
      `$in=[BitConverter]::GetBytes([uint32]${inputValue});` +
      `$out=New-Object byte[] 4;$r=[uint32]0;` +
      `$ok=[ZI]::DeviceIoControl($fs.DangerousGetHandle(),${ioctlCode},$in,$in.Length,$out,$out.Length,[ref]$r,[IntPtr]::Zero);` +
      `$h.Close();if($ok){'1'}else{'0'}`;
    const result = execSync(
      `powershell -WindowStyle Hidden -Command "${ps}"`,
      { timeout: 5000, windowsHide: true, encoding: 'utf8' }
    ).trim();
    return result === '1';
  } catch (_) {
    return false;
  }
}

/**
 * Check if the kernel driver is loaded and accessible
 */
function available() {
  if (process.platform !== 'win32') return false;
  try {
    const result = execSync(
      `powershell -WindowStyle Hidden -Command "Test-Path '${DEVICE_PATH}'"`,
      { timeout: 3000, windowsHide: true, encoding: 'utf8' }
    ).trim();
    return result === 'True';
  } catch (_) {
    return false;
  }
}

/**
 * Activate kernel-level stealth — strips all dangerous access from external handles
 */
function stealthMode() {
  if (!available()) return false;
  return sendIoctl(IOCTL_ZAP_STEALTH_ON, process.pid);
}

/**
 * Deactivate kernel-level stealth
 */
function stealthOff() {
  if (!available()) return false;
  return sendIoctl(IOCTL_ZAP_STEALTH_OFF, 0);
}

/**
 * Set the PID to protect
 */
function setProtectedPid(pid) {
  if (!available()) return false;
  return sendIoctl(IOCTL_ZAP_SET_PID, pid);
}

/**
 * Install the driver (requires admin privileges)
 */
function installDriver() {
  if (process.platform !== 'win32') return false;
  try {
    const driverPath = path.join(__dirname, '..', 'driver', 'zap_shield.sys');
    if (!fs.existsSync(driverPath)) return false;
    execSync(`sc create ZapShield type=kernel binPath="${driverPath}" start=auto 2>nul`, { timeout: 5000, windowsHide: true });
    execSync('sc start ZapShield 2>nul', { timeout: 5000, windowsHide: true });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { available, stealthMode, stealthOff, setProtectedPid, installDriver };
