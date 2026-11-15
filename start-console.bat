@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WinMon Server (console)
echo Starting WinMon in foreground (Ctrl+C or close window to stop)...
echo.
runtime\node.exe server.js
pause