# Findings: how YouTube Music playback actually works server-side

All results below were reproduced on this machine (Debian, Node 22, Chromium via
`playwright-core`) against real YouTube Music. Nothing here is speculative — each
claim has a command behind it in `research/poc/`.

## 1. Metrolist cannot run on a server

`MetrolistGroup/Metrolist` is an Android application:

| Evidence | Value |
| --- | --- |
| `compileSdk` | 37, `minSdk` 26 |
| Core deps | AndroidX Compose, Media3/ExoPlayer, Room, Hilt, DataStore |
| InnerTube layer | `MetrolistGroup/innertubex` — "eXtended InnerTube API library for Kotlin" |
| Cipher/PoTokens | `ZemerTeam/zemer-cipher` — "standalone **Android** library … PoToken (BotGuard) generation" |

PoToken generation in Metrolist happens **inside an Android `WebView`**
(`zemer-cipher` is tagged `android`, `webview`, `botguard`). There is no JVM/server
build target, so "run Metrolist on Render" is not a porting exercise — it is a rewrite.

## 2. Search / metadata is easy

`youtubei.js` performs InnerTube search for songs, videos, albums, artists and
playlists from plain Node with no browser and no PoToken:

```
music.search('kesariya', { type: 'song' })  -> "Kesariya (From \"Brahmastra\")" | Arijit Singh
music.search('lofi hip hop', { type: 'video' }) -> videos-as-songs work identically
```

One gotcha: `Innertube.create({ retrieve_player: false })` breaks streaming data
parsing later. Keep `retrieve_player: true`.

## 3. Stream URLs always come back signature-ciphered

`chooseFormat()` returns `url: undefined` and populates `signature_cipher`. Deciphering
requires the `n`/`sig` transform from the player script:

```
Error: To decipher URLs, you must provide your own JavaScript evaluator.
```

`youtubei.js` v18 has no evaluator on Node — it is a deliberate hole. It is fillable in
~15 lines with `node:vm` (see `research/poc/bench-range.mjs`). With that in place you get
a real `rr*.googlevideo.com` URL.

## 4. The 403 wall — and exactly what clears it

| Attempt | Result |
| --- | --- |
| Deciphered URL, fetch from Node, no token | **403** |
| Deciphered URL, fetch from Node, valid PoToken minted out-of-band | **403** (`pot=true`) |
| Deciphered URL, fetch **from inside the browser page** | **403** |
| The browser's **own player** playing the same track | **200 ×16, zero 403** |

Conclusion: a URL that `youtubei.js` resolves is **not** interchangeable with the URL
Chromium's player uses, even from the same IP with a valid PoToken and correct `Origin`.
YouTube binds playback to the player session/context, not just to the token.

**Therefore the browser must be the thing that negotiates playback.**

## 5. PoToken minting does work headlessly from a datacenter IP

`bgutils-js` (BotGuard) inside an injected bundle, running in a real page context:

```
BotGuard VM loaded: object (globalName=trayride)
botguardResponse: 2017 bytes
GenerateIT: HTTP 200  -> ["MkGIR9j/…", 43200]   (12h TTL)
PO TOKEN minted: 804 chars
```

Two non-obvious requirements:
- The BotGuard interpreter must be fetched **from Node** and injected
  (`page.addScriptTag({ content })`) — YouTube's CSP demands `TrustedScriptURL` /
  `TrustedScript`, and `connect-src` blocks an in-page fetch.
- CSP headers must be stripped on the way through (`page.route` + strip
  `content-security-policy*`), otherwise Trusted Types rejects the injection.

Note: minting a PoToken is **not sufficient** on its own (see §4).

## 6. Delivering bytes: the winning mechanism

Intercept the browser's own audio requests with Playwright's `page.route`, then replay
them from Node using **the request's own headers**:

```js
await page.route(/googlevideo\.com\/videoplayback.*mime=audio/, async (route) => {
  const req = route.request();
  const resp = await route.fetch();          // exact URL + headers replayed
  const body = await resp.body();
  await route.fulfill({ response: resp, body });
});
```

Result: `status 200`, ~66 KB audio segments, `itag 251`, player advancing
(`t=19.5s`, `duration=114.7s`, `error=null`).

Headers the request carries and that matter:
`accept, origin, referer, user-agent, sec-ch-ua*`.

## 7. UMP demuxing

> **Correction (see §10).** UMP is not merely "a small protobuf header to strip".
> It is a varint-framed part stream — `varint(partType)`, `varint(partSize)`,
> payload — where `MEDIA` payloads begin with a 1-byte `headerId` selecting which
> `MEDIA_HEADER` the bytes belong to. The magic-offset trick below happened to work
> for the browser's concatenated output, but `UmpReader` from `googlevideo/ump`
> is the correct way to parse it. The original notes are kept because they
> document how the framing was first identified.

Audio responses are **not** plain WebM. `Content-Type` is
`application/vnd.yt-ump`, YouTube's Unified Media Protocol. Raw concatenation does not
parse, and neither `ffmpeg` nor a client `MediaSource` can decode it:

```
ffprobe /tmp/seg-concat.bin  -> Invalid data found when processing input
sb.appendBuffer(umpBytes)    -> "appended OK, buffered=0s"   (silently useless)
```

Frame layout, derived empirically:

```
[ small protobuf header ][ raw container bytes … ]
   ^ carries videoId + itag (itag 251 appears in the header)
                          ^ starts with 1a 45 df a3  (EBML magic -> WebM)
```

There is **no length prefix before the header** — the first byte is a protobuf field tag.
Locating the container magic is therefore the robust strategy (works for both WebM/EBML
and ISO-BMFF `ftyp`):

```
container: webm
header:    {bytes: 58, videoId: "NJAv_7lHUIU"}
media:     758069 bytes, magic 1a45dfa39f428681

ffprobe -> codec_name=opus  sample_rate=48000  channels=2
           format_name=matroska,webm  duration=268.181000
```

That is a valid, complete-length Opus stream. See `backend/ump.mjs`.

## 8. Cost / platform reality (Render free tier)

| Constraint | Value |
| --- | --- |
| Spin-down | after 15 min with no inbound traffic (idle WebSockets do **not** count) |
| Cold start | ~1 minute |
| Egress | **5 GB/month for the whole workspace**, then *all* free services are suspended |
| Overage | $0.15/GB (Hobby), not a hard cap if a card is attached |
| RAM / CPU | 0.1 CPU, 512 MB |
| Disks | **not available on free** — filesystem is ephemeral |
| AUP | no explicit anti-media-proxy clause; enforcement via generic clauses + DMCA |

At ~128 kbps, 5 GB ≈ **87 hours** of audio across all users. A single popular link
exhausts it and takes `carmel-portal`, your scrapers and the other free services down
with it until the month rolls over.

**Mitigations implemented:** `BANDWIDTH_CAP_GB` guard (stops streaming at a threshold),
`MAX_SESSIONS` concurrency limit, and per-IP rate limiting.

## 9. Render free tier cannot host this (measured)

Deployed to Render free (`0.1 CPU / 512 MB`) with Chromium installed via the build
command. Results:

| Check | Result |
| --- | --- |
| Chromium launches | ✅ `/usr/bin/chromium`, version `154.0.8037.57` |
| Codecs (opus/AAC/VP9/H.264) | ✅ all `probably` / `MediaSource.isSupported` true |
| Search + lyrics API | ✅ works (metadata needs no browser) |
| Node idle RSS | **~300 MB of the 512 MB budget, before Chromium starts** |
| Load `music.youtube.com` and play | ❌ container OOM-killed; Render returns 502, service restarts ~30 s later |
| After the resource diet (block image/font/stylesheet) | negotiation no longer crashes, but still never receives audio |

The OOM is reproducible: any endpoint that actually loads the YouTube Music page
kills the container, while lightweight endpoints keep working. Chromium plus that
page needs roughly 300–500 MB on its own, which does not fit beside Node in 512 MB.

`CHROMIUM_SINGLE_PROCESS=true` and `MAX_SESSIONS=1` reduce pressure and stop the
crash, but not enough to reach playback.

**Conclusion:** the architecture is sound (it runs perfectly on a normal machine),
but a 512 MB free instance is below the floor for browser-based negotiation. The
same image works on any host with ~1 GB+ of RAM.


## 10. The real fix: speak SABR directly (no browser)

Everything in §3–§9 was chasing the wrong transport. The browser's 200s and the
API's 403s were never the same request:

| | Browser playback | `adaptiveFormats[].url` |
| --- | --- | --- |
| Endpoint | `POST streamingData.serverAbrStreamingUrl` | `GET` a direct media URL |
| Framing | UMP parts over SABR | plain HTTP range |
| PoToken binding | **video id**, inside the protobuf body | `visitorData`, as a `?pot=` query param |
| Status in 2026 | works | **removed from WEB clients** |

"pot=true but 403" is the signature of a *binding* mismatch, not an invalid token.
Two further traps:

- **`web_music` BotGuard challenges cannot come from InnerTube `/att/get`** — they
  must be scraped from page HTML (`window.ytAtN`). A token minted from an
  InnerTube challenge for WEB_REMIX is rejected.
- The BotGuard request key is **`O43z0dpjhgX20SCx4KAo`** (capital O).

### Working implementation

`LuanRT/googlevideo`'s `SabrStream` drives the SABR protocol and hands back an
already-demuxed audio `ReadableStream`. Combined with `bgutils-js` for the token
and `youtubei.js` for the player response, playback needs **no browser at all**
(`backend/src/sabr.ts`).

Measured locally: a 3.14 MB track fetched in **~8 s**, byte-identical length to the
`contentLength` the player advertised, valid WebM/Opus (48 kHz stereo), and
byte-range seeking served from disk.

Two implementation details that cost real debugging time:

1. **`selectFormats()` requires both a video and an audio format.** With
   `enabledTrackTypes: AUDIO_ONLY` alone it throws `No suitable formats found for
   download`; audio-only needs explicit `audioFormat`/`videoFormat` selectors.
2. **The ABR URL must come from the same player response as the formats and
   ustreamer config.** Reusing a cached session made the URL carry a stale
   `cver` (`2.20260623.01.00` instead of the session's `2.20260930.00.00`) and the
   stream never terminated — it ran to 782 MB with `Stream stalled 5 times`.

### Memory consequence

| | Headless Chromium | SABR (no browser) |
| --- | --- | --- |
| Resident RSS | ~800 MB peak; OOM on a 512 MB instance | **~150–300 MB** |
| Free-tier viability | impossible | fits |

## 11. Render free tier, second blocker: the IP is blocked

With Chromium gone, the OOM is solved (Render reports `rssMb: 149`). Playback
still fails, for an unrelated and more fundamental reason:

```
GET /api/ipdiag   →  every client, HTTP 403
WEB 403 · MWEB 403 · TV 403 · VISIONOS 403 · ANDROID_VR 403 · WEB_EMBEDDED_PLAYER 403 · IOS 403
```

- PoToken minting from Render **works** (`length: 124`), so the block is not
  token-related.
- It is not client-related either — `visionos`, which yt-dlp's client policy table
  lists as requiring no PoToken, is refused just the same.
- The block is **endpoint-specific**: `/youtubei/v1/browse` (search) still answers,
  so search works on Render while `/youtubei/v1/player` (playback) and the lyrics
  call (which needs `getInfo`) return 403.

yt-dlp's pinned issue #10128 describes exactly this: an IP blocked while logged out,
where a PO token provider "will not help if your IP is already blocked". The
documented remedies are a different egress IP, or authenticated cookies — the latter
risking the account.

### Net result on Render free

| Feature | Status |
| --- | --- |
| Search (songs, videos, albums, artists, playlists) | ✅ works |
| Playback | ❌ 403 from Google; needs a non-datacenter egress IP |
| Lyrics | ❌ needs `getInfo`, which is blocked |
| Resources | ✅ 149 MB resident — no longer the constraint |

Any host whose egress IP is not flagged, or a residential/ISP proxy in front of a
datacenter host, removes this. The application itself is complete: it runs
end-to-end locally with zero console errors.
