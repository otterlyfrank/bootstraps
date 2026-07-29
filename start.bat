@echo off
REM Bootstraps — double-click to start (Windows)
cd /d "%~dp0"
set PORT=8792
echo.
echo   Bootstraps - hunt / learn / climb
echo   Open: http://127.0.0.1:%PORT%
echo   Job fetch API included
echo   Stop: close this window or Ctrl+C
echo.
start "" "http://127.0.0.1:%PORT%/"
where python >NUL 2>&1
if %ERRORLEVEL%==0 (
  python scripts\bootstraps_server.py --host 127.0.0.1 --port %PORT%
) else (
  where py >NUL 2>&1
  if %ERRORLEVEL%==0 (
    py -3 scripts\bootstraps_server.py --host 127.0.0.1 --port %PORT%
  ) else (
    echo Python 3 not found. Install from https://www.python.org/downloads/
    echo Check "Add Python to PATH" during setup.
    pause
    exit /b 1
  )
)
