@echo off
rem WMS daily download launcher (ASCII only; keep CRLF line endings)
rem 1) 用已登录的 aTrust 会话打开 WMS，下载当天出库流程节点文件并交付到交付目录
rem 2) 无论下载成功与否，都把交付目录里的最新文件同步到看板服务器数据源目录
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=F:\APP\dev_env\Node.js\node.exe"
if not exist "%NODE%" set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node.exe"
if not exist "%~dp0logs" mkdir "%~dp0logs"
if not exist "%~dp0wms.config.json" (
    echo [ERROR] wms.config.json not found. Copy wms.config.example.json first.
    exit /b 2
)

echo [%DATE% %TIME%] ---- run start ---- >> "%~dp0logs\task.log"
"%NODE%" "%~dp0download_wms.js" --config "%~dp0wms.config.json" %* >> "%~dp0logs\task.log" 2>&1
set "CODE=%ERRORLEVEL%"
echo [%DATE% %TIME%] download exit=%CODE% >> "%~dp0logs\task.log"

rem 下载失败也要同步（文件可能是别的机器/人工放进交付目录的）
"%NODE%" "%~dp0sync_to_server.js" --config "%~dp0wms.config.json" >> "%~dp0logs\task.log" 2>&1
set "SYNC=%ERRORLEVEL%"
echo [%DATE% %TIME%] sync exit=%SYNC% >> "%~dp0logs\task.log"

rem 退出码反映下载结果：下载失败要能从任务计划/看板看出来（同步已尽力执行）
if "%CODE%"=="0" exit /b 0
exit /b %CODE%
