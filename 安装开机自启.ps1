# 注册开机自启 + 开放防火墙入站端口 8787
# 用法：右键 → 以管理员身份运行 PowerShell，然后执行本脚本
#   powershell -ExecutionPolicy Bypass -File "安装开机自启.ps1"

$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $base 'server.py'
$python = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
if (-not (Test-Path $python)) { $python = 'python.exe' }

$taskName = '单量作业看板'

Write-Host '== 1/3 注册登录自启任务 ==' -ForegroundColor Cyan
schtasks /Query /TN $taskName *> $null
if ($LASTEXITCODE -eq 0) {
    schtasks /Delete /TN $taskName /F | Out-Null
}
$action = "`"$python`" `"$server`""
schtasks /Create /TN $taskName /TR $action /SC ONLOGON /RL HIGHEST /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw '创建计划任务失败，请确认使用管理员权限运行' }
Write-Host "  已注册：$taskName"

Write-Host '== 2/3 开放防火墙 8787 端口（仅专用网络） ==' -ForegroundColor Cyan
$ruleName = '单量作业看板 8787'
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort 8787 `
    -Action Allow -Profile Private -Description '局域网访问单量与作业进度看板' | Out-Null
Write-Host "  已创建防火墙规则：$ruleName"

Write-Host '== 3/3 立即启动一次 ==' -ForegroundColor Cyan
Start-Process -FilePath $python -ArgumentList $server -WorkingDirectory $base -WindowStyle Minimized

$ips = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress
Write-Host ''
Write-Host '完成。可用地址：' -ForegroundColor Green
Write-Host "  本机：   http://127.0.0.1:8787"
foreach ($ip in $ips) { Write-Host "  局域网： http://${ip}:8787" }
Write-Host ''
Write-Host '取消自启：运行「卸载开机自启.ps1」'
