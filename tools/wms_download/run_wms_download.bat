@echo off
rem WMS daily download launcher (ASCII only; keep CRLF line endings)
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=C:\Users\Administrator\node-v22.23.2-win-x64\node.exe"
if not exist "%NODE%" set "NODE=node.exe"
if not exist "%~dp0logs" mkdir "%~dp0logs"
if not exist "%~dp0wms.config.json" (
    echo [ERROR] wms.config.json not found. Copy wms.config.example.json first.
    exit /b 2
)
"%NODE%" "%~dp0download_wms.js" --config "%~dp0wms.config.json" %* >> "%~dp0logs\task.log" 2>&1
set "CODE=%ERRORLEVEL%"
echo [%DATE% %TIME%] exit=%CODE% >> "%~dp0logs\task.log"
exit /b %CODE%
