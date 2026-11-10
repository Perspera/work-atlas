# 取消开机自启 + 删除防火墙规则
# 用法：右键 → 以管理员身份运行 PowerShell，然后执行本脚本

$ErrorActionPreference = 'Continue'
$taskName = '单量作业看板'
$ruleName = '单量作业看板 8787'

Write-Host '== 删除计划任务 ==' -ForegroundColor Cyan
schtasks /Delete /TN $taskName /F 2>$null
if ($LASTEXITCODE -eq 0) { Write-Host "  已删除：$taskName" } else { Write-Host '  计划任务不存在' }

Write-Host '== 删除防火墙规则 ==' -ForegroundColor Cyan
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host "  已处理：$ruleName"

Write-Host '完成（服务进程如仍在运行，可在任务管理器结束 python.exe）' -ForegroundColor Green
