@echo off
REM ═══════════════════════════════════════════════════════════════════
REM  build.bat — Build Zap kernel driver + user-mode DLL
REM
REM  USAGE:
REM    build.bat          (builds Release x64)
REM    build.bat debug    (builds Debug x64)
REM    build.bat clean    (removes build artifacts)
REM
REM  REQUIREMENTS:
REM    - Visual Studio 2022 with C++ Desktop workload
REM    - Windows Driver Kit (WDK) 10
REM    - Run from VS Developer Command Prompt (x64)
REM
REM  Copyright (c) 2026 Zap AI. PROPRIETARY AND CONFIDENTIAL.
REM ═══════════════════════════════════════════════════════════════════

setlocal enabledelayedexpansion

set CONFIG=Release
if /i "%1"=="debug" set CONFIG=Debug
if /i "%1"=="clean" goto :clean

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   Zap Shield — Build System              ║
echo  ║   Configuration: %CONFIG%                ║
echo  ╚══════════════════════════════════════════╝
echo.

REM ── Check for cl.exe (VS Developer environment) ──
where cl >nul 2>&1
if errorlevel 1 (
    echo [ERROR] cl.exe not found. Run this from a VS Developer Command Prompt.
    echo         Launch: "x64 Native Tools Command Prompt for VS 2022"
    exit /b 1
)

REM ── Output directories ──
set DIST_DIR=%~dp0..\..\dist\driver
set DIST_DLL=%~dp0..\..\dist\shield
if not exist "%DIST_DIR%\%CONFIG%" mkdir "%DIST_DIR%\%CONFIG%"
if not exist "%DIST_DLL%"          mkdir "%DIST_DLL%"

REM ══════════════════════════════════════════════════════════
REM  Step 1: Build kernel driver (.sys)
REM ══════════════════════════════════════════════════════════
echo [1/2] Building kernel driver (zap_driver.sys)...

REM Check if WDK MSBuild targets exist
if exist "%~dp0driver\zap_driver.vcxproj" (
    msbuild "%~dp0driver\zap_driver.vcxproj" /p:Configuration=%CONFIG% /p:Platform=x64 /v:minimal /nologo
    if errorlevel 1 (
        echo [FAILED] Kernel driver build failed.
        exit /b 1
    )
    echo [OK] zap_driver.sys built successfully.
) else (
    echo [SKIP] zap_driver.vcxproj not found — skipping driver build.
)

REM ══════════════════════════════════════════════════════════
REM  Step 2: Build user-mode DLL (zap_shield.dll)
REM ══════════════════════════════════════════════════════════
echo [2/2] Building user-mode DLL (zap_shield.dll)...

pushd "%~dp0usermode"

set CFLAGS=/O2 /W4 /WX /GS /sdl /DZAP_SHIELD_EXPORTS
if /i "%CONFIG%"=="Debug" set CFLAGS=/Od /W4 /WX /GS /sdl /Zi /DZAP_SHIELD_EXPORTS /D_DEBUG

cl /LD %CFLAGS% zap_shield.c /Fe:"%DIST_DLL%\zap_shield.dll" /link /DEF:zap_shield.def kernel32.lib user32.lib advapi32.lib

if errorlevel 1 (
    echo [FAILED] DLL build failed.
    popd
    exit /b 1
)

popd
echo [OK] zap_shield.dll built successfully.

REM ══════════════════════════════════════════════════════════
REM  Step 3: Build in-process overlay DLL (zap_overlay.dll)
REM ══════════════════════════════════════════════════════════
echo [3/3] Building overlay DLL (zap_overlay.dll)...

REM MinHook: expect vendored headers + lib under kernel\windows\vendor\minhook
set MH_INC=%~dp0vendor\minhook\include
set MH_LIB=%~dp0vendor\minhook\lib\libMinHook.x64.lib

if not exist "%MH_INC%\MinHook.h" (
    echo [SKIP] MinHook not found at %MH_INC% — skipping overlay build.
    echo         Drop MinHook headers + libMinHook.x64.lib under kernel\windows\vendor\minhook\
    goto :done
)

pushd "%~dp0overlay"

set OVLFLAGS=/O2 /EHsc /W4 /GS /sdl /DZAP_OVERLAY_EXPORTS
if /i "%CONFIG%"=="Debug" set OVLFLAGS=/Od /EHsc /W4 /GS /sdl /Zi /DZAP_OVERLAY_EXPORTS /D_DEBUG

cl /LD %OVLFLAGS% zap_overlay.cpp /I"%MH_INC%" ^
   /Fe:"%DIST_DLL%\zap_overlay.dll" ^
   /link /DEF:zap_overlay.def "%MH_LIB%" d3d11.lib dxgi.lib user32.lib kernel32.lib

if errorlevel 1 (
    echo [FAILED] Overlay DLL build failed.
    popd
    exit /b 1
)

popd
echo [OK] zap_overlay.dll built successfully.

:done
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   Build Complete!                        ║
echo  ║   Driver: dist\driver\%CONFIG%\zap_driver.sys
echo  ║   DLL:    dist\shield\zap_shield.dll     ║
echo  ╚══════════════════════════════════════════╝
echo.
exit /b 0

:clean
echo Cleaning build artifacts...
if exist "%~dp0..\..\dist\driver" rmdir /s /q "%~dp0..\..\dist\driver"
if exist "%~dp0..\..\dist\shield" rmdir /s /q "%~dp0..\..\dist\shield"
if exist "%~dp0driver\obj"        rmdir /s /q "%~dp0driver\obj"
if exist "%~dp0usermode\*.obj"    del /q "%~dp0usermode\*.obj"
if exist "%~dp0usermode\*.exp"    del /q "%~dp0usermode\*.exp"
if exist "%~dp0usermode\*.lib"    del /q "%~dp0usermode\*.lib"
if exist "%~dp0overlay\*.obj"     del /q "%~dp0overlay\*.obj"
if exist "%~dp0overlay\*.exp"     del /q "%~dp0overlay\*.exp"
if exist "%~dp0overlay\*.lib"     del /q "%~dp0overlay\*.lib"
echo [OK] Clean complete.
exit /b 0
