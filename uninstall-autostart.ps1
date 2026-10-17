# Removes the automatic start. The app then runs only while start.bat's window is open.
Stop-ScheduledTask -TaskName "HASANS TEAM Worker" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "HASANS TEAM Worker" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Autostart removed. If the app is still running, close it from Task Manager (node.exe) or restart."
