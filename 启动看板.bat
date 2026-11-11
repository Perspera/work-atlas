@echo off
rem ============================================================
rem  Operations dashboard launcher
rem  NOTE: this file is intentionally ASCII-only with CRLF line
rem  endings. cmd.exe mis-parses UTF-8 / LF-only batch files and
rem  silently skips commands (that is why the page showed
rem  "cannot connect" - the server was never started).
rem ============================================================
setlocal
chcp 65001 >nul
set PYTHONUTF8=1
title Operations Dashboard
cd /d "%~dp0"

set "PY=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not exist "%PY%" set "PY=python.exe"

echo.
if exist "%~dp0banner.txt" (
    type "%~dp0banner.txt"
) else (
    echo  ==========================================================
    echo    Volume + Job Progress Dashboard
    echo    Local : http://127.0.0.1:8787
    echo    Keep this window open; close it to stop the service.
    echo  ==========================================================
)
echo.

rem ---- already serving? then just open the browser ----
powershell -NoProfile -Command "try{ $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 2; if($r.StatusCode -eq 200){exit 0}else{exit 1} }catch{ exit 1 }"
if "%ERRORLEVEL%"=="0" (
    echo  Service is already running. Opening browser...
    start "" "http://127.0.0.1:8787"
    timeout /t 2 >nul
    exit /b 0
)

rem ---- web_dir points at a missing build? tell the user how to fix it ----
powershell -NoProfile -Command "try{ $c = Get-Content -Raw -LiteralPath '%~dp0config.json' | ConvertFrom-Json }catch{ exit 0 }; if(-not $c.web_dir){ exit 0 }; $p = Join-Path '%~dp0' (Join-Path $c.web_dir 'index.html'); if(-not (Test-Path -LiteralPath $p)){ Write-Host ('  [WARN] config.json web_dir = ' + $c.web_dir + ' but index.html was not found.'); Write-Host '  Fix: cd frontend; npm install; npm run build'; Write-Host ''; exit 1 } else { exit 0 }"
if "%ERRORLEVEL%"=="1" (
    echo.
    pause
    exit /b 1
)

echo  Starting service, browser will open automatically...
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-browser.ps1"

"%PY%" server.py
echo.
echo  [STOPPED] Service exited. Check data\server.log for details.
pause
