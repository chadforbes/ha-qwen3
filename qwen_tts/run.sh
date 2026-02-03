#!/bin/sh
set -eu

OPTIONS_FILE="/data/options.json"
REMOTE_URL=""

if [ -f "$OPTIONS_FILE" ]; then
  REMOTE_URL="$(jq -r '.remote_url // ""' "$OPTIONS_FILE" 2>/dev/null || echo "")"
fi

# Normalize: trim whitespace and trailing slashes
REMOTE_URL="$(echo "$REMOTE_URL" | tr -d '\r' | sed -e 's/^ *//; s/ *$//' -e 's:/*$::')"

cat > /etc/nginx/http.d/default.conf <<EOF
map \$http_upgrade \$connection_upgrade {
  default upgrade;
  '' close;
}

server {
  listen 8099;

  # Home Assistant Ingress
  allow 172.30.32.2;
  deny all;

  root /www;

  location / {
    try_files \$uri \$uri/ /index.html;
  }

  # Same-origin proxy to the configured remote Qwen3 server.
  # This avoids browser CORS + mixed-content issues under Home Assistant ingress.
  location /api/ {
    if ("$REMOTE_URL" = "") { return 503; }

    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;

    proxy_read_timeout 120s;
    proxy_send_timeout 120s;

    # Drop /api prefix
    proxy_pass $REMOTE_URL/;
  }
}
EOF

exec nginx -g 'daemon off;'
