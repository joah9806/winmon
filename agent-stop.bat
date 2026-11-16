@echo off
setlocal
cd /d "%~dp0"
title WinMon Agent Stop
call pick-node.bat
if errorlevel 1 exit /b 1
"%WINMON_NODE%" agent.js --stop
pause