@echo off
cd /d "%~dp0"
call pick-node.bat
echo Packaging Linux Agent bundle...
"%WINMON_NODE%" make-package.js linux
echo.
echo Done: agent-linux-v[version].zip
echo On the Linux server: unzip, set agent.server_url in config.json, then:
echo   chmod +x runtime/node agent.sh
echo   ./agent.sh
pause
