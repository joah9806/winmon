@echo off
setlocal
cd /d "%~dp0"
title WinMon Launcher
rem Do NOT use "chcp 65001" here: Windows 7 cmd.exe re-reads the batch file with
rem the new codepage and can lose its position, silently aborting the script.
rem All launcher output is ASCII; the Chinese report is written by preflight.js.

call pick-node.bat
if errorlevel 1 exit /b 1

echo [1/4] Checking Node runtime: %WINMON_NODE%
"%WINMON_NODE%" -v >nul 2>&1
if errorlevel 1 goto :runtime_fail

echo [2/4] Running preflight checks...
echo.
"%WINMON_NODE%" preflight.js --quick
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="2" goto :already
if not "%RC%"=="0" goto :preflight_fail

echo [3/4] Starting WinMon in background (no console window)...
wscript //b start-hidden.vbs

echo [4/4] Verifying the service is answering...
"%WINMON_NODE%" preflight.js --wait=25
if errorlevel 1 goto :start_fail

for /f "delims=" %%U in ('""%WINMON_NODE%" preflight.js --url"') do set "WINMON_URL=%%U"
echo.
echo WinMon is running. Web UI: %WINMON_URL%
echo Stop: stop.bat or the web UI button. Log: data\server.log
echo This window closes in 5 seconds...
timeout /t 5 >nul 2>&1
exit /b 0

:already
echo WinMon is already running. Opening the web UI.
for /f "delims=" %%U in ('""%WINMON_NODE%" preflight.js --url"') do set "WINMON_URL=%%U"
start "" "%WINMON_URL%"
timeout /t 5 >nul 2>&1
exit /b 0

:runtime_fail
echo.
echo ============================================================
echo  ERROR: the bundled Node runtime could not be executed.
echo  Runtime: %WINMON_NODE%
echo.
echo  Most likely causes on Windows 7:
echo   - Windows 7 without Service Pack 1 (SP1 is required)
echo   - 32-bit Windows: runtime\node-x86.exe must be present
echo   - antivirus blocked node.exe, or the zip was not fully extracted
echo   - the download mark: right-click the zip - Properties - Unblock
echo ============================================================
echo.
pause
exit /b 1

:preflight_fail
echo ============================================================
echo  ERROR: preflight found a blocking problem (see [FAIL] above).
echo  Running the full diagnostic, this can take a moment...
echo ============================================================
echo.
"%WINMON_NODE%" preflight.js --full
echo.
echo A Chinese report has been written to data\diagnose.txt
if exist data\diagnose.txt start "" notepad.exe "data\diagnose.txt"
pause
exit /b 1

:start_fail
echo.
echo ============================================================
echo  ERROR: the service did not come up in the background.
echo  Restarting in FOREGROUND so the error stays on screen.
echo  Keep this window open and read the last lines.
echo ============================================================
echo.
"%WINMON_NODE%" server.js
echo.
echo The server exited. Producing a full diagnostic report...
"%WINMON_NODE%" preflight.js --full
if exist data\diagnose.txt start "" notepad.exe "data\diagnose.txt"
pause
exit /b 1