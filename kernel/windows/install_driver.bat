@echo off
REM ═══════════════════════════════════════════════════════════════════
REM  install_driver.bat — Install/Uninstall Zap kernel driver
REM
REM  USAGE (run as Administrator):
REM    install_driver.bat install     — Install and start the driver
REM    install_driver.bat uninstall   — Stop and remove the driver
REM    install_driver.bat status      — Check if driver is loaded
REM    install_driver.bat restart     — Stop then start
REM
REM  NOTE: The driver MUST be signed. Test signing requires:
REM    bcdedit /set testsigning on   (then reboot)
REM  Production requires EV cert + Microsoft attestation signing.
REM
REM  Copyright (c) 2026 Zap AI. PROPRIETARY AND CONFIDENTIAL.
REM ═══════════════════════════════════════════════════════════════════

setlocal

set SERVICE_NAME=ZapShield
set DISPLAY_NAME=Zap Shield Driver
set DRIVER_PATH=%~dp0..\..\dist\driver\Release\zap_driver.sys

REM ── Must be admin ──
net session >nul 2>&1
if errorlevel 1 (
    echo [ERROR] This script requires Administrator privileges.
    echo         Right-click and select "Run as administrator".
    exit /b 1
)

if /i "%1"=="" goto :usage
if /i "%1"=="install"   goto :install
if /i "%1"=="uninstall" goto :uninstall
if /i "%1"=="status"    goto :status
if /i "%1"=="restart"   goto :restart
goto :usage

REM ══════════════════════════════════════════════════════════
:install
REM ══════════════════════════════════════════════════════════
echo Installing %SERVICE_NAME%...

if not exist "%DRIVER_PATH%" (
    echo [ERROR] Driver not found: %DRIVER_PATH%
    echo         Run build.bat first.
    exit /b 1
)

REM Copy driver to System32\drivers (standard location)
copy /y "%DRIVER_PATH%" "%SystemRoot%\System32\drivers\zap_driver.sys" >nul
if errorlevel 1 (
    echo [ERROR] Failed to copy driver to System32\drivers
    exit /b 1
)

REM Create the kernel driver service
sc create %SERVICE_NAME% type=kernel start=demand binPath="%SystemRoot%\System32\drivers\zap_driver.sys" DisplayName="%DISPLAY_NAME%" >nul 2>&1
if errorlevel 1 (
    echo [WARN] Service may already exist, attempting to update...
    sc config %SERVICE_NAME% binPath="%SystemRoot%\System32\drivers\zap_driver.sys" >nul 2>&1
)

REM Start the driver
sc start %SERVICE_NAME% >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Failed to start driver. Check:
    echo   1. Is the driver properly signed?
    echo   2. Is test signing enabled? (bcdedit /set testsigning on)
    echo   3. Check Event Viewer for details.
    sc query %SERVICE_NAME%
    exit /b 1
)

echo [OK] %SERVICE_NAME% installed and started.
sc query %SERVICE_NAME% | findstr STATE
exit /b 0

REM ══════════════════════════════════════════════════════════
:uninstall
REM ══════════════════════════════════════════════════════════
echo Uninstalling %SERVICE_NAME%...

sc stop %SERVICE_NAME% >nul 2>&1
timeout /t 2 /nobreak >nul

sc delete %SERVICE_NAME% >nul 2>&1
if errorlevel 1 (
    echo [WARN] Could not delete service (may not exist).
) else (
    echo [OK] Service removed.
)

REM Remove driver binary
if exist "%SystemRoot%\System32\drivers\zap_driver.sys" (
    del /f "%SystemRoot%\System32\drivers\zap_driver.sys" >nul 2>&1
    echo [OK] Driver binary removed.
)

echo [OK] %SERVICE_NAME% uninstalled.
exit /b 0

REM ══════════════════════════════════════════════════════════
:status
REM ══════════════════════════════════════════════════════════
sc query %SERVICE_NAME% 2>nul | findstr STATE
if errorlevel 1 (
    echo [INFO] %SERVICE_NAME% is not installed.
)
exit /b 0

REM ══════════════════════════════════════════════════════════
:restart
REM ══════════════════════════════════════════════════════════
echo Restarting %SERVICE_NAME%...
sc stop %SERVICE_NAME% >nul 2>&1
timeout /t 2 /nobreak >nul
sc start %SERVICE_NAME% >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Failed to restart driver.
    exit /b 1
)
echo [OK] %SERVICE_NAME% restarted.
sc query %SERVICE_NAME% | findstr STATE
exit /b 0

:usage
echo.
echo  Zap Shield Driver Installer
echo  ───────────────────────────
echo  Usage: %~nx0 [install^|uninstall^|status^|restart]
echo.
echo  install   — Copy driver to System32\drivers, create service, start
echo  uninstall — Stop service, delete service, remove driver binary
echo  status    — Show current driver service state
echo  restart   — Stop and start the driver
echo.
echo  NOTE: Must be run as Administrator.
echo.
exit /b 0
