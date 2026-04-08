/*
 * driver_loader.js — Programmatic driver installer for Zap
 *
 * Called from Electron main process to install/start the kernel driver
 * when the user enables Lockdown Mode for the first time.
 *
 * Requires Administrator privileges — prompts UAC elevation via PowerShell.
 *
 * Copyright (c) 2026 Zap AI. PROPRIETARY AND CONFIDENTIAL.
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const SERVICE_NAME = 'ZapShield';
const DRIVER_FILE = 'zap_driver.sys';

/**
 * Find the driver .sys file. Checks:
 * 1. Next to the running executable (production)
 * 2. In resources directory (electron-builder extraResources)
 * 3. In the kernel build output (development)
 */
function findDriverPath() {
  const candidates = [
    path.join(path.dirname(process.execPath), DRIVER_FILE),
    path.join(process.resourcesPath || '', DRIVER_FILE),
    path.join(__dirname, '..', '..', 'dist', 'driver', 'Release', DRIVER_FILE),
    path.join(__dirname, 'driver', DRIVER_FILE),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Run a command with UAC elevation via PowerShell
 * Returns a Promise that resolves with { success, output, error }
 */
function runElevated(command, timeoutMs = 30000) {
  return new Promise((resolve) => {
    // Escape for PowerShell
    const escaped = command.replace(/"/g, '`"').replace(/'/g, "''");
    const psCmd = `powershell -Command "Start-Process cmd.exe -ArgumentList '/c ${escaped}' -Verb RunAs -Wait"`;

    const child = exec(psCmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, output: stdout, error: err.message || stderr });
      } else {
        resolve({ success: true, output: stdout, error: null });
      }
    });
  });
}

/**
 * Check if the driver service exists and is running
 */
function checkDriverStatus() {
  return new Promise((resolve) => {
    exec(`sc query ${SERVICE_NAME}`, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) {
        resolve({ installed: false, running: false });
        return;
      }
      const installed = stdout.includes(SERVICE_NAME);
      const running = stdout.includes('RUNNING');
      resolve({ installed, running });
    });
  });
}

/**
 * Install the kernel driver (requires admin)
 * Copies .sys to System32\drivers, creates service, starts it
 */
async function installDriver() {
  if (process.platform !== 'win32') {
    return { success: false, error: 'Kernel driver only available on Windows' };
  }

  const driverPath = findDriverPath();
  if (!driverPath) {
    return { success: false, error: 'Driver file not found' };
  }

  // Check if already installed and running
  const status = await checkDriverStatus();
  if (status.running) {
    return { success: true, error: null, alreadyRunning: true };
  }

  // Build the install commands
  const sysTarget = `%SystemRoot%\\System32\\drivers\\${DRIVER_FILE}`;
  const cmds = [
    `copy /y "${driverPath}" "${sysTarget}"`,
    status.installed
      ? `sc config ${SERVICE_NAME} binPath="${sysTarget}"`
      : `sc create ${SERVICE_NAME} type=kernel start=demand binPath="${sysTarget}" DisplayName="Zap Shield"`,
    `sc start ${SERVICE_NAME}`,
  ].join(' && ');

  const result = await runElevated(cmds);

  // Verify it's actually running now
  const postStatus = await checkDriverStatus();
  if (postStatus.running) {
    return { success: true, error: null };
  }

  return {
    success: false,
    error: result.error || 'Driver failed to start. Check Event Viewer for details. The driver must be signed.'
  };
}

/**
 * Uninstall the driver (requires admin)
 */
async function uninstallDriver() {
  if (process.platform !== 'win32') return { success: false, error: 'Not Windows' };

  const cmds = [
    `sc stop ${SERVICE_NAME}`,
    `timeout /t 2 /nobreak`,
    `sc delete ${SERVICE_NAME}`,
    `del /f "%SystemRoot%\\System32\\drivers\\${DRIVER_FILE}"`,
  ].join(' & '); // Use & not && so it continues even if stop fails

  const result = await runElevated(cmds);
  return { success: true, error: null };
}

module.exports = {
  findDriverPath,
  checkDriverStatus,
  installDriver,
  uninstallDriver,
  SERVICE_NAME,
};
