@echo off
setlocal
cd /d "%~dp0"
title WinMon Diagnostics
rem ASCII output only; no "chcp 65001" (it breaks batch execution on Windows 7).

call pick-node.bat
if errorlevel 1 exit /b 1

echo ============================================================
echo  WinMon full diagnostics
echo  This checks the runtime, permissions, storage, PowerShell,
echo  the collection script, ping and the listening port.
echo  It can take up to a minute on Windows 7. Please wait.
echo ============================================================
echo.
"%WINMON_NODE%" preflight.js --full
echo.
if exist data\diagnose.txt (
  echo Opening the Chinese report in Notepad...
  start "" notepad.exe "data\diagnose.txt"
) else (
  echo Report was written to your TEMP folder: winmon-diagnose.txt
  start "" notepad.exe "%TEMP%\winmon-diagnose.txt"
)
echo.
echo To see startup errors live, run start-console.bat instead.
pause