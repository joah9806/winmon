@echo off
setlocal
cd /d "%~dp0"
call pick-node.bat
if errorlevel 1 exit /b 1
title WinMon Agent
echo Starting WinMon Agent in the FOREGROUND, reporting metrics to the server...
echo Edit agent.server_url in config.json to change the target server.
echo Runtime: %WINMON_NODE%
echo.
echo Closing this window STOPS the Agent. To keep it running with no window
echo at all, close this one and use agent-background.bat instead.
echo.
"%WINMON_NODE%" agent.js
echo.
echo The Agent exited. Log: data\agent.log
echo (read-only folder: %%LOCALAPPDATA%%\WinMon\data\agent.log)
pause