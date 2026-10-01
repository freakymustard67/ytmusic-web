# Getting past the egress-IP block (without using your home connection)

## The problem, precisely

YouTube classifies the **address class** of whoever calls `/youtubei/v1/player`.
From a datacenter address it answers `LOGIN_REQUIRED` (served as HTTP 200, so
status-code checks lie) while `/youtubei/v1/browse` still works from the same IP.
PoToken minting also still succeeds — so this is not a token problem and not an
outright IP ban.

Measured on Render (`74.220.52.132`, AS16509 Amazon, Singapore):

| | Render IP | Home connection |
| --- | --- | --- |
| `/browse` (search) | 200 | 200 |
| `/player` (playback) | `LOGIN_REQUIRED` | `OK` |
| PoToken minting | works | works |

Same code, same tokens. The only difference is the address class. Verify your own
host at any time:

```bash
curl -s "http://localhost:10000/api/egress" | jq .verdict
```

## Option A — rotate IPv6 inside a routed /64 (free, no home connection)

This is the method Invidious documents for escaping YouTube blocking, and it is
the only free approach that does not involve your home line. It works because the
block is a reputation judgement about an *address*, so a fresh address from a
prefix you control starts clean.

**Requirement that decides everything:** your provider must route a whole `/64`
(or larger) to your machine so you can source from arbitrary addresses inside it.
Many providers give you a single `/128`, which is useless here. The
`smart-ipv6-rotator` project explicitly notes that providers including AWS, Google
Cloud, Oracle Cloud and Azure do **not** support arbitrary addressing.

### Configuration

```bash
EGRESS_IPV6_PREFIX=2001:db8:1234:5678::/64   # your routed prefix
EGRESS_IPV6_POOL=4                            # addresses kept warm
EGRESS_IPV6_ROTATE_HOURS=6                    # re-lease interval
```

How it behaves:

- each **playback session** is pinned to one address for its whole lifetime;
- the address is emitted as the IPv6 **source** address, so no `ip addr add` or
  root access is needed when the prefix is already routed;
- an address that produces `LOGIN_REQUIRED` or a 403 is marked burned and never
  reused;
- with no prefix configured the whole mechanism is inert (verified: playback still
  works normally).

### Why pinning is not optional

The `videoplayback` URL is signed and carries `ip=` in its parameters. Negotiate
the stream from one address and fetch the media from another and you get a **silent
media-only 403** — the classic failure of rotating proxy pools. One address per
session, end to end.

### Verifying it took effect

```bash
curl -s "http://localhost:10000/api/diagnostics" | jq .egressIpv6
# { "configured": true, "prefix": "2001:db8:1234:5678::", "poolSize": 4, "leases": [...] }
```

## Option B — a static residential/ISP proxy (cheap, hands-off)

If you would rather pay a few dollars than manage a prefix, point `HTTPS_PROXY` at
a **sticky** residential IP. Our code routes every outbound request — YouTube,
BotGuard and googlevideo — through it, which is required for the same
address-consistency reason.

| Provider | Price | Notes |
| --- | --- | --- |
| Webshare Static Residential | **$0.30/IP, 20-IP minimum = $6/mo** | unlimited bandwidth, HTTP + SOCKS5 |
| Evomi Static Residential | $1.00/IP | unlimited bandwidth, 30-day refund |
| Bright Data ISP | $1.80/IP, 10 minimum | 100 GB fair-use per IP |
| IPRoyal ISP | $2.70/30 days | HTTP(S) + SOCKS5 |

Avoid **NetNut** (seized by the FBI — their site serves the seizure banner),
**Oxylabs ISP** (explicitly restricts streaming targets) and **SOAX** ($200/mo
minimum). Prefer per-IP over per-GB pricing: audio is ~60 MB/hour, so per-GB
billing (≈$2–4/mo at 2 h/day) is workable but less predictable.

## Option C — run it where the egress is consumer-grade

Any cheap VPS on a consumer/ISP-registered block, or a host that sells "ISP" or
"residential" IPs, removes the problem entirely with no proxy. `scripts/install.sh`
deploys to any Debian/Ubuntu box and verifies playback from that host as its last
step.

## What does not work

- **A single static IPv6 address.** IPv6 is itself listed by yt-dlp maintainers as
  a 403 trigger; only *rotation within a routed prefix* helps.
- **Rotating per request.** Breaks the `ip=`-signed media URL.
- **Passing cookies.** yt-dlp's own guidance: it "may get your account blocked",
  and the safer fix is a different IP. There is no evidence Premium bypasses an IP
  block either — the confirmed Premium exemption is from *PoToken* requirements,
  which is a different gate.
- **A PO Token provider alone.** It fixes the *token binding* (which we implement),
  but not an address-class refusal.
- **The sanctioned API.** YouTube Data API v3 has no method that returns audio;
  its only download endpoint returns caption tracks.

## Honest caveats

- No published figure exists for how long a fresh address survives. Invidious
  rotates its own egress **twice daily**, which is a production team's revealed
  estimate of an address's useful life — treat rotation as routine upkeep, not a
  one-off fix, and keep a second address warm.
- Back off on the first 403/429 rather than retrying; retry storms turn a soft rate
  limit into a hard flag.
- All of this circumvents YouTube's technical restrictions, which their Terms of
  Service prohibit. The only compliant paths are the official embedded player or
  licensing the catalogue.
