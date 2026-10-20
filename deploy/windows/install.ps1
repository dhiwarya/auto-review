# Starts Auto Reviewer at logon (Windows Task Scheduler).
# Run from the project folder in PowerShell:
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -Remove

param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$TaskName = 'Auto Reviewer'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed $TaskName"
  exit 0
}

$Dir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Node = (Get-Command node).Source
New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'data') | Out-Null

$Action = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument "/c `"`"$Node`" src\index.ts >> data\reviewer.log 2>&1`"" `
  -WorkingDirectory $Dir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed '$TaskName'. Logs: $Dir\data\reviewer.log"
