# ytmusic-web

A self-hosted web front-end for YouTube Music: search and play songs, **play YouTube
videos as songs**, queue/shuffle/repeat, **time-synced lyrics**, PWA install with
lock-screen controls, and per-track download.

It is a browser-based answer to [Metrolist](https://github.com/MetrolistGroup/Metrolist)
(an Android app), built after establishing that Metrolist itself cannot run on a
server — see [docs/FINDINGS.md](docs/FINDINGS.md).

```
┌──────────┐   1. search / lyrics    ┌────────────────────────────┐
│ browser  │ ──────────────────────► │  Fastify API               │
│  (PWA)   │                         │  • youtubei.js  (metadata) │
│          │ ◄────────────────────── │  • lrclib / YT Music lyrics│
│          │   2. audio via /stream  └───────────┬────────────────┘
└──────────┘                                     │ 3. negotiate signed URL
                                                 ▼
                                     ┌────────────────────────────┐
                                     │ headless Chromium          │
                                     │ plays the track, we relay  │
                                     │ the UMP frames it receives │
                                     └───────────┬────────────────┘
                                                 │ 4. replayed w/ browser headers
                                                 ▼
                                          rr*.googlevideo.com
```

## How it works

YouTube's web clients no longer hand out direct media URLs — they are **SABR-only**
("server-side adaptive bitrate"). A URL resolved programmatically is either ciphered
or rejected with HTTP 403, and a PoToken does not fix it, because the two transports
bind the token differently:

| | SABR (what the page player uses) | direct `adaptiveFormats[].url` |
| --- | --- | --- |
| Request | `POST streamingData.serverAbrStreamingUrl` | `GET` a media URL |
| Token binding | **video id**, in the protobuf body | `visitorData`, as `?pot=` |
| Status | current | removed from WEB clients |

So this server speaks SABR directly:

```
browser ──► Fastify API ──► youtubei.js (search / metadata)
                 │          lrclib + YouTube Music (lyrics)
                 │
                 └──► SABR client (googlevideo)  ──►  rr*.googlevideo.com
                          • PoToken minted with bgutils-js (no browser)
                          • stream arrives already demuxed
                          • cached to disk → byte-range seeking
```

**No headless browser is involved.** That is the important part: an earlier version
drove a real Chromium page, which peaked near 800 MB and was OOM-killed on a 512 MB
free instance. Speaking SABR directly brings resident memory to **~150–300 MB**.
Details, including the two bugs that cost the most time, are in
[docs/FINDINGS.md](docs/FINDINGS.md).

## Deployment status (read this)

The app is complete and verified **locally**: search, playback, seeking, downloads
and synced lyrics all work, with no console errors. Two independent limits bite when
deploying to a free tier:

1. **Memory — solved.** SABR needs no browser, so a 512 MB instance now fits
   (measured 149 MB on Render).
2. **IP reputation — not solvable from a free tier.** Managed hosts hand out
   datacenter IPs, and YouTube refuses `/youtubei/v1/player` from them with **403**
   for *every* client (WEB, visionos, android_vr, …), even though PoToken minting
   works. `/youtubei/v1/browse` is not blocked, so **search works while playback
   does not** — exactly what the live Render deployment shows.

To get playback you need one of:

- a host whose egress address class is consumer-grade (a home connection works out
  of the box);
- **a routed IPv6 `/64` you can rotate within** — free, no home connection needed;
  set `EGRESS_IPV6_PREFIX=2001:db8:1234:5678::/64`. Check whether a host supports
  it with `./scripts/check-ipv6.sh`;
- a sticky residential/ISP proxy in front of a datacenter host (`HTTPS_PROXY`).

Measured: Render refuses playback in **both** tested regions (Oregon and
Singapore, both AS16509), so region choice does not help. See
[docs/EGRESS.md](docs/EGRESS.md) for costs, configuration and what does *not* work.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness + browser/session stats |
| GET | `/api/search?q=&type=` | `song` \| `video` \| `all` (songs, videos, albums, artists, playlists) |
| GET | `/api/track/:videoId` | track metadata |
| GET | `/api/lyrics/:videoId` | time-synced lyrics (YT Music, then LRCLIB) |
| GET | `/api/upnext/:videoId` | radio / queue continuation |
| POST | `/api/play/:videoId` | negotiate playback; returns the stream URL |
| GET | `/api/stream/:videoId` | audio relay, byte-range capable once cached |
| GET | `/api/download/:videoId` | whole track as WebM/Opus |
| GET | `/api/stats` | bytes served, cache and session counters |

## Quick start

**A host with a usable egress IP** (a VPS, home box, or always-free cloud VM) —
one command:

```bash
curl -fsSL https://raw.githubusercontent.com/freakymustard67/ytmusic-web/main/scripts/install.sh | sudo bash
# or, for automatic HTTPS on your own domain:
sudo DOMAIN=music.example.com ACCESS_PASSWORD=changeme ./scripts/install.sh
```

It installs Node 22, adds swap on small machines, sets up a systemd service
(optional Caddy TLS), and then **verifies SABR playback from that host's IP**,
telling you plainly if the IP is flagged.

## Running locally

```bash
cd backend
npm install
npm run bundle:botguard        # only needed if assets/bg.bundle.js is missing

CHROMIUM_PATH=/usr/bin/chromium \
STATIC_DIR="$PWD/../frontend/public" \
PORT=10000 npm run dev
# open http://localhost:10000
```

Any Chromium/Chrome binary works; `playwright-core` does not download one.

## Deploying to Render

`render.yaml` and the `Dockerfile` are ready; the service is live at
<https://ytmusic-web.onrender.com>. **Search works there; playback does not**,
because YouTube refuses `/youtubei/v1/player` from Render's datacenter IP with 403
for every client. Memory is no longer the issue — the container sits at ~150 MB.

Set `HTTPS_PROXY` to a residential/ISP proxy and playback starts working, because
the app routes *all* outbound traffic (YouTube, BotGuard, googlevideo) through it.

### Read this before making it public

Render's free instance gives your **entire workspace 5 GB of egress per month**,
and when it runs out Render *suspends every free service you own* until the month
rolls over — including any other projects in the same workspace. Audio costs about
1 MB per minute at 128 kbps, so 5 GB ≈ **87 hours of listening across all users**.

Mitigations built in:

- `BANDWIDTH_CAP_GB` — stop serving audio past a threshold (e.g. `4`).
- `MAX_SESSIONS` — concurrent Chromium sessions (default 2; each costs RAM).
- `RATE_LIMIT_PER_MIN` — per-IP request limit.
- `ACCESS_PASSWORD` — require a shared password on all `/api` routes.

Other free-tier facts worth knowing: the service sleeps after 15 minutes of no
inbound traffic (~1 minute cold start), has 0.1 CPU / 512 MB, and **cannot attach a
persistent disk** — so the audio cache and any downloads live on an ephemeral
filesystem and vanish on redeploy.

For a genuinely public deployment, a host with real egress is a much better fit
(Oracle Cloud Always Free includes 10 TB/month; Fly.io charges $0.02/GB).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `10000` | listen port |
| `MAX_CONCURRENT_FETCHES` | `2` | simultaneous SABR track downloads |
| `FETCH_MAX_MS` | `150000` | abort a track download after this long |
| `CACHE_DIR` | `/tmp/ytmusic-cache` | captured audio cache (empty disables) |
| `CACHE_MAX_MB` | `512` | cache ceiling before LRU eviction |
| `CAPTURE_MAX_MS` | `150000` | per-track capture budget |
| `BANDWIDTH_CAP_GB` | `0` | stop serving after N GB in this process (0 = off) |
| `RATE_LIMIT_PER_MIN` | `60` | per-IP requests/minute on `/api` |
| `ACCESS_PASSWORD` | – | shared password for all `/api` routes |
| `STATIC_DIR` | – | serve the front-end from this directory |
| `CORS_ORIGIN` | `*` | allowed origins |

## Limitations

- **Albums, artists and playlists are listed but not browsable** — clicking one
  shows a notice. Search works for all types.
- **Seeking needs the track cached.** Until a capture finishes, the stream
  advertises `accept-ranges: none`.
- **First play takes ~5–10 s** while Chromium negotiates the track.
- **This depends on YouTube's private API** and will break when they change it.
  Nothing here circumvents DRM; it relays ordinary audio streams the same way a
  browser does. Respect YouTube's Terms of Service and your local law.

## Licence

GPL-3.0. Built on [youtubei.js](https://github.com/LuanRT/YouTube.js) (MIT) and
[bgutils-js](https://github.com/LuanRT/BgUtils) (MIT).
