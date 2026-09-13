@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22.12 or newer, then try again.
  pause
  exit /b 1
)
start "" "http://127.0.0.1:5174/"
node serve.mjs
pause
