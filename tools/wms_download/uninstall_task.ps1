param(
  [string]$TaskName = "WMS-Daily-Download"
)
$ErrorActionPreference = "Stop"
Write-Host "Removing scheduled task '$TaskName'..."
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Removed (if it existed)."
