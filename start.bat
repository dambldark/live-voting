@echo off
cd /d "%~dp0"
echo.
echo  === Live Voting ===
echo.
echo  Upravlenie:  http://localhost:8080/admin.html
echo  Efir (OBS):  http://localhost:8080/broadcast.html
echo  Golosovanie: http://localhost:8080/vote
echo.
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8080 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
node server.js
pause
