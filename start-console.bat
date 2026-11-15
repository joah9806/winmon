@echo off
setlocal
cd /d "%~dp0"
title WinMon Server (console)
rem Foreground mode: every startup error stays visible in this window.
rem No "chcp 65001" - it breaks batch execution on Windows 7 cmd.exe.
call pick-node.bat
if errorlevel 1 exit /b 1
echo Starting WinMon in foreground (Ctrl+C or close window to stop)...
echo Runtime: %WINMON_NODE%
echo.
"%WINMON_NODE%" server.js
echo.
echo The server exited. Run diagnose.bat for a full report.
pause