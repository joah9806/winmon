@echo off
setlocal
cd /d "%~dp0"
title WinMon Agent Launcher
rem Do NOT use "chcp 65001" here: Windows 7 cmd.exe re-reads the batch file with
rem the new codepage and can lose its position, silently aborting the script.
rem All launcher output is ASCII; agent.js writes the Chinese log itself.

call pick-node.bat
if errorlevel 1 exit /b 1

echo [1/3] Checking Node runtime: %WINMON_NODE%
"%WINMON_NODE%" -v >nul 2>&1
if errorlevel 1 goto :runtime_fail

echo [2/3] Starting Agent in background (no console window)...
wscript //b agent-hidden.vbs

echo [3/3] Verifying the Agent is reporting to the server...
set /a TRIES=0
:wait_loop
"%WINMON_NODE%" agent.js --status >nul 2>&1
if not errorlevel 1 goto :ok
set /a TRIES+=1
if %TRIES% GEQ 15 goto :start_fail
timeout /t 2 >nul 2>&1
goto :wait_loop

:ok
echo.
"%WINMON_NODE%" agent.js --status
echo.
echo The Agent is running in the background. You can CLOSE THIS WINDOW now.
echo It keeps reporting with no window open, and survives closing this console.
echo Stop it with: agent-stop.bat
echo Log: data\agent.log  (read-only folder: %%LOCALAPPDATA%%\WinMon\data\agent.log)
echo This window closes in 8 seconds...
timeout /t 8 >nul 2>&1
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

:start_fail
echo.
echo ============================================================
echo  ERROR: the Agent is not reporting successfully.
echo ============================================================
"%WINMON_NODE%" agent.js --status
echo.
echo Starting in FOREGROUND so the error stays on screen.
echo Check agent.server_url in config.json points at the server,
echo and that agent.token matches the server token (if set).
echo.
"%WINMON_NODE%" agent.js
echo.
echo Log: data\agent.log  (read-only folder: %%LOCALAPPDATA%%\WinMon\data\agent.log)
pause
exit /b 1