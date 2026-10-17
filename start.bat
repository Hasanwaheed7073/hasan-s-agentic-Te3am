@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
rem If the background worker is already running (autostart), just open the app.
netstat -ano | findstr /R /C:":4310 .*LISTENING" >nul
if %errorlevel%==0 (
  start "" http://localhost:4310
  exit /b
)
start "" http://localhost:4310
node src/server.js
