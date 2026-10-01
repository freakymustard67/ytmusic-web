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
export async function probeYouTubeEndpoints(videoId: string): Promise<{
  identity: { clientName: string; clientVersion: string; hasVisitor: boolean };
  browse: { ok: boolean; status: number };
  player: { ok: boolean; status: number };
  /** The same player call the SABR path makes, for a like-for-like comparison. */
  playerViaSabrPath: { ok: boolean; status: number; note: string };
}> {
  const { Innertube } = await import('youtubei.js');
  const yt = await Innertube.create({ retrieve_player: false });
  const key = yt.session.api_key;
  const client = yt.session.context.client;
  // Which client identity is being used matters: per-client policies differ.
  const identity = { clientName: client.clientName, clientVersion: client.clientVersion, hasVisitor: !!client.visitorData };

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
    });
    return res.status;
  };

  const [browseStatus, playerStatus] = await Promise.all([
    post('browse', { browseId: 'FEwhat_to_watch' }).catch(() => 0),
    post('player', {
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: { contentPlaybackContext: { signatureTimestamp: 0 } },
    }).catch(() => 0),
  ]);

  // Reproduce the SABR path exactly: retrieve_player:true session + parsed call
  // through the NavigationEndpoint, which is what 403'd in production.
  let sabrStatus = 0;
  let note = '';
  try {
    const { getPlayerInfo } = await import('./sabr.js');
    const info = await getPlayerInfo(videoId);
    sabrStatus = info.status === 'OK' ? 200 : 0;
    note = `status=${info.status} formats=${info.formats.length}`;
  } catch (err) {
    note = String((err as Error).message).slice(0, 160);
  }

  return {
    identity,
    browse: { ok: browseStatus === 200, status: browseStatus },
    player: { ok: playerStatus === 200, status: playerStatus },
    playerViaSabrPath: { ok: sabrStatus === 200, status: sabrStatus, note },
  };
}
