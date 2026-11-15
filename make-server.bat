@echo off
cd /d "%~dp0"
call pick-node.bat
echo Packaging full server bundle...
"%WINMON_NODE%" make-package.js server
echo.
echo Done: winmon-server-windows.zip
pause
