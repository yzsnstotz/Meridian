@echo off
setlocal EnableDelayedExpansion
REM Meridian auto-install: prompt for crucial settings, then npm install and create .env.
REM Run from Meridian repo root, e.g. after clone:
REM   cd Meridian && user_scripts\install_Meridian\windows_install\install.bat
REM Paths relative to this script; repo root = ..\..\..

set "ROOT=%~dp0..\..\.."
cd /d "%ROOT%"

if not exist "package.json" (
  echo Error: package.json not found. Run from Meridian repo with user_scripts\install_Meridian\ structure.
  pause
  exit /b 1
)
if not exist ".env.example" (
  echo Error: .env.example not found.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required. Install from https://nodejs.org
  pause
  exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
  echo npm is required.
  pause
  exit /b 1
)

echo === Meridian installer ===
echo Repository root: %ROOT%
echo.

echo --- Required ---
set /p "TELEGRAM_BOT_TOKEN=Telegram Bot Token (from @BotFather /newbot): "
if "!TELEGRAM_BOT_TOKEN!"=="" (
  echo Token is required.
  pause
  exit /b 1
)
if "!TELEGRAM_BOT_TOKEN!"=="123456789:replace_with_real_token" (
  echo Use the real token from @BotFather, not the placeholder.
  pause
  exit /b 1
)

set /p "ALLOWED_USER_IDS=Allowed Telegram User ID(s), comma-separated (e.g. from @userinfobot): "
if "!ALLOWED_USER_IDS!"=="" (
  echo At least one user ID is required.
  pause
  exit /b 1
)

echo.
echo --- Optional (press Enter for defaults) ---
set /p "TELEGRAM_BOT_TOKENS=Extra Telegram bot tokens, comma-separated [none]: "
set /p "NODE_ENV=NODE_ENV (development^|test^|production) [development]: "
if "!NODE_ENV!"=="" set "NODE_ENV=development"
set /p "LOG_LEVEL=LOG_LEVEL (trace^|debug^|info^|warn^|error^|fatal) [debug]: "
if "!LOG_LEVEL!"=="" set "LOG_LEVEL=debug"
set /p "AGENT_WORKDIR=AGENT_WORKDIR for /spawn [empty]: "

echo.
echo --- Installing dependencies ---
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

echo.
echo --- Creating .env ---
if exist ".env" (
  set /p "OVERWRITE=.env exists. Overwrite? (y/N): "
  if /i not "!OVERWRITE!"=="y" (
    echo Skipping .env. Edit .env manually.
    goto :done
  )
)

copy /y ".env.example" ".env" >nul
REM Replace first occurrence of TELEGRAM_BOT_TOKEN= and ALLOWED_USER_IDS= using PowerShell
powershell -NoProfile -Command "$c = Get-Content -Raw '.env'; $c = $c -replace '(?m)^TELEGRAM_BOT_TOKEN=.*', 'TELEGRAM_BOT_TOKEN=%TELEGRAM_BOT_TOKEN%'; $c = $c -replace '(?m)^ALLOWED_USER_IDS=.*', 'ALLOWED_USER_IDS=%ALLOWED_USER_IDS%'; $c = $c -replace '(?m)^NODE_ENV=.*', 'NODE_ENV=%NODE_ENV%'; $c = $c -replace '(?m)^LOG_LEVEL=.*', 'LOG_LEVEL=%LOG_LEVEL%'; $c = $c -replace '(?m)^AGENT_WORKDIR=.*', 'AGENT_WORKDIR=%AGENT_WORKDIR%'; $c = $c -replace '(?m)^TELEGRAM_BOT_TOKENS=.*', 'TELEGRAM_BOT_TOKENS=%TELEGRAM_BOT_TOKENS%'; Set-Content -Path '.env' -Value $c -NoNewline"
if errorlevel 1 (
  echo PowerShell replace failed. Edit .env and set TELEGRAM_BOT_TOKEN and ALLOWED_USER_IDS.
) else (
  echo Created .env
)

:done
echo.
echo === Install complete ===
echo.
echo Next steps:
echo   1. In Telegram @BotFather run /setcommands ^(see README for list^).
echo   2. Start Meridian: double-click user_scripts\install_Meridian\windows_install\meridian-start.bat
echo      Or run: npm run start:hub, start:interface, start:monitor in separate windows.
echo.
pause
