param(
  [string]$TaskName = "WMS-Daily-Download",
  [string]$Mode = "",
  [string]$Times = "",
  [int]$IntervalMinutes = 0,
  [string]$StartTime = "",
  [string]$EndTime = "",
  [string]$Config = ""
)
$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$bat = Join-Path $scriptDir "run_wms_download.bat"
$vbs = Join-Path $scriptDir "run_wms_download.vbs"
if (-not (Test-Path $bat)) { throw "Missing $bat" }
if (-not (Test-Path $vbs)) { throw "Missing $vbs" }

$configPath = if ($Config) { $Config } else { Join-Path $scriptDir "wms.config.json" }
$config = $null
if (Test-Path $configPath) {
  try { $config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $config = $null }
}
$schedule = if ($config -and $config.schedule) { $config.schedule } else { $null }

if (-not $Mode) { $Mode = if ($schedule -and $schedule.mode) { [string]$schedule.mode } else { "daily" } }
if (-not $Times -and $schedule -and $schedule.times) { $Times = ($schedule.times -join ",") }
if (-not $IntervalMinutes -and $schedule -and $schedule.intervalMinutes) { $IntervalMinutes = [int]$schedule.intervalMinutes }
if (-not $StartTime -and $schedule -and $schedule.startTime) { $StartTime = [string]$schedule.startTime }
if (-not $EndTime -and $schedule -and $schedule.endTime) { $EndTime = [string]$schedule.endTime }
if (-not $Times) { $Times = "08:30" }
if (-not $StartTime) { $StartTime = ($Times -split ",")[0].Trim() }
if ($IntervalMinutes -lt 1) { $IntervalMinutes = 60 }

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('//B "{0}"' -f $vbs)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -Hidden
$triggers = @()

if ($Mode -eq "interval") {
  if (-not $EndTime) { throw "interval 模式需要配置 schedule.endTime（例如 21:00）" }
  $startDt = [datetime]::ParseExact($StartTime, "HH:mm", $null)
  $endDt = [datetime]::ParseExact($EndTime, "HH:mm", $null)
  if ($endDt -le $startDt) { $endDt = $endDt.AddDays(1) }
  $span = $endDt - $startDt
  $duration = "{0:hh\:mm}" -f $span
  $taskRun = 'wscript.exe //B "' + $vbs + '"'
  Write-Host "Mode: daily window, every $IntervalMinutes minutes from $StartTime to $EndTime (duration $duration)"
  & schtasks.exe /Create /TN $TaskName /SC DAILY /ST $StartTime /RI $IntervalMinutes /DU $duration /TR $taskRun /F
  if ($LASTEXITCODE -ne 0) { throw "schtasks failed with exit code $LASTEXITCODE" }
  Write-Host "Installed. Test it with:"
  Write-Host "  schtasks /Run /TN `"$TaskName`""
  Write-Host "Logs: $(Join-Path $scriptDir 'logs\task.log')"
  return
} else {
  foreach ($item in ($Times -split ",")) {
    $t = $item.Trim()
    if (-not $t) { continue }
    [datetime]::ParseExact($t, "HH:mm", $null) | Out-Null
    $triggers += New-ScheduledTaskTrigger -Daily -At $t
    Write-Host "Mode: daily at $t"
  }
  if (-not $triggers) { throw "No valid times in -Times '$Times'" }
}

Write-Host "Registering task '$TaskName' (runs when the current user is logged on)..."
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings `
  -Description "WMS browser download: $Mode $Times interval=$IntervalMinutes" -Force | Out-Null
Write-Host "Installed. Test it with:"
Write-Host "  schtasks /Run /TN `"$TaskName`""
Write-Host "Logs: $(Join-Path $scriptDir 'logs\task.log')"
