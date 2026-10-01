/**
 * SABR playback engine — server-side, no browser.
 * ==============================================
 *
 * YouTube's web clients no longer expose direct `adaptiveFormats[].url` values:
 * they are SABR-only ("server-side adaptive bitrate"), and `streaming_data`
 * carries a `serverAbrStreamingUrl` instead. Asking youtubei.js for a URL now
 * fails outright, and any URL resolved from an older client is either ciphered or
 * rejected with HTTP 403.
 *
 * The working approach is to speak SABR directly, which is what the page player
 * does. That means:
 *
 *   1. Ask the WEB client for a player response (this yields `serverAbrStreamingUrl`,
 *      a `videoPlaybackUstreamerConfig`, and format metadata).
 *   2. Mint a BotGuard PoToken bound to the **video id** — for SABR the token goes
 *      inside the protobuf request body, not in a `?pot=` query parameter.
 *   3. Drive `SabrStream`, which POSTs to the SABR endpoint and hands back a
 *      ReadableStream of already-demuxed WebM/Opus audio.
 *
 * Because this needs no headless browser it runs in ~100 MB of RAM instead of
 * ~800 MB, which is what makes deployment on a small free instance viable. See
 * docs/FINDINGS.md §10.
 */

import { Innertube, Platform, Log, YTNodes, Constants, ClientType } from 'youtubei.js';
import { SabrStream, type SabrPlaybackOptions } from 'googlevideo/sabr-stream';
import { buildSabrFormat } from 'googlevideo/utils';
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { parseLooseJSON } from 'bgutils-js/utils';
import { installProxy } from './proxy.js';
import { JSDOM } from 'jsdom';
import { Readable } from 'node:stream';

Log.setLevel(Log.Level.NONE);

/** BotGuard request key used by the YouTube web player. Note the capital O. */
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export interface SabrFormatLite {
  itag: number;
  mimeType?: string;
  bitrate: number;
  approxDurationMs?: number;
  contentLength?: number;
}

/* ------------------------------------------------------------------ */
/* BotGuard / PoToken                                                  */
/* ------------------------------------------------------------------ */

interface Minter {
  mint: (contentBinding: string) => Promise<string>;
  createdAt: number;
}

let cachedMinter: Minter | null = null;

/**
 * Build a PoToken minter from the challenge embedded in YouTube's own HTML.
 *
 * The challenge must come from the page (`window.ytAtN`), not from an InnerTube
 * `att/get` call: InnerTube challenges are currently broken for the web_music
 * client, which yields tokens that are rejected. Everything here runs in Node —
 * jsdom only provides the globals BotGuard's interpreter expects.
 */
async function createMinter(): Promise<Minter> {
  installProxy();
  const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
    url: 'https://www.youtube.com',
    referrer: 'https://www.youtube.com/',
  });
  // jsdom's ConstructorOptions has no userAgent here; set it directly.
  Object.defineProperty(dom.window.navigator, 'userAgent', { value: USER_AGENT, configurable: true });

  const html = await (
    await fetch('https://www.youtube.com', {
      headers: { accept: '*/*', 'accept-language': 'en-US,en;q=0.7', 'user-agent': USER_AGENT },
    })
  ).text();

  const ytcfgRaw = html.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
  if (ytcfgRaw) dom.window.yt = { config_: JSON.parse(ytcfgRaw) };

  // BotGuard probes canvas; a stub keeps it from throwing.
  dom.window.HTMLCanvasElement.prototype.getContext = function (id: string) {
    if (id !== '2d') return null;
    const noop = () => {};
    return {
      fillRect: noop, clearRect: noop,
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: noop, createImageData: () => [], setTransform: noop, drawImage: noop, save: noop,
      fillText: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop,
      stroke: noop, translate: noop, scale: noop, rotate: noop, arc: noop, fill: noop,
      measureText: () => ({ width: 0 }), transform: noop, rect: noop, clip: noop,
    };
  } as never;

  Object.assign(globalThis, {
    yt: dom.window.yt,
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin,
  });
  if (!('navigator' in globalThis)) {
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  }

  const attMatch = html.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
  if (!attMatch) throw new Error('SABR: no ytAtN challenge in YouTube HTML');
  const attObj = parseLooseJSON(attMatch[1]) as Record<string, any>;
  const challenge =
    attObj?.R?.bgChallenge ?? attObj?.bgChallenge ?? attObj?.R?.challenge?.bgChallenge ?? null;
  if (!challenge?.program) throw new Error('SABR: challenge missing from ytAtN payload');

  const globalName = challenge.globalName || challenge.global_name;
  const interpreterWrapped =
    challenge.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue ??
    challenge.interpreter_url?.private_do_not_access_or_else_trusted_resource_url_wrapped_value;
  if (!interpreterWrapped) throw new Error('SABR: challenge has no interpreterUrl');

  const interpreterJs = await (
    await fetch(interpreterWrapped.startsWith('http') ? interpreterWrapped : `https:${interpreterWrapped}`)
  ).text();
  // Installs the BotGuard VM onto globalThis (jsdom window).
  new Function(interpreterJs)();

  const botguard = await BotGuardClient.create({ program: challenge.program, globalName, globalObject: globalThis });
  const webPoSignalOutput: any[] = [];
  const botguardResponse = await botguard.snapshot({ webPoSignalOutput });

  const itr = (await (
    await fetch('https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json+protobuf',
        'x-goog-api-key': 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw',
        'x-user-agent': 'grpc-web-javascript/0.1',
      },
      body: JSON.stringify([REQUEST_KEY, botguardResponse]),
    })
  ).json()) as [string, number, number, string];

  if (!Array.isArray(itr)) throw new Error('SABR: GenerateIT failed');

  const webPoMinter = await WebPoMinter.create(
    {
      integrityToken: itr[0],
      estimatedTtlSecs: itr[1],
      mintRefreshThreshold: itr[2],
      websafeFallbackToken: itr[3],
    },
    webPoSignalOutput,
  );

  return { mint: (binding: string) => webPoMinter.mintAsWebsafeString(binding), createdAt: Date.now() };
}

/** Reuse a minter for a while; minting is expensive and tokens last ~12h. */
export async function getMinter(): Promise<Minter> {
  const maxAgeMs = 30 * 60_000;
  if (cachedMinter && Date.now() - cachedMinter.createdAt < maxAgeMs) return cachedMinter;
  cachedMinter = await createMinter();
  return cachedMinter;
}

/* ------------------------------------------------------------------ */
/* InnerTube client                                                    */
/* ------------------------------------------------------------------ */

let innertube: Innertube | null = null;

async function getInnertube(): Promise<Innertube> {
  installProxy();
  if (innertube) return innertube;
  // n-sig deciphering needs a JS evaluator; youtubei.js ships none for Node.
  Platform.shim.eval = (async (data: { output: string }) => new Function(data.output)()) as never;
  // Match the reference implementation exactly: no client_type/lang/location
  // overrides. Changing them alters the SABR session and the stream never ends.
  innertube = await Innertube.create({ retrieve_player: true });
  return innertube;
}

export interface PlayerInfo {
  videoId: string;
  title: string;
  author: string;
  durationSec: number | null;
  status: string;
  sabrUrl: string | null;
  ustreamerConfig: string | null;
  formats: SabrFormatLite[];
}

/** Fetch a player response and the SABR parameters needed to stream it. */
export async function getPlayerInfo(videoId: string): Promise<PlayerInfo> {
  const yt = await getInnertube();
  const endpoint = new YTNodes.NavigationEndpoint({ watchEndpoint: { videoId } });
  const response: any = await endpoint.call(yt.actions, {
    playbackContext: {
      contentPlaybackContext: { vis: 0, splay: false, signatureTimestamp: yt.session.player?.signature_timestamp },
    },
    contentCheckOk: true,
    racyCheckOk: true,
    client: ClientType.WEB,
    parse: true,
  });

  const rawAbr: string | undefined = response.streaming_data?.server_abr_streaming_url;
  const sabrUrl = rawAbr ? ((await yt.session.player?.decipher(rawAbr).catch(() => null)) ?? rawAbr) : null;
  const ustreamerConfig =
    response.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config ?? null;
  const formats: SabrFormatLite[] = (response.streaming_data?.adaptive_formats ?? []).map((f: any) => ({
    itag: f.itag,
    mimeType: f.mime_type,
    bitrate: f.bitrate ?? f.average_bitrate ?? 0,
    approxDurationMs: f.approx_duration_ms,
    contentLength: f.content_length,
  }));

  return {
    videoId,
    title: response.video_details?.title ?? response.videoDetails?.title ?? '',
    author: response.video_details?.author ?? response.videoDetails?.author ?? '',
    durationSec:
      response.video_details?.duration ??
      (response.videoDetails?.lengthSeconds ? Number(response.videoDetails.lengthSeconds) : null),
    status: response.playability_status?.status ?? 'UNKNOWN',
    sabrUrl,
    ustreamerConfig,
    formats,
  };
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

export interface AudioStreamResult {
  stream: ReadableStream<Uint8Array>;
  itag: number;
  mimeType: string;
  durationMs: number;
}

/**
 * Start an audio-only SABR stream for a video. The caller consumes the returned
 * ReadableStream; chunks are already-demuxed WebM/Opus bytes, safe to concatenate.
 */

/**
 * Build everything a SABR session needs from a SINGLE player response.
 *
 * This matters: each `/player` call returns a different `serverAbrStreamingUrl`,
 * and driving a stream with a URL from an earlier response than the one whose
 * formats/ustreamer config you are using produces a stream that never terminates.
 */

/** Which client produced the last successful player response (for diagnostics). */
let lastClient = 'unknown';

export function getLastClient(): string {
  return lastClient;
}

/** Clients to try, best-first. Each needs a fresh Innertube session. */
const CLIENT_CHAIN: Array<{ id: string; label: string }> = [
  // WEB first: on a normal IP it yields a working SABR session. visionos is the
  // fallback that still answers from datacenter IPs (yt-dlp lists it as needing
  // no PoToken at all).
  { id: 'WEB', label: 'web' },
  { id: 'VISIONOS', label: 'visionos' },
  { id: 'ANDROID_VR', label: 'android_vr' },
];

const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * Ask /player until a client returns a usable response.
 *
 * Clients differ sharply by IP reputation: from a datacenter address, WEB is
 * commonly refused outright while visionos (which yt-dlp lists as needing no
 * PoToken) still answers.
 */
async function callPlayerWithFallback(
  yt: Innertube,
  videoId: string,
): Promise<{ response: any; clientLabel: string }> {
  const errors: string[] = [];

  for (const { id, label } of CLIENT_CHAIN) {
    try {
      const session = await Innertube.create({ retrieve_player: false, client_type: id as never });
      const client = session.session.context.client;
      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${session.session.api_key}&prettyPrint=false`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': UA_WEB,
            origin: 'https://www.youtube.com',
            referer: 'https://www.youtube.com/',
          },
          body: JSON.stringify({
            context: { client: { ...client, hl: 'en', gl: 'US' } },
            videoId,
            contentCheckOk: true,
            racyCheckOk: true,
            playbackContext: { contentPlaybackContext: { signatureTimestamp: yt.session.player?.signature_timestamp ?? 0 } },
          }),
        },
      );
      if (!res.ok) {
        errors.push(`${label}: HTTP ${res.status}`);
        continue;
      }
      const json: any = await res.json();
      const status = readPlayability(json);
      const sd = readStreamingData(json) ?? {};
      const hasAbr = !!(sd.serverAbrStreamingUrl ?? sd.server_abr_streaming_url);
      const nFormats = (sd.adaptiveFormats ?? sd.adaptive_formats ?? []).length;
      if (status === 'OK' && hasAbr && nFormats > 0) {
        return { response: json, clientLabel: label };
      }
      errors.push(`${label}: ${status ?? 'no status'}`);
    } catch (err) {
      errors.push(`${label}: ${String((err as Error).message).slice(0, 60)}`);
    }
  }
  throw new Error(`SABR: no usable client (${errors.join('; ')})`);
}

/* ---------------------- tolerant player-response accessors ----------------------
 * The parsed endpoint hands back camelCase nodes while the raw POST returns the
 * wire format; different clients also differ. These two helpers let the rest of
 * the module read either without guessing.
 */
function readStreamingData(j: any): any {
  return j?.streaming_data ?? j?.streamingData ?? null;
}
function readPlayability(j: any): string {
  return j?.playability_status?.status ?? j?.playabilityStatus?.status ?? 'UNKNOWN';
}

/**
 * Kept for the parsed-endpoint shape; the raw API needs no normalisation.
 */
function normalisePlayer(json: any): any {
  if (json.streaming_data || json.playability_status) {
    // already snake_case from the raw API — map the fields we use
    return {
      playability_status: json.playability_status,
      streaming_data: {
        server_abr_streaming_url: json.streaming_data?.serverAbrStreamingUrl,
        adaptive_formats: json.streaming_data?.adaptiveFormats ?? [],
      },
      player_config: {
        media_common_config: {
          media_ustreamer_request_config: {
            video_playback_ustreamer_config:
              json.player_config?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig,
          },
        },
      },
      video_details: {
        title: json.videoDetails?.title,
        author: json.videoDetails?.author,
        duration: json.videoDetails?.lengthSeconds ? Number(json.videoDetails.lengthSeconds) : null,
      },
    };
  }
  return json;
}

async function createSabrSession(videoId: string): Promise<{
  yt: Innertube;
  info: PlayerInfo;
  sabr: SabrStream;
  sabrFormats: ReturnType<typeof buildSabrFormat>[];
}> {
  const yt = await getInnertube();

  // Try clients in order of how well they work from datacenter IPs. visionos
  // needs no PoToken at all per yt-dlp's client policy table; WEB is preferred
  // when it works but is SABR-only and IP-sensitive.
  const attempts = await callPlayerWithFallback(yt, videoId);
  const { response, clientLabel } = attempts;
  lastClient = clientLabel;

  const status = readPlayability(response);
  if (status !== 'OK') throw new Error(`SABR: video not playable (${status}) via ${clientLabel}`);

  const streaming = readStreamingData(response) ?? {};
  const rawAbr: string | undefined = streaming.server_abr_streaming_url ?? streaming.serverAbrStreamingUrl;
  const sabrUrl = rawAbr ? ((await yt.session.player?.decipher(rawAbr).catch(() => null)) ?? rawAbr) : null;
  const ustreamerConfig =
    response.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config ??
    response.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig ??
    null;
  if (!sabrUrl || !ustreamerConfig) throw new Error(`SABR: no SABR parameters via ${clientLabel}`);

  // Pass the raw formats straight through: buildSabrFormat already expects the
  // player response's own shape.
  const rawFormats: any[] = streaming.adaptive_formats ?? streaming.adaptiveFormats ?? [];
  const sabrFormats = rawFormats.map((f: any) => buildSabrFormat(f));
  const info: PlayerInfo = {
    videoId,
    title: response.video_details?.title ?? response.videoDetails?.title ?? '',
    author: response.video_details?.author ?? response.videoDetails?.author ?? '',
    durationSec:
      response.video_details?.duration ??
      (response.videoDetails?.lengthSeconds ? Number(response.videoDetails.lengthSeconds) : null),
    status,
    sabrUrl,
    ustreamerConfig,
    formats: rawFormats.map((f: any) => ({
      itag: f.itag,
      mimeType: f.mime_type ?? f.mimeType,
      bitrate: f.bitrate ?? f.average_bitrate ?? f.averageBitrate ?? 0,
      approxDurationMs: f.approx_duration_ms ?? f.approxDurationMs,
      contentLength: f.content_length ?? f.contentLength,
    })),
  };

  const minter = await getMinter();
  const ids = Constants.CLIENT_NAME_IDS as Record<string, string>;
  const clientName = parseInt(ids[yt.session.context.client.clientName as string] ?? '1', 10);
  const clientVersion = yt.session.context.client.clientVersion;

  const sabr = new SabrStream({
    serverAbrStreamingUrl: sabrUrl,
    videoPlaybackUstreamerConfig: ustreamerConfig,
    clientInfo: { clientName, clientVersion },
    formats: sabrFormats,
    // For SABR the PoToken is bound to the video id and travels in the POST body.
    poToken: await minter.mint(videoId),
  });

  return { yt, info, sabr, sabrFormats };
}

export async function openAudioStream(videoId: string): Promise<AudioStreamResult> {
  const session = await createSabrSession(videoId);
  const { yt, info, sabr, sabrFormats } = session;

  // selectFormats() insists on BOTH a video and an audio pick, so supply explicit
  // selectors: highest-bitrate audio, plus any video (discarded for audio-only).
  const pickAudio = (fs: SabrFormatLite[]) =>
    fs.filter((f) => f.mimeType?.includes('audio')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  const pickVideo = (fs: SabrFormatLite[]) =>
    fs.filter((f) => f.mimeType?.includes('video')).sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0))[0];

  const audioFormat = pickAudio(info.formats);
  if (!audioFormat) throw new Error('SABR: no audio format offered');

  const options: SabrPlaybackOptions = {
    audioFormat: pickAudio as never,
    videoFormat: pickVideo as never,
    preferWebM: true,
    // EnabledTrackTypes.AUDIO_ONLY
    enabledTrackTypes: 1,
  };

  const { audioStream, selectedFormats } = await sabr.start(options);

  return {
    stream: audioStream,
    itag: selectedFormats.audioFormat?.itag ?? audioFormat.itag,
    mimeType: selectedFormats.audioFormat?.mimeType ?? audioFormat.mimeType ?? 'audio/webm',
    durationMs: Number(audioFormat.approxDurationMs) || 0,
  };
}

/** Convenience: collect a whole track into one Buffer (used for downloads/caching). */
export async function fetchTrackBuffer(videoId: string, maxMs = 120_000, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  const { stream } = await openAudioStream(videoId);
  const reader = stream.getReader();
  const parts: Buffer[] = [];
  let total = 0;
  const started = Date.now();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        parts.push(Buffer.from(value));
        total += value.length;
        // A music track is a few MB; anything far larger means the stream is not
        // terminating, so stop rather than filling the disk.
        if (total > maxBytes) break;
      }
      if (Date.now() - started > maxMs) break;
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(parts);
}

/** Convert a web ReadableStream into a Node Readable for HTTP responses. */
export function toNodeReadable(stream: ReadableStream<Uint8Array>): Readable {
  const reader = stream.getReader();
  return new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) this.push(null);
        else this.push(Buffer.from(value));
      } catch (err) {
        this.destroy(err as Error);
      }
    },
    destroy(err: Error | null, cb: (e?: Error | null) => void) {
      reader.cancel().catch(() => {});
      cb(err);
    },
  });
}
