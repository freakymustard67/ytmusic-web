#!/usr/bin/env bash
#
# Bootstrap ytmusic-web on a fresh Ubuntu 22.04/24.04 or Debian 12 host.
#
# Why a VM: deployment needs two things a free PaaS does not give you — ~1 GB of
# RAM and an egress IP that YouTube has not flagged. A cheap VPS, a home box, or
# an always-free cloud VM all qualify. See docs/FINDINGS.md §11.
#
# Usage (as root, or with sudo):
#   curl -fsSL https://raw.githubusercontent.com/freakymustard67/ytmusic-web/main/scripts/install.sh | sudo bash
#   # or from a checkout:
#   sudo ./scripts/install.sh
#
# Options via environment:
#   APP_DIR     where to install            (default /opt/ytmusic-web)
#   APP_USER    service account             (default ytmusic)
#   PORT        listen port                 (default 10000)
#   DOMAIN      hostname for Caddy TLS      (optional; plain HTTP if unset)
#   REPO_URL    git remote                  (default the GitHub repo)
#   BRANCH      branch to deploy            (default main)
#   ACCESS_PASSWORD  shared password for /api (optional but advised if public)
#   HTTPS_PROXY      route outbound through a proxy (optional)

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ytmusic-web}"
APP_USER="${APP_USER:-ytmusic}"
PORT="${PORT:-10000}"
REPO_URL="${REPO_URL:-https://github.com/freakymustard67/ytmusic-web.git}"
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "run as root (use sudo)"

log "installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates build-essential

# Node 22 (the app needs >= 20; 22 matches what it is tested on).
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  log "installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
log "node $(node -v), npm $(npm -v)"

# A swap file keeps a 1 GB machine comfortable during a track download.
if [ ! -f /swapfile ] && [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 2000 ]; then
  log "adding a 1 GB swap file"
  fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "creating service account and directories"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" /var/cache/ytmusic-web
chown -R "$APP_USER:$APP_USER" "$APP_DIR" /var/cache/ytmusic-web

log "fetching source"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" checkout --quiet "$BRANCH"
  git -C "$APP_DIR" reset --hard --quiet "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

log "building (this installs dependencies and compiles TypeScript)"
sudo -u "$APP_USER" bash -c "cd '$APP_DIR/backend' && npm ci --include=dev --silent && npm run build --silent"

# The BotGuard bundle is committed, but rebuild it if the package is present and
# the artifact is missing.
if [ ! -f "$APP_DIR/backend/assets/bg.bundle.js" ]; then
  log "rebuilding the BotGuard bundle"
  sudo -u "$APP_USER" bash -c "cd '$APP_DIR/backend' && npm run bundle:botguard --silent"
fi

log "writing environment file"
ENV_FILE="$APP_DIR/backend/.env"
{
  echo "NODE_ENV=production"
  echo "PORT=$PORT"
  echo "HOST=127.0.0.1"
  echo "CACHE_DIR=/var/cache/ytmusic-web"
  echo "STATIC_DIR=$APP_DIR/frontend/public"
  echo "CACHE_MAX_MB=1024"
  echo "MAX_CONCURRENT_FETCHES=2"
  echo "FETCH_MAX_MS=150000"
  # Bandwidth guard: 0 disables it. On a metered host set it to a few GB.
  echo "BANDWIDTH_CAP_GB=${BANDWIDTH_CAP_GB:-0}"
  echo "RATE_LIMIT_PER_MIN=${RATE_LIMIT_PER_MIN:-90}"
  [ -n "${ACCESS_PASSWORD:-}" ] && echo "ACCESS_PASSWORD=$ACCESS_PASSWORD"
  [ -n "${HTTPS_PROXY:-}" ] && echo "HTTPS_PROXY=$HTTPS_PROXY"
  # Rotate egress within a routed IPv6 prefix (the free way past YouTube's
  # address-class block). Run scripts/check-ipv6.sh to see if this host can.
  [ -n "${EGRESS_IPV6_PREFIX:-}" ] && echo "EGRESS_IPV6_PREFIX=$EGRESS_IPV6_PREFIX"
  [ -n "${EGRESS_IPV6_POOL:-}" ] && echo "EGRESS_IPV6_POOL=$EGRESS_IPV6_POOL"
  [ -n "${EGRESS_IPV6_IFACE:-}" ] && echo "EGRESS_IPV6_IFACE=$EGRESS_IPV6_IFACE"
} > "$ENV_FILE"
chown "$APP_USER:$APP_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

log "installing systemd unit"
cat > /etc/systemd/system/ytmusic-web.service <<UNIT
[Unit]
Description=ytmusic-web (YouTube Music web client)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/backend
EnvironmentFile=$APP_DIR/backend/.env
ExecStart=/usr/bin/node $APP_DIR/backend/dist/index.js
Restart=on-failure
RestartSec=5
# A track download is a few MB; keep the service inside a sane envelope.
MemoryMax=1200M
# IPv6 rotation must add source addresses to the interface. Without this the
# kernel silently falls back to the primary address, so rotation appears to work
# but never changes anything.
AmbientCapabilities=CAP_NET_ADMIN
CapabilityBoundingSet=CAP_NET_ADMIN

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now ytmusic-web
sleep 2
systemctl is-active --quiet ytmusic-web || { journalctl -u ytmusic-web -n 40 --no-pager; die "service failed to start"; }
log "service is running"

log "checking /health"
for i in $(seq 1 15); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    curl -s "http://127.0.0.1:$PORT/health"; echo
    break
  fi
  sleep 2
  [ "$i" = 15 ] && warn "health check did not pass; inspect: journalctl -u ytmusic-web -n 50"
done

# Reverse proxy with automatic TLS when a domain is supplied.
if [ -n "$DOMAIN" ]; then
  log "configuring Caddy for $DOMAIN"
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy
  fi
  cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    encode gzip
    reverse_proxy 127.0.0.1:$PORT {
        # Audio responses are long-lived; do not buffer them.
        flush_interval -1
    }
}
CADDY
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  log "https://$DOMAIN should be live once DNS points here"
else
  warn "no DOMAIN set: the service listens on 127.0.0.1:$PORT only."
  warn "put a reverse proxy in front, or re-run with DOMAIN=music.example.com"
fi

cat <<SUMMARY

  ytmusic-web is installed.

    directory : $APP_DIR
    service   : systemctl status ytmusic-web
    logs      : journalctl -u ytmusic-web -f
    health    : curl -s localhost:$PORT/health

  Verify playback works from this host's IP:

    curl -s "localhost:$PORT/api/diagnostics?videoId=ZczAI-GNFbk"

  An \`"sabr": "ok"\` with a byte count means the whole pipeline works here.
  If it reports a refusal, this host's address class is distrusted by YouTube.
  Two free-ish fixes, neither needing your home connection:

    1. Rotate IPv6 (preferred, free):
         ./scripts/check-ipv6.sh          # can this host source arbitrary /64s?
         # then add EGRESS_IPV6_PREFIX=<your prefix> to $ENV_FILE and restart
       The systemd unit already grants CAP_NET_ADMIN, which rotation needs.

    2. Route egress through a residential/ISP proxy:
         HTTPS_PROXY=http://user:pass@host:port   (add to $ENV_FILE)

  See docs/EGRESS.md for the full comparison and caveats.

SUMMARY
