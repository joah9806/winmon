@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Packaging Agent deployment bundle (includes runtime, may take ~1 min)...
if exist agent-tmp rmdir /s /q agent-tmp
mkdir agent-tmp\runtime agent-tmp\lib
copy /y runtime\node.exe agent-tmp\runtime\ >nul
copy /y agent.js agent-tmp\ >nul
copy /y agent.bat agent-tmp\ >nul
copy /y stop.bat agent-tmp\ >nul
copy /y lib\metrics.js agent-tmp\lib\ >nul
copy /y lib\collect.ps1 agent-tmp\lib\ >nul
copy /y config.json agent-tmp\ >nul
powershell -NoProfile -Command "Compress-Archive -Path agent-tmp\* -DestinationPath agent-package.zip -Force"
rmdir /s /q agent-tmp
echo.
echo Done: agent-package.zip
echo Copy it to the target Windows PC, unzip, set agent.server_url in config.json, then run agent.bat
pause