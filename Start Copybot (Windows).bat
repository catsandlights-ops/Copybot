@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org then run this again. & pause & exit /b)
if not exist node_modules (echo Installing, this takes a minute the first time... & call npm install)
if not exist .env copy .env.example .env >nul
call npm run app
pause
