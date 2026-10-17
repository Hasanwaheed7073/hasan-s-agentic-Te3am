# Registers a Windows scheduled task that starts HASAN's TEAM (server + background worker) when you
# sign in, hidden, and restarts it if it crashes. Schedules then run without opening the app.
# Limitation: the PC must be on and you must be signed in to Windows; sleep pauses everything.
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source
$log = Join-Path $dir "data\worker.log"
New-Item -ItemType Directory -Force (Join-Path $dir "data") | Out-Null
$cmd = "Set-Location -LiteralPath '$dir'; & '$node' src/server.js *>> '$log'"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "HASANS TEAM Worker" -Action $action -Trigger $trigger -Settings $settings `
  -Description "Runs HASAN's TEAM background worker (tasks + schedules)" -Force | Out-Null
Write-Host "Installed. Starting it now..."
Start-ScheduledTask -TaskName "HASANS TEAM Worker"
Start-Sleep -Seconds 4
try { Invoke-WebRequest -UseBasicParsing http://localhost:4310/api/meta | Out-Null; Write-Host "Running at http://localhost:4310 (log: $log)" }
catch { Write-Host "Started, but the app did not answer yet. Check $log" }
