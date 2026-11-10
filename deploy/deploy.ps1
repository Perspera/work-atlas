# 单量与作业进度看板：一键发布脚本（Windows 本地执行）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1 -Keep 3
#
# 做的事：
#   1. 本地打包（排除 .git / 缓存 / 运行数据）
#   2. 上传到 releases/<时间戳>/，data 指向 shared/data
#   3. 原子切换 current 软链并重启服务
#   4. 健康检查失败自动切回上一个版本
#   5. 只保留最近 N 个版本
#
# 注意：本文件必须保持 UTF-8 with BOM，否则 PowerShell 5 会按 ANSI 解析中文而报错。

param(
    [string]$Target = 'root@8.163.57.96',
    [string]$AppDir = '/opt/work-atlas',
    [string]$Service = 'work-atlas',
    [int]$Port = 18082,
    [int]$Keep = 5
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$localTgz = Join-Path $env:TEMP "wa-release-$stamp.tgz"
$localSh = Join-Path $env:TEMP "wa-release-$stamp.sh"
$remoteTgz = "/tmp/wa-release-$stamp.tgz"
$remoteSh = "/tmp/wa-deploy-$stamp.sh"

Write-Host "== 1/4 构建前端并打包 ==" -ForegroundColor Cyan

# React 前端产物（web/dist）由本地构建产生，线上不装 Node
& npm --prefix (Join-Path $repo 'frontend') run build
if ($LASTEXITCODE -ne 0) { throw '前端构建失败（npm run build）' }

if (Test-Path $localTgz) { Remove-Item $localTgz -Force }
& tar -czf $localTgz `
    --exclude='./.git' `
    --exclude='./.trae' `
    --exclude='./.trae-html-share-packages' `
    --exclude='./data' `
    --exclude='./__pycache__' `
    --exclude='./tools/__pycache__' `
    --exclude='./frontend/node_modules' `
    -C $repo .
if ($LASTEXITCODE -ne 0) { throw '打包失败' }
Write-Host ("  已生成 {0:N1} MB" -f ((Get-Item $localTgz).Length / 1MB))

Write-Host "== 2/4 上传 ==" -ForegroundColor Cyan
& scp -o BatchMode=yes -o StrictHostKeyChecking=no $localTgz "${Target}:$remoteTgz"
if ($LASTEXITCODE -ne 0) { throw '上传失败' }

$remote = @'
set -u
APP=__APPDIR__
REL=$APP/releases/__STAMP__
PORT=__PORT__
SVC=__SERVICE__
KEEP=__KEEP__
TGZ=__TGZ__

# 首次迁移：把原来散在 APP/data 的运行数据收拢到 shared/data
if [ ! -f "$APP/shared/data/dashboard.db" ]; then
    echo "  首次迁移：整理 shared/data"
    systemctl stop "$SVC" 2>/dev/null || true
    mkdir -p "$APP/shared/data"
    if [ -d "$APP/data" ]; then
        for f in "$APP"/data/*; do
            [ -e "$f" ] || continue
            mv "$f" "$APP/shared/data/" 2>/dev/null || true
        done
        rmdir "$APP/data" 2>/dev/null || true
    fi
fi

# 让 systemd 指向 current
UNIT=/etc/systemd/system/$SVC.service
if [ -f "$UNIT" ]; then
    sed -i "s#^WorkingDirectory=.*#WorkingDirectory=$APP/current#" "$UNIT"
    sed -i "s#^ExecStart=.*#ExecStart=/usr/bin/python3.11 $APP/current/server.py#" "$UNIT"
    systemctl daemon-reload
fi

mkdir -p "$REL"
tar -xzf "$TGZ" -C "$REL"
ln -sfn "$APP/shared/data" "$REL/data"

PREV=$(readlink -f "$APP/current" 2>/dev/null || true)
ln -sfn "$REL" "$APP/current"
systemctl restart "$SVC"

OK=0
for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then OK=1; break; fi
    sleep 1
done

if [ "$OK" != "1" ]; then
    echo "  健康检查失败，回滚到 ${PREV:-无}"
    if [ -n "$PREV" ] && [ -d "$PREV" ]; then
        ln -sfn "$PREV" "$APP/current"
        systemctl restart "$SVC"
    fi
    tail -20 /var/log/work-atlas.log 2>/dev/null
    rm -f "$TGZ"
    exit 1
fi

CUR=$(readlink -f "$APP/current")
cd "$APP/releases" || exit 1
ls -1dt */ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r d; do
    full="$APP/releases/${d%/}"
    [ "$full" = "$CUR" ] && continue
    rm -rf "$full"
done

rm -f "$TGZ"
echo "  当前版本：$CUR"
echo "  保留版本："
ls -1dt "$APP"/releases/*/ 2>/dev/null | head -n "$KEEP" | sed "s#^#    #"
echo -n "  健康检查："
curl -s "http://127.0.0.1:$PORT/api/health"
echo
exit 0
'@

$remote = $remote.Replace('__APPDIR__', $AppDir)
$remote = $remote.Replace('__STAMP__', $stamp)
$remote = $remote.Replace('__PORT__', [string]$Port)
$remote = $remote.Replace('__SERVICE__', $Service)
$remote = $remote.Replace('__KEEP__', [string]$Keep)
$remote = $remote.Replace('__TGZ__', $remoteTgz)
$remote = $remote -replace "`r`n", "`n"

# 以 LF + UTF-8(无 BOM) 写远程脚本，避免 bash 解析到 \r
[System.IO.File]::WriteAllText($localSh, $remote, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "== 3/4 上传部署脚本 ==" -ForegroundColor Cyan
& scp -o BatchMode=yes -o StrictHostKeyChecking=no $localSh "${Target}:$remoteSh"
if ($LASTEXITCODE -ne 0) { throw '上传部署脚本失败' }

Write-Host "== 4/4 切换与校验 ==" -ForegroundColor Cyan
& ssh -o BatchMode=yes -o StrictHostKeyChecking=no $Target "bash $remoteSh; rm -f $remoteSh"
$code = $LASTEXITCODE

Remove-Item $localTgz, $localSh -Force -ErrorAction SilentlyContinue
if ($code -ne 0) { throw "发布失败（退出码 $code），已尝试回滚" }

Write-Host ''
Write-Host "发布完成：http://8.163.57.96:18081" -ForegroundColor Green
Write-Host "回滚：ssh $Target 'ln -sfn $AppDir/releases/<上一版本> $AppDir/current && systemctl restart $Service'" -ForegroundColor DarkGray
