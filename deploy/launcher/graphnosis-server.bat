@echo off
setlocal enabledelayedexpansion
rem Graphnosis personal-server launcher (Windows). Double-click to start the
rem headless sidecar (browser UI on :3456) and open your browser to it.
rem
rem Config (optional): set these in the environment before running, or edit the
rem defaults below.
rem   GRAPHNOSIS_HOME, GRAPHNOSIS_CORTEX, GRAPHNOSIS_HTTP_UI_PORT,
rem   GRAPHNOSIS_HTTP_UI_TOKEN, GRAPHNOSIS_PASSPHRASE (required to unlock).

if "%GRAPHNOSIS_HTTP_UI_PORT%"=="" set "GRAPHNOSIS_HTTP_UI_PORT=3456"
if "%GRAPHNOSIS_STATE%"=="" set "GRAPHNOSIS_STATE=%USERPROFILE%\.graphnosis"
if "%GRAPHNOSIS_CORTEX%"=="" set "GRAPHNOSIS_CORTEX=%GRAPHNOSIS_STATE%\cortex"
if "%GRAPHNOSIS_HOME%"=="" (
  rem Default repo root = two levels above this script (deploy\launcher\..\..).
  for %%I in ("%~dp0..\..") do set "GRAPHNOSIS_HOME=%%~fI"
)
set "SIDECAR=%GRAPHNOSIS_HOME%\apps\desktop-sidecar\dist\index.js"

if not exist "%GRAPHNOSIS_STATE%" mkdir "%GRAPHNOSIS_STATE%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found in PATH. Install Node 20+ and try again.
  pause
  exit /b 1
)
if not exist "%SIDECAR%" (
  echo Sidecar not built at: %SIDECAR%
  echo Run "pnpm install ^&^& pnpm -r build" in the repo first, or set GRAPHNOSIS_HOME.
  pause
  exit /b 1
)

rem Access token: reuse persisted, else generate one.
set "TOKEN_FILE=%GRAPHNOSIS_STATE%\http-ui-token"
if not "%GRAPHNOSIS_HTTP_UI_TOKEN%"=="" (
  set "TOKEN=%GRAPHNOSIS_HTTP_UI_TOKEN%"
) else if exist "%TOKEN_FILE%" (
  set /p TOKEN=<"%TOKEN_FILE%"
) else (
  for /f "delims=" %%T in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set "TOKEN=%%T"
  >"%TOKEN_FILE%" echo|set /p="!TOKEN!"
)

set "URL=http://127.0.0.1:%GRAPHNOSIS_HTTP_UI_PORT%/?token=!TOKEN!"
set "LOG=%GRAPHNOSIS_STATE%\server.log"

if "%GRAPHNOSIS_PASSPHRASE%"=="" (
  echo Note: GRAPHNOSIS_PASSPHRASE is not set. The cortex can't unlock without it.
)

echo Starting Graphnosis server... (logs: %LOG%)
set "GRAPHNOSIS_HTTP_UI=1"
set "GRAPHNOSIS_HTTP_UI_TOKEN=!TOKEN!"
start "" /b node "%SIDECAR%" 1>>"%LOG%" 2>>&1

rem Give it a moment, then open the browser.
timeout /t 4 /nobreak >nul
start "" "!URL!"
echo Graphnosis is at: !URL!
echo To stop it, close the node process in Task Manager (node.exe running the sidecar).
endlocal
