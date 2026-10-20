@echo off
REM =====================================================
REM  DEBUG launcher — window WAJIB tetap terbuka apapun terjadi.
REM =====================================================
title WA Scheduler DEBUG

cd /d "%~dp0"

echo ============================================
echo   DEBUG LAUNCHER
echo   Folder: %CD%
echo ============================================
echo.

echo [1/4] Cek Node.js...
where node
if errorlevel 1 (
    echo.
    echo ^>^>^> Node.js TIDAK ditemukan di PATH.
    echo     Install LTS dari https://nodejs.org lalu buka ulang folder ini.
    echo.
    goto :end
)
node -v
echo.

echo [2/4] Cek package.json...
if not exist "package.json" (
    echo ^>^>^> package.json TIDAK ada di folder ini.
    echo     Kamu jalankan bat ini di folder yang salah?
    echo.
    goto :end
)
echo package.json OK.
echo.

echo [3/4] Cek node_modules...
if not exist "node_modules\" (
    echo node_modules belum ada, jalankan: npm install
    call npm install
    if errorlevel 1 (
        echo.
        echo ^>^>^> npm install GAGAL.
        goto :end
    )
) else (
    echo node_modules OK.
)
echo.

echo [4/4] Jalankan bot...
echo ============================================
echo.
node index.js
echo.
echo ============================================
echo   Node exit code: %errorlevel%
echo ============================================

:end
echo.
echo (Tekan tombol apa saja untuk menutup jendela.)
pause >nul
