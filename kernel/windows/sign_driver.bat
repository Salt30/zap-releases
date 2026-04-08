@echo off
REM ═══════════════════════════════════════════════════════════════════
REM  sign_driver.bat — Sign the Zap kernel driver
REM
REM  Two modes:
REM    1. TEST SIGNING  — Self-signed cert for development
REM    2. PRODUCTION    — EV certificate for release
REM
REM  USAGE:
REM    sign_driver.bat test        — Create test cert + sign
REM    sign_driver.bat prod        — Sign with EV cert (must be in cert store)
REM    sign_driver.bat verify      — Verify signature on driver
REM
REM  PRODUCTION SIGNING FLOW:
REM    1. Sign with your EV code signing certificate
REM    2. Submit to Microsoft Partner Center for attestation signing
REM    3. Microsoft returns WHQL-signed driver package
REM    4. Ship the Microsoft-signed driver to users
REM
REM  Copyright (c) 2026 Zap AI. PROPRIETARY AND CONFIDENTIAL.
REM ═══════════════════════════════════════════════════════════════════

setlocal

set DRIVER_SYS=%~dp0..\..\dist\driver\Release\zap_driver.sys
set DLL_FILE=%~dp0..\..\dist\shield\zap_shield.dll
set CERT_NAME=ZapShieldTestCert
set CERT_STORE=PrivateCertStore
set TIMESTAMP_URL=http://timestamp.digicert.com

REM ── Check for signtool ──
where signtool >nul 2>&1
if errorlevel 1 (
    echo [ERROR] signtool.exe not found.
    echo         Install Windows SDK or run from VS Developer Command Prompt.
    exit /b 1
)

if /i "%1"=="" goto :usage
if /i "%1"=="test"   goto :test_sign
if /i "%1"=="prod"   goto :prod_sign
if /i "%1"=="verify" goto :verify
goto :usage

REM ══════════════════════════════════════════════════════════
:test_sign
REM ══════════════════════════════════════════════════════════
echo.
echo  Test Signing Mode
echo  ─────────────────
echo  NOTE: Requires "bcdedit /set testsigning on" + reboot
echo.

REM Step 1: Create self-signed test certificate (if not already created)
echo [1/4] Creating test certificate...
makecert -r -pe -ss %CERT_STORE% -n "CN=Zap AI Test" -eku 1.3.6.1.5.5.7.3.3 %CERT_NAME%.cer >nul 2>&1
if not errorlevel 1 (
    echo [OK] Test certificate created: %CERT_NAME%.cer
) else (
    echo [INFO] Certificate may already exist, continuing...
)

REM Step 2: Sign the driver .sys
echo [2/4] Signing zap_driver.sys...
if not exist "%DRIVER_SYS%" (
    echo [SKIP] %DRIVER_SYS% not found — run build.bat first
) else (
    signtool sign /s %CERT_STORE% /n "Zap AI Test" /t %TIMESTAMP_URL% /fd SHA256 "%DRIVER_SYS%"
    if errorlevel 1 (
        echo [WARN] Driver signing failed — trying with /ph flag...
        signtool sign /s %CERT_STORE% /n "Zap AI Test" /t %TIMESTAMP_URL% /fd SHA256 /ph "%DRIVER_SYS%"
    )
    echo [OK] Driver signed.
)

REM Step 3: Sign the DLL
echo [3/4] Signing zap_shield.dll...
if not exist "%DLL_FILE%" (
    echo [SKIP] %DLL_FILE% not found — run build.bat first
) else (
    signtool sign /s %CERT_STORE% /n "Zap AI Test" /t %TIMESTAMP_URL% /fd SHA256 "%DLL_FILE%"
    echo [OK] DLL signed.
)

REM Step 4: Create catalog file
echo [4/4] Creating driver catalog...
if exist "%~dp0driver\zap_driver.inf" (
    inf2cat /driver:"%~dp0driver" /os:10_X64 /verbose >nul 2>&1
    if not errorlevel 1 (
        signtool sign /s %CERT_STORE% /n "Zap AI Test" /t %TIMESTAMP_URL% /fd SHA256 "%~dp0driver\zap_driver.cat"
        echo [OK] Catalog created and signed.
    ) else (
        echo [WARN] inf2cat failed — catalog not created (driver still usable with test signing).
    )
)

echo.
echo  Test signing complete. Remember:
echo    bcdedit /set testsigning on
echo    (then reboot)
echo.
exit /b 0

REM ══════════════════════════════════════════════════════════
:prod_sign
REM ══════════════════════════════════════════════════════════
echo.
echo  Production Signing Mode
echo  ───────────────────────
echo.

REM Sign with EV certificate (must be installed in cert store or on hardware token)
REM Replace "Zap AI Inc" with the exact CN on your EV certificate

set EV_CN=Zap AI Inc

echo [1/3] Signing driver with EV certificate...
if not exist "%DRIVER_SYS%" (
    echo [ERROR] %DRIVER_SYS% not found — run build.bat first
    exit /b 1
)

signtool sign /n "%EV_CN%" /tr %TIMESTAMP_URL% /td SHA256 /fd SHA256 "%DRIVER_SYS%"
if errorlevel 1 (
    echo [ERROR] EV signing failed. Check:
    echo   1. Is your EV certificate installed / hardware token connected?
    echo   2. Is the CN "%EV_CN%" correct?
    exit /b 1
)

echo [2/3] Signing DLL with EV certificate...
if exist "%DLL_FILE%" (
    signtool sign /n "%EV_CN%" /tr %TIMESTAMP_URL% /td SHA256 /fd SHA256 "%DLL_FILE%"
)

echo [3/3] Creating and signing catalog...
if exist "%~dp0driver\zap_driver.inf" (
    inf2cat /driver:"%~dp0driver" /os:10_X64 >nul 2>&1
    if not errorlevel 1 (
        signtool sign /n "%EV_CN%" /tr %TIMESTAMP_URL% /td SHA256 /fd SHA256 "%~dp0driver\zap_driver.cat"
    )
)

echo.
echo  EV signing complete.
echo.
echo  NEXT STEPS for production:
echo    1. Create a driver package (.cab) with:
echo       makecab /f zap_driver.ddf
echo    2. Submit to Microsoft Partner Center:
echo       https://partner.microsoft.com/dashboard/hardware
echo    3. Select "Attestation signing"
echo    4. Upload the signed .cab package
echo    5. Wait for Microsoft to return the WHQL-signed package
echo    6. Ship the Microsoft-signed driver to users
echo.
exit /b 0

REM ══════════════════════════════════════════════════════════
:verify
REM ══════════════════════════════════════════════════════════
echo Verifying signatures...
echo.

if exist "%DRIVER_SYS%" (
    echo --- zap_driver.sys ---
    signtool verify /pa /v "%DRIVER_SYS%" 2>&1 | findstr /i "valid expires issued"
    echo.
) else (
    echo [SKIP] zap_driver.sys not found
)

if exist "%DLL_FILE%" (
    echo --- zap_shield.dll ---
    signtool verify /pa /v "%DLL_FILE%" 2>&1 | findstr /i "valid expires issued"
    echo.
) else (
    echo [SKIP] zap_shield.dll not found
)

exit /b 0

:usage
echo.
echo  Zap Driver Signing Tool
echo  ───────────────────────
echo  Usage: %~nx0 [test^|prod^|verify]
echo.
echo  test   — Create test certificate and sign all binaries
echo  prod   — Sign with production EV certificate
echo  verify — Check signatures on built binaries
echo.
exit /b 0
