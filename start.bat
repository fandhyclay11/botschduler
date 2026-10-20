@echo off
REM =====================================================
REM  WA Scheduler — Launcher (Fase A + B + C)
REM  Cara pakai: double-click file ini.
REM
REM  Kalau window langsung tertutup, pakai debug.bat.
REM =====================================================

setlocal
cd /d "%~dp0"
title WA Scheduler

echo ============================================
echo   WA SCHEDULER - LAUNCHER
echo   Folder: %CD%
echo ============================================
echo.

REM --- Cek Node.js ---
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js tidak ditemukan.
    echo Install dari https://nodejs.org/ ^(LTS^) lalu jalankan lagi.
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo Node.js: %NODEVER%
echo.

REM --- Install deps kalau belum ada ---
if not exist "node_modules" (
    echo [INFO] node_modules belum ada, menjalankan npm install...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install gagal.
        pause
        exit /b 1
    )
    echo.
)

REM --- Jalankan bot ---
echo ============================================
echo   Menjalankan bot... ^(Ctrl+C untuk berhenti^)
echo ============================================
echo.

node index.js

echo.
echo ============================================
echo   Bot berhenti. Exit code: %errorlevel%
echo ============================================
pause
endlocal
