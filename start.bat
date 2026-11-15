@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting WinMon in background (no console window)...
wscript //b start-hidden.vbs
echo Server is starting in background. Browser opens automatically.
echo Web UI: http://127.0.0.1:8686
echo Stop: stop.bat or the web UI button. Log: data\server.log