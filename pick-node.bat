@echo off
rem Select the bundled Node 12 runtime matching the OS architecture.
rem Node 12.22.12 is the last LTS that runs on Windows 7 SP1.
rem On 64-bit Windows a 32-bit cmd reports PROCESSOR_ARCHITECTURE=x86 but also
rem sets PROCESSOR_ARCHITEW6432=AMD64, so only a pure 32-bit OS picks node-x86.
set "WINMON_NODE=runtime\node.exe"
if /i "%PROCESSOR_ARCHITECTURE%"=="x86" if not defined PROCESSOR_ARCHITEW6432 set "WINMON_NODE=runtime\node-x86.exe"
if not exist "%WINMON_NODE%" set "WINMON_NODE=runtime\node.exe"
if not exist "%WINMON_NODE%" (
  echo ERROR: runtime\node.exe not found.
  echo Download winmon-server-windows.zip from Releases, or place a Node.js 12+ binary at runtime\node.exe.
  pause
  exit /b 1
)