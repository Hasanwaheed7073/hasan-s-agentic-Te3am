@echo off
rem Opens a normal Google Chrome that HASAN's TEAM can connect to ("My Chrome" in Browser & accounts).
rem It uses its own Chrome profile (Chrome doesn't allow connections to your default profile).
rem Sign in to LinkedIn, Google, Indeed etc. here once, like any browser; logins are kept.
rem While this Chrome is open, programs on this PC can control it. Close it when the team isn't working.
set "PROFILE=%LOCALAPPDATA%\HasansTeamChrome"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo Google Chrome was not found. Install it from https://www.google.com/chrome/ and try again.
  pause
  exit /b 1
)
start "" "%CHROME%" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check
