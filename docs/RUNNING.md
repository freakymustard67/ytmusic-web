# Running it yourself

The app is complete and verified. The one thing that cannot be fixed in code is
the **egress IP**: YouTube refuses `/youtubei/v1/player` from datacenter addresses
with 403 for every client. Memory is no longer a constraint (playback speaks SABR
with no browser, ~150–300 MB), so the shortest path to a working instance is any
machine with a normal IP — a home box, a cheap VPS, or an always-free cloud VM.

The one-command route:

```bash
curl -fsSL https://raw.githubusercontent.com/freakymustard67/ytmusic-web/main/scripts/install.sh | sudo bash
```

It verifies playback from that host's IP as its final step. If it reports 403, set
`HTTPS_PROXY` to a residential/ISP proxy and restart.

The manual route, and the commands used to verify everything, follow.

## On this machine

```bash
cd backend
npm install
npm run build

PORT=10000 \
CACHE_DIR=/tmp/ytmusic-cache \
STATIC_DIR="$PWD/../frontend/public" \
node dist/index.js
```

Open <http://localhost:10000>. Chromium is auto-detected at `/usr/bin/chromium`.

First play takes ~7 s while Chromium negotiates the track; after that the track is
cached and seeking is instant.

## Exact commands used to verify it works

```bash
# 1. search
curl -s "http://localhost:10000/api/search?q=kesariya&type=song" | head -c 400

# 2. negotiate playback (launches Chromium, ~7s)
curl -s -X POST http://localhost:10000/api/play/NJAv_7lHUIU
# -> {"ready":true,"itag":"251","hasPoToken":true,...}

# 3. stream and check it is real audio
curl -s -o /tmp/t.webm -H "Range: bytes=0-511999" http://localhost:10000/api/stream/NJAv_7lHUIU
ffprobe -v error -show_entries stream=codec_name,sample_rate -show_entries format=duration \
  -of default=noprint_wrappers=1 /tmp/t.webm
# -> codec_name=opus / sample_rate=48000 / duration=268.181000

# 4. seek (needs a completed capture)
curl -s -D- -o /dev/null -H "Range: bytes=2000000-2065535" \
  http://localhost:10000/api/stream/NJAv_7lHUIU | grep -i content-range
# -> content-range: bytes 2000000-2065535/4704034

# 5. synced lyrics
curl -s "http://localhost:10000/api/lyrics/NJAv_7lHUIU" | head -c 300
```

## Use it from your phone on the same Wi-Fi

The server binds `0.0.0.0`, so find your LAN IP and open it on the phone:

```bash
hostname -I | awk '{print $1}'    # e.g. 192.168.1.42
# then on the phone: http://192.168.1.42:10000
```

Then use the browser's "Add to Home screen" — the PWA gives you lock-screen
controls and background playback.

## Keep it running

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/ytmusic-web.service <<'UNIT'
[Unit]
Description=ytmusic-web
After=network-online.target

[Service]
WorkingDirectory=%h/ytmusic-web/backend
Environment=PORT=10000
Environment=CACHE_DIR=/tmp/ytmusic-cache
Environment=STATIC_DIR=%h/ytmusic-web/frontend/public
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now ytmusic-web
systemctl --user status ytmusic-web
```

## Exposing it to the internet

If you want it reachable from anywhere without opening ports, a Cloudflare Tunnel
is the least effort and needs no account changes:

```bash
# install cloudflared, then:
cloudflared tunnel --url http://localhost:10000
```

It prints a public `https://…trycloudflare.com` URL. Add `ACCESS_PASSWORD=…` to the
environment first if you do this — a public URL with no password is an open proxy to
YouTube on your IP.

## If you later get a bigger host

Any 1 GB+ machine works: copy the repo, run the same commands, put Caddy or nginx in
front for TLS. `Dockerfile` and `render.yaml` are in the repo and work unchanged on a
host with enough RAM.
