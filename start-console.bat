@echo off
chcp 65001 >nul
cd /d "%~dp0"
call pick-node.bat
title WinMon Server (console)
echo Starting WinMon in foreground (Ctrl+C or close window to stop)...
echo Runtime: %WINMON_NODE%
echo.
"%WINMON_NODE%" server.js
pause