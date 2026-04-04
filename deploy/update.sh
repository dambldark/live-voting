#!/bin/bash
# Обновить приложение с GitHub
set -e
cd /var/www/question
echo "Pulling latest code..."
git pull
echo "Installing dependencies..."
npm install --production --quiet
echo "Restarting app..."
pm2 restart live-voting
echo "Done! Current status:"
pm2 list
