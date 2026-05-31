@echo off
setlocal
chcp 65001 >nul

cd /d "%~dp0"

echo.
echo ========================================
echo  Short Video Downloader - Windows Build
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm.cmd is not available in PATH.
  pause
  exit /b 1
)

echo [1/4] Installing dependencies...
call npm.cmd install
if errorlevel 1 goto failed

echo.
echo [2/4] Installing packager...
call npm.cmd install --save-dev electron-builder
if errorlevel 1 goto failed

echo.
echo [3/4] Checking source files...
call npm.cmd run lint
if errorlevel 1 goto failed

echo.
echo [4/4] Building single portable exe...
call npm.cmd run build:win
if errorlevel 1 goto failed

echo.
echo ========================================
echo  Build finished.
echo  Output folder: %cd%\release
echo ========================================
echo.
pause
exit /b 0

:failed
echo.
echo ========================================
echo  Build failed. Check the error above.
echo ========================================
echo.
pause
exit /b 1
