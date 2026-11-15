@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WinMon Server
echo Starting WinMon monitoring server (browser opens automatically)...
echo Close this window or press Ctrl+C to stop.
echo.
runtime\node.exe server.js
pause