@echo off
setlocal
REM Double-click on Windows to start Meridian (Hub, Interface, Monitor).
REM Three console windows will open. Close them to stop the services.
REM Paths relative to this script; repo root = ..\..\..

set "ROOT=%~dp0..\..\.."
cd /d "%ROOT%"

if not exist "package.json" (
  echo Meridian package.json not found. Keep user_scripts\install_Meridian\ structure.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo npm not found. Install Node.js from https://nodejs.org
  pause
  exit /b 1
)

echo Starting Meridian...
start "Meridian Hub" cmd /k "cd /d "%ROOT%" && npm run start:hub"
start "Meridian Interface" cmd /k "cd /d "%ROOT%" && npm run start:interface"
start "Meridian Monitor" cmd /k "cd /d "%ROOT%" && npm run start:monitor"

echo Three windows opened (Hub, Interface, Monitor). Close those windows to stop.
pause
