@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"
if exist data\server.pid (
  set /p SPID=<data\server.pid
  echo Stopping server process !SPID! ...
  taskkill /F /PID !SPID! >nul 2>&1
  del data\server.pid >nul 2>&1
) else (
  echo No running server found.
)
if exist agent.pid (
  set /p APID=<agent.pid
  echo Stopping agent process !APID! ...
  taskkill /F /PID !APID! >nul 2>&1
  del agent.pid >nul 2>&1
)
echo Done.
pause