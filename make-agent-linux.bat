@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist runtime\node-linux (
  echo Downloading Linux Node runtime...
  curl -sL -o node-linux.tar.gz https://nodejs.org/dist/latest-v24.x/node-v24.22.3-linux-x64.tar.gz
  tar -xzf node-linux.tar.gz node-v24.22.3-linux-x64/bin/node
  copy /y node-v24.22.3-linux-x64\bin\node runtime\node-linux >nul
  rmdir /s /q node-v24.22.3-linux-x64
  del node-linux.tar.gz
)
echo Packaging Linux Agent bundle...
powershell -NoProfile -ExecutionPolicy Bypass -File make-linux-zip.ps1
echo.
echo Done: agent-linux.zip
echo On the Linux server: unzip, set agent.server_url in config.json, then:
echo   chmod +x runtime/node agent.sh
echo   ./agent.sh
pause