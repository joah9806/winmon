@echo off
cd /d "%~dp0"
call pick-node.bat
echo Packaging Agent deployment bundle (includes x64 + x86 runtime, may take ~1 min)...
"%WINMON_NODE%" make-package.js agent
echo.
echo Copy agent-package.zip to the target Windows PC, unzip,
echo set agent.server_url in config.json, then run agent.bat
pause
