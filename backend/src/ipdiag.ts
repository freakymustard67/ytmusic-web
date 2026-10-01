/**
 * One-shot IP diagnostics: which InnerTube clients can fetch a player response
 * from this host? Exposed temporarily at /api/ipdiag to debug datacenter-IP
 * behaviour without shell access to the container.
 */
import { Innertube, Log } from 'youtubei.js';
import { getMinter } from './sabr.js';

Log.setLevel(Log.Level.NONE);

const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

interface Result {
  client: string;
  status?: string;
  formats?: number;
  sabr?: boolean;
  error?: string;
  playerHttp?: number;
  visitorData?: string;
}

export async function probeClients(videoId: string): Promise<Result[]> {
  const out: Result[] = [];
  const clients = ['WEB', 'MWEB', 'TV', 'VISIONOS', 'ANDROID_VR', 'WEB_EMBEDDED_PLAYER', 'IOS'] as const;

  for (const client of clients) {
    const r: Result = { client };
    try {
      const yt = await Innertube.create({ retrieve_player: false, client_type: client as never }).catch((e) => {
        r.error = `create: ${String(e.message).slice(0, 80)}`;
        return null;
      });
      if (!yt) {
        out.push(r);
        continue;
      }
      const ctx = yt.session.context.client;
      r.visitorData = ctx.visitorData ? `${ctx.visitorData.slice(0, 12)}…` : '(none)';
      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${yt.session.api_key}&prettyPrint=false`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': UA_WEB,
            origin: 'https://www.youtube.com',
            referer: 'https://www.youtube.com/',
          },
          body: JSON.stringify({
            context: { client: { ...ctx, hl: 'en', gl: 'US' } },
            videoId,
            contentCheckOk: true,
            racyCheckOk: true,
            playbackContext: { contentPlaybackContext: { signatureTimestamp: 0 } },
          }),
        },
      );
      r.playerHttp = res.status;
      if (!res.ok) {
        r.error = `player HTTP ${res.status}`;
        out.push(r);
        continue;
      }
      const j: any = await res.json();
      r.status = j.playabilityStatus?.status;
      r.formats = (j.streamingData?.adaptiveFormats ?? []).length;
      r.sabr = !!j.streamingData?.serverAbrStreamingUrl;
      if (!r.formats) {
        r.error = String(
          j.playabilityStatus?.reason ?? j.playabilityStatus?.errorScreen?.playerErrorMessageRenderer?.reason?.simpleText ?? '',
        ).slice(0, 80);
      }
    } catch (err) {
      r.error = String((err as Error).message).slice(0, 100);
    }
    out.push(r);
  }
  return out;
}

/** Does minting a PoToken work from this IP, and does it change the outcome? */
export async function probePoToken(): Promise<{ ok: boolean; length?: number; error?: string }> {
  try {
    const minter = await getMinter();
    const token = await minter.mint('dQw4w9WgXcQ');
    return { ok: true, length: token.length };
  } catch (err) {
    return { ok: false, error: String((err as Error).message).slice(0, 200) };
  }
}
