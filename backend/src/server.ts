/**
 * HTTP API + streaming layer.
 *
 * Endpoints
 *   GET  /health                     liveness + session/browser stats
 *   GET  /api/search?q=&type=        songs / videos / albums / artists / playlists
 *   GET  /api/track/:videoId         track metadata
 *   GET  /api/lyrics/:videoId        time-synced lyrics
 *   GET  /api/upnext/:videoId        queue continuation
 *   POST /api/play/:videoId          negotiate playback, return a stream token
 *   GET  /api/stream/:videoId        proxied audio (supports Range)
 *   GET  /api/download/:videoId      whole track as WebM/Opus
 *   GET  /api/stats                  bandwidth + session counters
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { BrowserPool, type PlaybackSession } from './browser.js';
import { getLyrics } from './lyrics.js';
import { getTrack, getUpNext, search, yt } from './ytmusic.js';

const pool = new BrowserPool({
  chromiumPath: config.chromiumPath || undefined,
  headless: config.headless,
  maxSessions: config.maxSessions,
  sessionTtlMs: config.sessionTtlMs,
  browserIdleMs: config.browserIdleMs,
  userAgent: config.userAgent,
  negotiateTimeoutMs: config.negotiateTimeoutMs,
  cacheDir: config.cacheDir || undefined,
  cacheMaxBytes: config.cacheMaxBytes,
  captureMaxMs: config.captureMaxMs,
});

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
        `${(config.bandwidthCapBytes / 1024 ** 3).toFixed(2)} GB — refusing further streams`,
    );
  }
}

/* ------------------------------ helpers -------------------------------- */

function clientIp(req: FastifyRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.ip;
}

async function ensureSession(videoId: string): Promise<PlaybackSession> {
  return pool.acquire(videoId);
}

function parseRange(header: string | undefined, size: number | null): { start: number; end: number | null } | null {
  if (!header) return null;
  const m = header.match(/bytes=(\d*)-(\d*)/);
  if (!m) return null;
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? parseInt(m[2], 10) : size ? size - 1 : null;
  if (Number.isNaN(start)) return null;
  return { start, end };
}

/* ------------------------------- server -------------------------------- */

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // We stream audio bodies ourselves; do not let Fastify buffer them.
    bodyLimit: 1024 * 1024,
  });

  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') });

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url;
    if (!url.startsWith('/api/') || url === '/api/health') return;
    if (rateLimited(clientIp(req))) {
      reply.code(429).send({ error: 'rate limited, slow down' });
      return reply;
    }
    if (url.startsWith('/api/stream') || url.startsWith('/api/download')) {
      if (overBudget()) {
        reply.code(503).send({
          error: 'bandwidth budget exhausted',
          detail: 'The server reached BANDWIDTH_CAP_GB. Playback resumes when the cap is raised or the process restarts.',
        });
        return reply;
      }
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
    ...pool.stats(),
  }));

  app.get('/api/health', async () => ({ ok: true }));

  /** Deployment diagnostics: confirms the browser actually launched. */
  app.get('/api/diagnostics', async () => {
    const base = {
      chromiumPath: config.chromiumPath || '(auto-detect found nothing)',
      headless: config.headless,
      cacheDir: config.cacheDir || '(disabled)',
      staticDir: config.staticDir || '(none)',
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      ...pool.stats(),
    };
    try {
      const { chromium } = await import('playwright-core');
      const browser = await chromium.launch({
        executablePath: config.chromiumPath || undefined,
        headless: config.headless,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
      const version = browser.version();
      await browser.close();
      return { ...base, browserLaunch: 'ok', browserVersion: version };
    } catch (err) {
      return { ...base, browserLaunch: 'failed', browserError: (err as Error).message.slice(0, 400) };
    }
  });

  app.get('/api/stats', async () => ({
    bytesOut,
    bytesOutHuman: `${(bytesOut / 1024 ** 2).toFixed(1)} MB`,
    capBytes: config.bandwidthCapBytes,
    capHuman: config.bandwidthCapBytes ? `${(config.bandwidthCapBytes / 1024 ** 3).toFixed(2)} GB` : 'unlimited',
    uptimeSec: Math.round(process.uptime()),
    ...pool.stats(),
  }));

  /**
   * Lightweight deployment probe.
   *
   * Deliberately minimal: Render's free instance has 512 MB, and a heavy probe
   * that opens several renderers can OOM the container. This one opens a single
   * page, blocks images/fonts, and reports how far the player gets.
   */
  app.get('/api/probe/:videoId', async (req) => {
    const { videoId } = req.params as { videoId: string };
    const { chromium } = await import('playwright-core');
    const out: Record<string, unknown> = {};
    let browser;
    try {
      browser = await chromium.launch({
        executablePath: config.chromiumPath || undefined,
        headless: config.headless,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
      });
      const ctx = await browser.newContext({ userAgent: config.userAgent, viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      // Block heavy resources: music playback needs none of them.
      await page.route('**/*', async (route) => {
        const type = route.request().resourceType();
        if (type === 'image' || type === 'font' || type === 'stylesheet' || type === 'media') {
          await route.abort();
          return;
        }
        await route.continue();
      });
      let audioCount = 0;
      page.on('request', (r) => {
        const u = r.url();
        if (/googlevideo\.com\/videoplayback/.test(u) && /mime=audio/.test(u)) audioCount++;
      });

      const home = await page.goto('https://music.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 40_000 });
      out.homeStatus = home?.status();
      await page.waitForTimeout(3500);
      out.home = await page.evaluate(() => ({
        title: document.title,
        hasYtcfg: typeof (window as any).ytcfg !== 'undefined',
        hasVisitor: !!(window as any).ytcfg?.get?.('INNERTUBE_CONTEXT')?.client?.visitorData,
        botWall: /confirm you.?re not a bot|unusual traffic/i.test(document.body?.innerText || ''),
        bytes: document.body?.innerText?.length ?? 0,
      }));

      await page.goto(`https://music.youtube.com/watch?v=${videoId}`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
      const deadline = Date.now() + 60_000;
      let state: any = null;
      while (Date.now() < deadline && audioCount === 0) {
        state = await page
          .evaluate(() => {
            const v = document.querySelector('video') as HTMLVideoElement | null;
            if (v) { v.muted = true; v.play?.().catch(() => {}); }
            document.querySelector<HTMLElement>('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')?.click?.();
            return {
              hasVideoEl: !!v,
              readyState: v?.readyState ?? null,
              currentTime: v ? +v.currentTime.toFixed(2) : null,
              duration: v ? +(v.duration || 0).toFixed(1) : null,
              error: v?.error?.code ?? null,
              hasPlayerApi: typeof (window as any).ytmusic !== 'undefined',
            };
          })
          .catch(() => null);
        if (audioCount > 0) break;
        await page.waitForTimeout(1200);
      }
      out.player = state;
      out.audioRequests = audioCount;
      out.ok = audioCount > 0;
      return out;
    } catch (err) {
      out.error = (err as Error).message.slice(0, 300);
      return out;
    } finally {
      await browser?.close().catch(() => {});
    }
  });

  app.get('/api/search', async (req, reply) => {
    const q = String((req.query as any)?.q ?? '').trim();
    const type = String((req.query as any)?.type ?? 'all') as 'song' | 'video' | 'all';
    if (!q) { reply.code(400).send({ error: 'missing q' }); return reply; }
    try {
      const results = await search(q, type);
      return results;
    } catch (err) {
      req.log.error({ err }, 'search failed');
      reply.code(502).send({ error: 'search failed', detail: (err as Error).message });
      return reply;
    }
  });

  app.get('/api/track/:videoId', async (req, reply) => {
    const { videoId } = req.params as { videoId: string };
    const track = await getTrack(videoId);
    if (!track) { reply.code(404).send({ error: 'not found' }); return reply; }
    return track;
  });

  app.get('/api/lyrics/:videoId', async (req, reply) => {
    const { videoId } = req.params as { videoId: string };
    const q = req.query as any;
    const meta = q.title
      ? { title: String(q.title), artists: String(q.artist ?? '').split(',').filter(Boolean), album: q.album ?? null, durationSec: q.duration ? Number(q.duration) : null }
      : await getTrack(videoId).then((t) => (t ? { title: t.title, artists: t.artists, album: t.album, durationSec: t.durationSec } : undefined));
    const lyrics = await getLyrics(videoId, meta ?? undefined);
    if (!lyrics) { reply.code(404).send({ error: 'no lyrics', videoId }); return reply; }
    return lyrics;
  });

  app.get('/api/upnext/:videoId', async (req) => {
    const { videoId } = req.params as { videoId: string };
    const limit = Number((req.query as any)?.limit ?? 25);
    return { tracks: await getUpNext(videoId, Math.min(Math.max(limit, 1), 50)) };
  });

  /** Negotiate playback up front so the first byte is fast. */
  app.post('/api/play/:videoId', async (req, reply) => {
    const { videoId } = req.params as { videoId: string };
    try {
      const session = await ensureSession(videoId);
      return {
        videoId,
        ready: session.phase === 'ready',
        itag: session.audio?.itag ?? null,
        hasPoToken: session.audio?.hasPoToken ?? false,
        streamUrl: `/api/stream/${videoId}`,
      };
    } catch (err) {
      req.log.error({ err, videoId }, 'negotiation failed');
      reply.code(502).send({ error: 'could not negotiate playback', detail: (err as Error).message });
      return reply;
    }
  });

  /**
   * Audio delivery.
   *
   * Cache-first: once a complete track has been captured we serve the local file
   * with real byte-range support, which is what makes seeking work. On a cache
   * miss we stream live chunks to the client while a capture runs in the
   * background, so playback starts in a few seconds instead of waiting for the
   * whole file.
   *
   * The browser cannot fetch googlevideo itself — Google's CDN sends no CORS
   * headers (docs/FINDINGS.md §3) — so everything is relayed here.
   */
  app.get('/api/stream/:videoId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { videoId } = req.params as { videoId: string };
    const rangeHeader = req.headers.range as string | undefined;

    // 1. Cache hit -> proper ranged file serving.
    const cached = await pool.cacheGet(videoId);
    if (cached) {
      const size = cached.length;
      const range = parseRange(rangeHeader, size);
      const start = range?.start ?? 0;
      const end = range?.end ?? size - 1;
      if (start >= size || end >= size || start > end) {
        reply.code(416).header('content-range', `bytes */${size}`).send();
        return reply;
      }
      const slice = cached.subarray(start, end + 1);
      accountBytes(slice.length);
      reply
        .code(rangeHeader ? 206 : 200)
        .header('content-type', 'audio/webm')
        .header('accept-ranges', 'bytes')
        .header('content-length', String(slice.length))
        .header('cache-control', 'public, max-age=3600');
      if (rangeHeader) reply.header('content-range', `bytes ${start}-${end}/${size}`);
      return reply.send(Readable.from(slice));
    }

    // 2. Cache miss -> stream live, capturing in the background.
    let session: PlaybackSession;
    try {
      session = await ensureSession(videoId);
    } catch (err) {
      req.log.error({ err, videoId }, 'negotiation failed');
      reply.code(502).send({ error: 'could not negotiate playback', detail: (err as Error).message });
      return reply;
    }

    // Kick off (or join) a background capture so a later seek hits the cache.
    void pool.capture(videoId).catch((err) => req.log.warn({ err, videoId }, 'background capture failed'));

    reply
      .code(200)
      .header('content-type', 'audio/webm')
      .header('accept-ranges', 'none') // no random access until cached
      .header('cache-control', 'no-store');

    // Relay demuxed chunks as they arrive, replaying what was already captured.
    const body = new Readable({ read() {} });
    const seen = new Set<number>();
    let index = 0;
    let finished = false;

    const push = (buf: Buffer) => {
      if (finished || reply.raw.writableEnded) return;
      accountBytes(buf.length);
      body.push(buf);
    };

    // Replay anything captured during negotiation.
    for (const buf of session.chunks) {
      seen.add(index++);
      push(buf);
    }
    if (overBudget()) {
      body.push(null);
      return reply;
    }

    const unsubscribe = session.onChunk((c) => {
      if (!c.matched) return; // ad audio — never relay
      if (c.media.length) push(c.media);
    });

    const stop = () => {
      if (finished) return;
      finished = true;
      unsubscribe();
      clearInterval(timer);
      body.push(null);
    };

    const timer = setInterval(() => {
      if (session.captureDone) stop();
      if (reply.raw.writableEnded) stop();
    }, 1000);
    req.raw.on('close', stop);
    session.touch();

    return reply.send(body);
  });

  /** Whole track as one WebM/Opus file (waits for the full capture). */
  app.get('/api/download/:videoId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { videoId } = req.params as { videoId: string };
    try {
      const buf = await pool.capture(videoId);
      if (!buf.length) {
        reply.code(502).send({ error: 'capture produced no audio' });
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
    // SPA fallback for client-side routes.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/health')) {
        reply.code(404).send({ error: 'not found' });
        return;
      }
      reply.type('text/html').send(createReadStream(resolve(root, 'index.html')));
    });
  }

  // Warm the metadata client in the background; do not block startup.
  void yt().catch(() => {});

  const reaper = setInterval(() => void pool.reap().catch(() => {}), 60_000);
  app.addHook('onClose', async () => {
    clearInterval(reaper);
    await pool.shutdown();
  });

  return app;
}
