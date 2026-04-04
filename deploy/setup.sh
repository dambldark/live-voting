#!/bin/bash
# =============================================================
#  Live Voting — setup script for Ubuntu 20.04/22.04
#
#  Usage:
#    sudo bash setup.sh <github_repo> <email> [domain]
#
#  Example:
#    sudo bash setup.sh https://github.com/yourname/live-voting admin@queo.ru queo.ru
# =============================================================
set -e

REPO=${1:?"Usage: sudo bash setup.sh <github_repo_url> <email> [domain]"}
EMAIL=${2:?"Usage: sudo bash setup.sh <github_repo_url> <email> [domain]"}
DOMAIN=${3:-"queo.ru"}
APP_DIR="/var/www/question"
LOG_DIR="/var/log/live-voting"

echo ""
echo "=========================================="
echo "  Live Voting — Server Setup"
echo "  Repo  : $REPO"
echo "  Domain: $DOMAIN"
echo "  App   : $APP_DIR"
echo "=========================================="
echo ""

# ── 1. System update ──────────────────────────────────────────
echo "[1/8] Updating system packages..."
apt-get update -qq
apt-get install -y -qq git curl

# ── 2. Node.js 20 ────────────────────────────────────────────
echo "[2/8] Installing Node.js 20..."
if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
echo "      Node: $(node -v)  npm: $(npm -v)"

# ── 3. PM2 ───────────────────────────────────────────────────
echo "[3/8] Installing PM2..."
npm install -g pm2 --quiet

# ── 4. Nginx ─────────────────────────────────────────────────
echo "[4/8] Installing Nginx..."
apt-get install -y nginx
systemctl enable nginx
systemctl start nginx

# ── 5. Clone repo ────────────────────────────────────────────
echo "[5/8] Cloning repository..."
if [ -d "$APP_DIR/.git" ]; then
    echo "      Repo already exists — pulling latest..."
    cd "$APP_DIR" && git pull
else
    git clone "$REPO" "$APP_DIR"
fi

mkdir -p "$LOG_DIR"
mkdir -p "$APP_DIR/public/uploads"

cd "$APP_DIR"
npm install --production --quiet
echo "      Dependencies installed."

# ── 6. Nginx config ──────────────────────────────────────────
echo "[6/8] Configuring Nginx..."

# Generate nginx config with actual domain
cat > "/etc/nginx/sites-available/$DOMAIN" <<NGINXCONF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
        proxy_buffering off;
    }

    client_max_body_size 25M;
}
NGINXCONF

ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
echo "      Nginx configured for $DOMAIN"

# ── 7. PM2 ───────────────────────────────────────────────────
echo "[7/8] Starting application with PM2..."
cd "$APP_DIR"

# Stop existing instance if running
pm2 stop live-voting 2>/dev/null || true
pm2 delete live-voting 2>/dev/null || true

pm2 start ecosystem.config.js
pm2 startup systemd -u root --hp /root | grep "sudo" | bash || true
pm2 save
pm2 list

# ── 8. SSL ───────────────────────────────────────────────────
echo "[8/8] Installing SSL certificate..."
apt-get install -y certbot python3-certbot-nginx -qq
certbot --nginx \
    -d "$DOMAIN" -d "www.$DOMAIN" \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    --redirect
echo "      SSL certificate installed!"

# ── Firewall ──────────────────────────────────────────────────
if command -v ufw &>/dev/null; then
    ufw allow OpenSSH
    ufw allow 'Nginx Full'
    ufw --force enable
fi

echo ""
echo "=========================================="
echo "  ГОТОВО!"
echo ""
echo "  Управление : https://$DOMAIN"
echo "  Эфир (OBS) : https://$DOMAIN/broadcast.html"
echo "  Голосование: https://$DOMAIN/vote"
echo ""
echo "  Обновить приложение в будущем:"
echo "    cd $APP_DIR && git pull && npm install --production && pm2 restart live-voting"
echo "=========================================="
