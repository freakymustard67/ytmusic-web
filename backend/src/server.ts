/**
 * HTTP API + audio streaming.
 *
 * Endpoints
 *   GET  /health                     liveness + cache stats
 *   GET  /api/search?q=&type=        songs / videos / albums / artists / playlists
 *   GET  /api/track/:videoId         track metadata
 *   GET  /api/lyrics/:videoId        time-synced lyrics
 *   GET  /api/upnext/:videoId        queue continuation
 *   POST /api/play/:videoId          warm the cache, report readiness
 *   GET  /api/stream/:videoId        audio (byte-range capable)
 *   GET  /api/download/:videoId      whole track as WebM/Opus
 *   GET  /api/stats                  bandwidth + cache counters
 *   GET  /api/diagnostics            environment + SABR health
 *
 * No headless browser is involved: playback goes through YouTube's SABR protocol
 * directly (see sabr.ts), which keeps resident memory near ~100 MB.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { getLyrics } from './lyrics.js';
import { TrackService } from './tracks.js';
import { openAudioStream, toNodeReadable } from './sabr.js';
import { getTrack, getUpNext, search, yt } from './ytmusic.js';

const tracks = new TrackService({
  cacheDir: config.cacheDir || undefined,
  cacheMaxBytes: config.cacheMaxBytes,
  fetchMaxMs: config.fetchMaxMs,
  maxConcurrent: config.maxConcurrentFetches,
});

tracks.on('warn', (w) => console.warn('[tracks]', JSON.stringify(w)));

/* ------------------------------- guards -------------------------------- */

let bytesOut = 0;
const hitsByIp = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = hitsByIp.get(ip);
  if (!rec || now > rec.resetAt) {
    hitsByIp.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  rec.count++;
  return rec.count > config.rateLimitPerMin;
}

function overBudget(): boolean {
  return config.bandwidthCapBytes > 0 && bytesOut >= config.bandwidthCapBytes;
}

function accountBytes(n: number): void {
  bytesOut += n;
  if (config.bandwidthCapBytes > 0 && bytesOut >= config.bandwidthCapBytes) {
    console.warn(
      `[bandwidth] cap reached: ${(bytesOut / 1024 ** 3).toFixed(2)} GB of ` +
        `${(config.bandwidthCapBytes / 1024 ** 3).toFixed(2)} GB`,
    );
  }
}

/* ------------------------------ helpers -------------------------------- */

function clientIp(req: FastifyRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.ip;
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = header.match(/bytes=(\d*)-(\d*)/);
  if (!m) return null;
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start, end: Math.min(end, size - 1) };
}

/* ------------------------------- server -------------------------------- */

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 1024 * 1024 });

  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') });

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url;
    if (!url.startsWith('/api/') || url === '/api/health') return;
    if (rateLimited(clientIp(req))) {
      reply.code(429).send({ error: 'rate limited, slow down' });
      return reply;
    }
    if ((url.startsWith('/api/stream') || url.startsWith('/api/download')) && overBudget()) {
      reply.code(503).send({
        error: 'bandwidth budget exhausted',
        detail: 'Set BANDWIDTH_CAP_GB higher, or restart the service to reset the counter.',
      });
      return reply;
    }
    if (config.accessPassword) {
      const supplied = req.headers['x-access-password'] ?? (req.query as any)?.pw;
      if (supplied !== config.accessPassword) {
        reply.code(401).send({ error: 'unauthorised' });
        return reply;
      }
    }
  });

  app.get('/health', async () => ({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    ...tracks.stats(),
  }));

  app.get('/api/health', async () => ({ ok: true }));

  /** Environment + SABR health. Pass ?videoId=… to prove a track can be fetched. */
  app.get('/api/diagnostics', async (req) => {
    const probeId = String((req.query as any)?.videoId ?? '');
    const base = {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      cacheDir: config.cacheDir || '(disabled)',
      staticDir: config.staticDir || '(none)',
      bandwidthCapBytes: config.bandwidthCapBytes,
      ...tracks.stats(),
    };
    if (!probeId) return { ...base, hint: 'pass ?videoId=… to test SABR negotiation' };
    try {
      const started = Date.now();
      const buf = await tracks.fetch(probeId);
      return { ...base, sabr: 'ok', videoId: probeId, bytes: buf.length, ms: Date.now() - started };
    } catch (err) {
      return { ...base, sabr: 'failed', videoId: probeId, error: (err as Error).message.slice(0, 300) };
    }
  });

  app.get('/api/stats', async () => ({
    bytesOut,
    bytesOutHuman: `${(bytesOut / 1024 ** 2).toFixed(1)} MB`,
    capBytes: config.bandwidthCapBytes,
    capHuman: config.bandwidthCapBytes ? `${(config.bandwidthCapBytes / 1024 ** 3).toFixed(2)} GB` : 'unlimited',
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    ...tracks.stats(),
  }));

  app.get('/api/search', async (req, reply) => {
    const q = String((req.query as any)?.q ?? '').trim();
    const type = String((req.query as any)?.type ?? 'all') as 'song' | 'video' | 'all';
    if (!q) {
      reply.code(400).send({ error: 'missing q' });
      return reply;
    }
    try {
      return await search(q, type);
    } catch (err) {
      req.log.error({ err }, 'search failed');
      reply.code(502).send({ error: 'search failed', detail: (err as Error).message });
      return reply;
    }
  });

  app.get('/api/track/:videoId', async (req, reply) => {
    const { videoId } = req.params as { videoId: string };
    const track = await getTrack(videoId);
    if (!track) {
      reply.code(404).send({ error: 'not found' });
      return reply;
    }
    return track;
  });

  app.get('/api/lyrics/:videoId', async (req, reply) => {
    const { videoId } = req.params as { videoId: string };
    const q = req.query as any;
    const meta = q.title
      ? {
          title: String(q.title),
          artists: String(q.artist ?? '')
            .split(',')
            .filter(Boolean),
          album: q.album ?? null,
          durationSec: q.duration ? Number(q.duration) : null,
        }
      : await getTrack(videoId).then((t) =>
          t ? { title: t.title, artists: t.artists, album: t.album, durationSec: t.durationSec } : undefined,
        );
    const lyrics = await getLyrics(videoId, meta ?? undefined);
    if (!lyrics) {
      reply.code(404).send({ error: 'no lyrics', videoId });
      return reply;
    }
    return lyrics;
  });

  app.get('/api/upnext/:videoId', async (req) => {
    const { videoId } = req.params as { videoId: string };
    const limit = Number((req.query as any)?.limit ?? 25);
    return { tracks: await getUpNext(videoId, Math.min(Math.max(limit, 1), 50)) };
  });

  /**
   * Warm the cache. SABR is a sequential stream with no random access, so a track
   * is downloaded once and then served from disk — that is also what makes
   * seeking possible.
   */
  app.post('/api/play/:videoId', async (req, reply) => {
    const { videoId } = req.params as { videoId: string };
    try {
      if (await tracks.isCached(videoId)) {
        return { videoId, ready: true, cached: true, streamUrl: `/api/stream/${videoId}` };
      }
      tracks.prefetch(videoId);
      return { videoId, ready: false, cached: false, streamUrl: `/api/stream/${videoId}` };
    } catch (err) {
      req.log.error({ err, videoId }, 'play failed');
      reply.code(502).send({ error: 'could not start playback', detail: (err as Error).message });
      return reply;
    }
  });

  /** Audio stream, cache-backed so byte ranges (seeking) work. */
  app.get('/api/stream/:videoId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { videoId } = req.params as { videoId: string };
    let audio = await tracks.get(videoId);

    if (!audio) {
      try {
        audio = await tracks.fetch(videoId);
      } catch (err) {
        // Fall back to a live SABR stream so playback can still start.
        req.log.warn({ err, videoId }, 'cache fetch failed, streaming live');
        try {
          const { stream } = await openAudioStream(videoId);
          reply
            .code(200)
            .header('content-type', 'audio/webm')
            .header('accept-ranges', 'none')
            .header('cache-control', 'no-store');
          return reply.send(toNodeReadable(stream));
        } catch (err2) {
          reply.code(502).send({ error: 'could not fetch audio', detail: (err2 as Error).message });
          return reply;
        }
      }
    }

    if (!audio.length) {
      reply.code(502).send({ error: 'no audio available' });
      return reply;
    }

    const size = audio.length;
    const rangeHeader = req.headers.range as string | undefined;
    const range = parseRange(rangeHeader, size);
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;

    if (range && (start >= size || start > end)) {
      reply.code(416).header('content-range', `bytes */${size}`).send();
      return reply;
    }

    const slice = audio.subarray(start, end + 1);
    accountBytes(slice.length);
    reply
      .code(range ? 206 : 200)
      .header('content-type', 'audio/webm')
      .header('accept-ranges', 'bytes')
      .header('content-length', String(slice.length))
      .header('cache-control', 'public, max-age=3600');
    if (range) reply.header('content-range', `bytes ${start}-${end}/${size}`);
    return reply.send(Readable.from(slice));
  });

  /** Whole track as one downloadable file. */
  app.get('/api/download/:videoId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { videoId } = req.params as { videoId: string };
    try {
      const buf = await tracks.fetch(videoId);
      if (!buf.length) {
        reply.code(502).send({ error: 'no audio available' });
        return reply;
      }
      const track = await getTrack(videoId).catch(() => null);
      const safe = (track?.title ?? videoId).replace(/[^\w\-. ]+/g, '_').slice(0, 80);
      accountBytes(buf.length);
      return reply
        .header('content-type', 'audio/webm')
        .header('content-disposition', `attachment; filename="${safe}.webm"`)
        .header('content-length', String(buf.length))
        .send(buf);
    } catch (err) {
      req.log.error({ err, videoId }, 'download failed');
      reply.code(502).send({ error: 'download failed', detail: (err as Error).message });
      return reply;
    }
  });

  /* ------------------------- optional frontend ------------------------- */
  if (config.staticDir && existsSync(config.staticDir)) {
    const root = resolve(config.staticDir);
    await app.register(fastifyStatic, { root, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/health')) {
        reply.code(404).send({ error: 'not found' });
        return;
      }
      reply.type('text/html').send(createReadStream(resolve(root, 'index.html')));
    });
  }

  // Warm the metadata client in the background.
  void yt().catch(() => {});

  return app;
}
