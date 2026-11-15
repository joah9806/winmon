@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
rem No "chcp 65001" - it breaks batch execution on Windows 7 cmd.exe.
rem The pid files may live in data\ or, when the app folder is read-only,
rem in %LOCALAPPDATA%\WinMon\data.
set "DD=%~dp0data"
if not exist "%DD%\server.pid" if exist "%LOCALAPPDATA%\WinMon\data\server.pid" set "DD=%LOCALAPPDATA%\WinMon\data"

if exist "%DD%\server.pid" (
  set /p SPID=<"%DD%\server.pid"
  echo Stopping server process !SPID! ...
  taskkill /F /PID !SPID! >nul 2>&1
  del "%DD%\server.pid" >nul 2>&1
) else (
  echo No running server found.
)
if exist "%DD%\agent.pid" (
  set /p APID=<"%DD%\agent.pid"
  echo Stopping agent process !APID! ...
  taskkill /F /PID !APID! >nul 2>&1
  del "%DD%\agent.pid" >nul 2>&1
)
if exist "%~dp0agent.pid" (
  set /p APID=<"%~dp0agent.pid"
  taskkill /F /PID !APID! >nul 2>&1
  del "%~dp0agent.pid" >nul 2>&1
)
echo Done.
pause