@echo off
chcp 65001 >nul
cd /d "%~dp0"
call pick-node.bat
title WinMon Agent
echo Starting WinMon Agent, reporting local metrics to the server...
echo Edit agent.server_url in config.json to change the target server.
echo Runtime: %WINMON_NODE%
echo.
"%WINMON_NODE%" agent.js
pause