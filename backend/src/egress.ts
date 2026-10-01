/**
 * Egress identity diagnostics.
 *
 * YouTube refuses `/youtubei/v1/player` from IPs it distrusts while still
 * answering `/youtubei/v1/browse` from the same address, so "does playback work"
 * depends entirely on which address the process egresses from. These helpers
 * report what that address actually is, and let the operator pin IPv4 vs IPv6 —
 * DNS for youtube.com returns AAAA first, so a host with working IPv6 may reach
 * YouTube over v6 while every other dependency goes over v4.
 *
 * See docs/FINDINGS.md §12.
 */

import { setDefaultResultOrder } from 'node:dns';

export type EgressFamily = 'auto' | 'ipv4' | 'ipv6';

let applied: EgressFamily = 'auto';

/**
 * Pin the address family used for outbound connections.
 *
 * `ipv4first` / `verbatim` change only the *ordering* of DNS results, so the
 * resolver still works when one family is unavailable.
 */
export function applyEgressFamily(family: EgressFamily): void {
  applied = family;
  if (family === 'ipv4') setDefaultResultOrder('ipv4first');
  else if (family === 'ipv6') setDefaultResultOrder('verbatim');
  else setDefaultResultOrder('verbatim');
}

export function egressFamily(): EgressFamily {
  return applied;
}

async function fetchText(url: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const ctl = AbortSignal.timeout(timeoutMs);
    const res = await fetch(url, { signal: ctl });
    if (!res.ok) return null;
    return (await res.text()).trim();
  } catch {
    return null;
  }
}

export interface EgressInfo {
  family: EgressFamily;
  ipv4: string | null;
  ipv6: string | null;
  /** Org / ASN behind the outbound address, when a lookup service answers. */
  org: string | null;
  country: string | null;
  /** True when a public address lookup itself failed (no egress at all). */
  unreachable: boolean;
}

export async function egressInfo(): Promise<EgressInfo> {
  const [ipv4, ipv6, ipinfoRaw] = await Promise.all([
    fetchText('https://api.ipify.org'),
    fetchText('https://api64.ipify.org').then(async (v) => {
      // api64 returns whichever family it prefers; only report it when it is v6.
      if (v && v.includes(':')) return v;
      return (await fetchText('https://v6.ident.me')) ?? (v && v.includes(':') ? v : null);
    }),
    fetchText('https://ipinfo.io/json'),
  ]);

  let org: string | null = null;
  let country: string | null = null;
  if (ipinfoRaw) {
    try {
      const j = JSON.parse(ipinfoRaw);
      org = j.org ?? null;
      country = j.country ?? null;
    } catch {
      /* not JSON; ignore */
    }
  }

  return {
    family: applied,
    ipv4,
    ipv6,
    org,
    country,
    unreachable: !ipv4 && !ipv6,
  };
}

/**
 * Can this process complete the two calls playback depends on?
 *
 * `browse` stands in for search (known to survive IP distrust) and `player` for
 * playback (known to be refused). Reporting both together makes an IP problem
 * unambiguous rather than looking like an application bug.
 */
interface ProbeCacheEntry {
  at: number;
  value: Awaited<ReturnType<typeof probeYouTubeEndpointsUncached>>;
}

const probeCache = new Map<string, ProbeCacheEntry>();
const PROBE_TTL_MS = 30 * 60_000;

/**
 * Cached probe.
 *
 * From an IP YouTube refuses, the player request hangs rather than failing, so an
 * uncached probe costs the full timeout. The verdict changes slowly, so it is
 * cached and also warmed at startup — making /api/egress instant in practice.
 */
export async function probeYouTubeEndpoints(videoId: string) {
  const hit = probeCache.get(videoId);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;
  const value = await probeYouTubeEndpointsUncached(videoId);
  probeCache.set(videoId, { at: Date.now(), value });
  return value;
}

/** Kick off a probe without waiting, so the first real request is fast. */
export function warmProbe(videoId: string): void {
  void probeYouTubeEndpoints(videoId).catch(() => {});
}

async function probeYouTubeEndpointsUncached(videoId: string): Promise<{
  identity: { clientName: string; clientVersion: string; hasVisitor: boolean };
  browse: { ok: boolean; status: number; playability: string };
  player: { ok: boolean; status: number; playability: string };
  /** The same player call the SABR path makes, for a like-for-like comparison. */
  playerViaSabrPath: { ok: boolean; status: number; note: string };
}> {
  const { Innertube } = await import('youtubei.js');
  const yt = await Innertube.create({ retrieve_player: false });
  const key = yt.session.api_key;
  const client = yt.session.context.client;
  // Which client identity is being used matters: per-client policies differ.
  const identity = { clientName: client.clientName, clientVersion: client.clientVersion, hasVisitor: !!client.visitorData };

  /** Returns HTTP status AND the playability status, since a bot-gate block is
   *  served with HTTP 200 — checking the status code alone misreports it. */
  /** A blocked IP can make these requests hang indefinitely, which on a small
   *  instance gets the process killed. Always bound them. */
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`https://www.youtube.com/youtubei/v1/${path}?key=${key}&prettyPrint=false`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        origin: 'https://www.youtube.com',
        referer: 'https://www.youtube.com/',
      },
      body: JSON.stringify({ context: { client: { ...client, hl: 'en', gl: 'US' } }, ...(body as object) }),
      signal: AbortSignal.timeout(15_000),
    });
    let playability = '';
    try {
      const j: any = await res.json();
      playability = j?.playabilityStatus?.status ?? j?.playability_status?.status ?? '';
    } catch {
      /* browse has no playability status; that is fine */
    }
    return { status: res.status, playability };
  };

  const [browseRes, playerRes] = await Promise.all([
    post('browse', { browseId: 'FEwhat_to_watch' }).catch(() => ({ status: 0, playability: '' })),
    post('player', {
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: { contentPlaybackContext: { signatureTimestamp: 0 } },
    }).catch(() => ({ status: 0, playability: '' })),
  ]);

  // Reproduce the SABR path exactly: retrieve_player:true session + parsed call
  // through the NavigationEndpoint, which is what 403'd in production.
  let sabrStatus = 0;
  let note = '';
  try {
    const { getPlayerInfo } = await import('./sabr.js');
    const info = await Promise.race([
      getPlayerInfo(videoId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('player probe timed out after 25s')), 25_000),
      ),
    ]);
    sabrStatus = info.status === 'OK' ? 200 : 0;
    note = `status=${info.status} formats=${info.formats.length}`;
  } catch (err) {
    note = String((err as Error).message).slice(0, 160);
  }

  // "ok" must mean playable, not merely HTTP 200.
  return {
    identity,
    browse: { ok: browseRes.status === 200, status: browseRes.status, playability: browseRes.playability },
    player: {
      ok: playerRes.status === 200 && playerRes.playability === 'OK',
      status: playerRes.status,
      playability: playerRes.playability || '(none)',
    },
    playerViaSabrPath: { ok: sabrStatus === 200, status: sabrStatus, note },
  };
}
