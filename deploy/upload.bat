@echo off
:: ==========================================================
::  Live Voting — upload files to VPS
::  Requires: OpenSSH (built into Windows 10/11) or Git Bash
:: ==========================================================
cd /d "%~dp0.."

set SERVER_USER=root
set SERVER_IP=YOUR_SERVER_IP

echo.
echo  Uploading Live Voting to %SERVER_USER%@%SERVER_IP%...
echo.

:: Create remote directory
ssh %SERVER_USER%@%SERVER_IP% "mkdir -p /var/www/question/public/uploads"

:: Upload files (excluding node_modules, data.json, uploads)
scp -r public          %SERVER_USER%@%SERVER_IP%:/var/www/question/
scp -r deploy          %SERVER_USER%@%SERVER_IP%:/var/www/question/
scp    server.js       %SERVER_USER%@%SERVER_IP%:/var/www/question/
scp    package.json    %SERVER_USER%@%SERVER_IP%:/var/www/question/
scp    ecosystem.config.js %SERVER_USER%@%SERVER_IP%:/var/www/question/

echo.
echo  Файлы загружены!
echo.
echo  Теперь подключитесь к серверу и запустите setup:
echo    ssh %SERVER_USER%@%SERVER_IP%
echo    sudo bash /var/www/question/deploy/setup.sh your@email.com
echo.
pause
