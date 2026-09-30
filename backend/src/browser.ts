/**
 * Browser Session Service
 * =======================
 *
 * YouTube binds audio playback to the *player session* that negotiated it. A URL
 * resolved programmatically (youtubei.js) returns HTTP 403 even from the same IP
 * with a valid PoToken — see docs/FINDINGS.md §4. The only reliable way to obtain
 * playable audio is to let a real Chromium instance play the track, then relay
 * the responses *that browser* receives, using its own headers (§6).
 *
 * Two things make this harder than "proxy a URL":
 *
 *  1. Responses are UMP-framed (`application/vnd.yt-ump`), not plain WebM. Raw
 *     relaying yields silence; the frame header must be stripped (§7).
 *  2. YouTube serves **ads** from the same endpoint, so a session will negotiate
 *     ad audio against the requested video. Ad segments carry the ad's videoId in
 *     their UMP header, so we filter on it. Without this, captures stop after the
 *     pre-roll (~20 s) instead of the song.
 *
 * Audio is cached to disk once captured: googlevideo serves UMP chunks
 * sequentially, so true random-access seeking is only possible against a local
 * complete file. Cache misses stream live while a capture runs in the
 * background, so first playback starts fast and seeking works moments later.
 */

import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demuxUmp, matchesVideo } from './ump.js';

export interface AudioRequest {
  url: string;
  headers: Record<string, string>;
  itag: string | null;
  hasPoToken: boolean;
  /** Total media length advertised in the URL; used to know when a fetch is complete. */
  clen: number | null;
}

export interface AudioChunk {
  media: Buffer;
  matched: boolean;
}

type Phase = 'starting' | 'negotiating' | 'ready' | 'failed' | 'closed';

/** One negotiated playback session, keyed by video id. */
export class PlaybackSession extends EventEmitter {
  readonly videoId: string;
  phase: Phase = 'starting';
  error: string | null = null;
  audio: AudioRequest | null = null;
  bytesServed = 0;
  createdAt = Date.now();
  lastUsedAt = Date.now();

  /** Audio for the requested video only (init segment + media), in order. */
  readonly chunks: Buffer[] = [];
  capturedBytes = 0;
  /** Set once the requested track's own audio has been seen (ads excluded). */
  sawTarget = false;
  captureDone = false;
  private capturePromise: Promise<Buffer> | null = null;
  private readonly chunkListeners = new Set<(c: AudioChunk) => void>();

  constructor(videoId: string) {
    super();
    this.videoId = videoId;
  }

  get idleMs(): number {
    return Date.now() - this.lastUsedAt;
  }

  touch(): void {
    this.lastUsedAt = Date.now();
  }

  onChunk(fn: (c: AudioChunk) => void): () => void {
    this.chunkListeners.add(fn);
    return () => {
      this.chunkListeners.delete(fn);
    };
  }

  /** Called by the pool's route handler for every audio response. */
  _ingest(body: Buffer): AudioChunk {
    const { header, media } = demuxUmp(body);
    const matched = matchesVideo(header, this.videoId);
    if (matched) {
      this.sawTarget = true;
      if (media.length) {
        this.chunks.push(media);
        this.capturedBytes += media.length;
      }
    }
    const chunk: AudioChunk = { media, matched };
    for (const fn of this.chunkListeners) fn(chunk);
    return chunk;
  }

  /** Concatenated audio captured so far (valid WebM/Opus once complete). */
  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Register the in-flight capture so concurrent callers share one run. */
  setCapture(p: Promise<Buffer>): void {
    this.capturePromise = p;
  }

  getCapture(): Promise<Buffer> | null {
    return this.capturePromise;
  }

  markCaptureDone(): void {
    this.captureDone = true;
  }
}

export interface BrowserPoolOptions {
  chromiumPath?: string;
  headless?: boolean;
  maxSessions: number;
  sessionTtlMs: number;
  browserIdleMs: number;
  userAgent: string;
  negotiateTimeoutMs: number;
  /** Directory for captured audio. Empty disables disk caching. */
  cacheDir?: string;
  /** Max bytes of cached audio before eviction. */
  cacheMaxBytes?: number;
  /** How long to keep pulling audio for a full-track capture. */
  captureMaxMs?: number;
}

interface CacheMeta {
  path: string;
  size: number;
  at: number;
}

export class BrowserPool extends EventEmitter {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly sessions = new Map<string, PlaybackSession>();
  private lastBrowserUse = 0;
  private readonly capturing = new Set<string>();
  private readonly cacheIndex = new Map<string, CacheMeta>();

  constructor(private readonly opts: BrowserPoolOptions) {
    super();
  }

  /* ------------------------------ lifecycle ----------------------------- */

  get size(): number {
    return this.sessions.size;
  }

  stats() {
    return {
      browserRunning: !!this.browser?.isConnected(),
      sessions: this.sessions.size,
      maxSessions: this.opts.maxSessions,
      capturing: this.capturing.size,
      cached: this.cacheIndex.size,
      ids: [...this.sessions.keys()],
    };
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const browser = await chromium.launch({
        executablePath: this.opts.chromiumPath || undefined,
        headless: this.opts.headless ?? true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', // /dev/shm is tiny in containers
          '--disable-gpu',
          '--autoplay-policy=no-user-gesture-required',
          '--js-flags=--max-old-space-size=128',
          '--disable-background-networking',
          '--disable-extensions',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter',
          // Keep the media pipeline alive in a headless container; without these
          // the player often never requests audio at all.
          '--autoplay-policy=no-user-gesture-required',
          '--mute-audio',
          '--window-size=1280,800',
        ],
      });
      this.browser = browser;
      browser.on('disconnected', () => {
        this.browser = null;
        this.context = null;
        for (const s of this.sessions.values()) {
          s.phase = 'failed';
          s.error = 'browser disconnected';
        }
        this.sessions.clear();
      });
      return browser;
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private async ensureContext(): Promise<BrowserContext> {
    const browser = await this.ensureBrowser();
    if (this.context) return this.context;
    this.context = await browser.newContext({
      userAgent: this.opts.userAgent,
      viewport: { width: 1280, height: 800 },
      serviceWorkers: 'block',
    });
    return this.context;
  }

  /* ------------------------------- caching ------------------------------ */

  private cachePath(videoId: string): string | null {
    if (!this.opts.cacheDir) return null;
    const h = createHash('sha1').update(videoId).digest('hex').slice(0, 16);
    return join(this.opts.cacheDir, `${h}.webm`);
  }

  async cacheGet(videoId: string): Promise<Buffer | null> {
    const p = this.cachePath(videoId);
    if (!p) return null;
    try {
      const buf = await readFile(p);
      this.cacheIndex.set(videoId, { path: p, size: buf.length, at: Date.now() });
      return buf;
    } catch {
      return null;
    }
  }

  private async cachePut(videoId: string, buf: Buffer): Promise<void> {
    const p = this.cachePath(videoId);
    if (!p || !buf.length) return;
    try {
      await mkdir(this.opts.cacheDir!, { recursive: true });
      await writeFile(p, buf);
      this.cacheIndex.set(videoId, { path: p, size: buf.length, at: Date.now() });
      await this.evictIfNeeded();
    } catch (err) {
      this.emit('warn', { msg: 'cache write failed', err: String(err) });
    }
  }

  private async evictIfNeeded(): Promise<void> {
    const max = this.opts.cacheMaxBytes ?? 0;
    if (!max) return;
    let total = [...this.cacheIndex.values()].reduce((a, v) => a + v.size, 0);
    if (total <= max) return;
    const byAge = [...this.cacheIndex.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [id, meta] of byAge) {
      if (total <= max) break;
      await rm(meta.path, { force: true }).catch(() => {});
      this.cacheIndex.delete(id);
      total -= meta.size;
    }
  }

  /* ------------------------------- sessions ----------------------------- */

  async acquire(videoId: string): Promise<PlaybackSession> {
    const existing = this.sessions.get(videoId);
    if (existing && (existing.phase === 'ready' || existing.phase === 'negotiating')) {
      existing.touch();
      return existing;
    }
    if (this.sessions.size >= this.opts.maxSessions) {
      const lru = [...this.sessions.entries()].sort((a, b) => a[1].idleMs - b[1].idleMs);
      for (const [id] of lru) {
        if (this.sessions.size < this.opts.maxSessions) break;
        if (id === videoId) continue;
        this.sessions.delete(id);
      }
    }
    const session = new PlaybackSession(videoId);
    this.sessions.set(videoId, session);
    await this.negotiate(session);
    return session;
  }

  private async negotiate(session: PlaybackSession): Promise<void> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    session.phase = 'negotiating';
    const started = Date.now();

    const audioPattern = /googlevideo\.com\/videoplayback/;

    await page.route(audioPattern, async (route: Route) => {
      const url = route.request().url();
      if (!/mime=audio/.test(url)) {
        await route.continue();
        return;
      }
      try {
        const resp = await route.fetch();
        const body = Buffer.from(await resp.body());
        if (!session.audio) {
          session.audio = {
            url,
            headers: route.request().headers(),
            itag: (url.match(/[?&]itag=(\d+)/) || [])[1] ?? null,
            hasPoToken: /[?&]pot=/.test(url),
            clen: Number((url.match(/[?&]clen=(\d+)/) || [])[1] ?? 0) || null,
          };
        }
        session._ingest(body);
        if (session.sawTarget) session.phase = 'ready';
        await route.fulfill({ response: resp, body });
      } catch {
        await route.continue();
      }
    });

    // Strip CSP so a BotGuard interpreter can be injected when needed.
    await page.route('**/*', async (route: Route) => {
      if (audioPattern.test(route.request().url())) {
        await route.fallback();
        return;
      }
      try {
        const resp = await route.fetch();
        const headers: Record<string, string> = { ...resp.headers() };
        for (const k of Object.keys(headers)) {
          const lk = k.toLowerCase();
          if (lk.startsWith('content-security-policy') || lk === 'origin-agent-cluster') delete headers[k];
        }
        await route.fulfill({ response: resp, headers });
      } catch {
        await route.continue();
      }
    });

    try {
      await page.goto(`https://music.youtube.com/watch?v=${session.videoId}`, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(this.opts.negotiateTimeoutMs, 45_000),
      });

      const deadline = Date.now() + this.opts.negotiateTimeoutMs;
      let attempts = 0;
      while (Date.now() < deadline) {
        await this.nudge(page);
        if (session.sawTarget) break;
        if (session.audio && Date.now() - started > 25_000) break; // ads only; accept what we have
        attempts++;
        if (attempts === 4) await this.mintPoToken(page).catch(() => false);
        await page.waitForTimeout(1000);
      }

      if (!session.audio) {
        session.phase = 'failed';
        session.error = `no audio negotiated within ${this.opts.negotiateTimeoutMs}ms`;
      } else {
        session.phase = 'ready';
      }
    } catch (err) {
      session.phase = 'failed';
      session.error = err instanceof Error ? err.message : String(err);
    } finally {
      await page.close().catch(() => {});
      this.lastBrowserUse = Date.now();
      this.emit('negotiated', {
        videoId: session.videoId,
        ready: session.phase === 'ready',
        sawTarget: session.sawTarget,
        itag: session.audio?.itag,
        ms: Date.now() - started,
      });
    }
  }

  private async nudge(page: Page): Promise<void> {
    await page
      .evaluate(() => {
        const v = document.querySelector('video') as HTMLVideoElement | null;
        if (!v) return;
        v.muted = true;
        v.play?.().catch(() => {});
        // Skip any advertisement so the real track starts sooner.
        const skip = document.querySelector<HTMLElement>(
          '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern',
        );
        skip?.click?.();
      })
      .catch(() => {});
  }

  /* ------------------------------- capture ------------------------------ */

  /**
   * Capture the complete track to the disk cache. Idempotent: concurrent callers
   * share a single capture run per video id.
   */
  async capture(videoId: string): Promise<Buffer> {
    const cached = await this.cacheGet(videoId);
    if (cached) return cached;

    const session = await this.acquire(videoId);
    const existing = session.getCapture();
    if (existing) return existing;

    const run = this.runCapture(session).finally(() => {
      this.capturing.delete(videoId);
      session.markCaptureDone();
    });
    session.setCapture(run);
    this.capturing.add(videoId);
    return run;
  }

  /** True once a complete track is available locally. */
  async isCached(videoId: string): Promise<boolean> {
    return (await this.cacheGet(videoId)) !== null;
  }

  /**
   * Download the complete track.
   *
   * googlevideo serves this URL as a sequence of UMP chunks: repeating the same
   * request returns the *next* chunk rather than the same bytes, and the `range`
   * parameter is ignored. So we fetch in a loop, demux each UMP frame, and stop
   * once the media we hold matches the `clen` advertised in the URL. A full
   * 4-minute track arrives in ~1.5 s this way — far faster and far more reliable
   * than driving the page's own player.
   */
  private async runCapture(session: PlaybackSession): Promise<Buffer> {
    const audio = session.audio;
    if (!audio) throw new Error('session has no negotiated audio url');

    const parts: Buffer[] = [];
    // Reuse whatever negotiation already captured (skips re-downloading the head).
    if (session.chunks.length) {
      parts.push(...session.chunks);
    }
    let total = parts.reduce((a, b) => a + b.length, 0);
    const target = audio.clen;
    let consecutiveEmpty = 0;
    const started = Date.now();
    const limit = this.opts.captureMaxMs ?? 150_000;
    const maxRequests = 5000;

    for (let i = 0; i < maxRequests; i++) {
      if (target && total >= target) break;
      if (Date.now() - started > limit) break;
      if (consecutiveEmpty >= 6) break;

      let res: Response;
      try {
        res = await fetch(audio.url, { headers: audio.headers });
      } catch (err) {
        this.emit('warn', { msg: 'capture fetch failed', err: String(err) });
        break;
      }
      if (!res.ok) {
        this.emit('warn', { msg: 'capture fetch non-ok', status: res.status });
        break;
      }
      const body = Buffer.from(await res.arrayBuffer());
      const { header, media } = demuxUmp(body);
      // Reject ad audio that the player interleaved into this session.
      if (!matchesVideo(header, session.videoId)) {
        consecutiveEmpty++;
        continue;
      }
      if (!media.length) {
        consecutiveEmpty++;
        continue;
      }
      consecutiveEmpty = 0;
      parts.push(media);
      total += media.length;
      session.capturedBytes = total;
    }

    const buf = Buffer.concat(parts);
    if (buf.length) {
      await this.cachePut(session.videoId, buf);
      session.chunks.length = 0;
      session.chunks.push(buf);
    }
    this.emit('captured', {
      videoId: session.videoId,
      bytes: buf.length,
      target,
      complete: target ? buf.length >= target : undefined,
      ms: Date.now() - started,
    });
    return buf;
  }

  /* ------------------------------- potoken ------------------------------ */

  /**
   * Mint a PoToken inside the live page. Only needed when YouTube's player
   * refuses to start (flagged IPs). See docs/FINDINGS.md §5 for why the
   * interpreter is fetched in Node and why CSP must be stripped first.
   */
  private async mintPoToken(page: Page): Promise<boolean> {
    let bundle: string;
    try {
      bundle = await readFile(fileURLToPath(new URL('../assets/bg.bundle.js', import.meta.url)), 'utf8');
    } catch {
      return false;
    }

    const challenge = await page
      .evaluate(async () => {
        const cfg = (window as any).ytcfg;
        if (!cfg) return null;
        const client = cfg.get('INNERTUBE_CONTEXT').client;
        const r = await fetch(`/youtubei/v1/att/get?key=${cfg.get('INNERTUBE_API_KEY')}&prettyPrint=false`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: { client: { ...client, hl: 'en', gl: 'US' } },
            engagementType: 'ENGAGEMENT_TYPE_UNBOUND',
          }),
        });
        const j: any = await r.json();
        const bg = j.bgChallenge || j.bg_challenge;
        if (!bg) return null;
        return {
          program: bg.program,
          globalName: bg.globalName || bg.global_name,
          interpreterUrl:
            bg.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue ||
            bg.interpreter_url?.private_do_not_access_or_else_trusted_resource_url_wrapped_value,
        };
      })
      .catch(() => null);
    if (!challenge?.interpreterUrl) return false;

    const url = challenge.interpreterUrl.startsWith('http') ? challenge.interpreterUrl : `https:${challenge.interpreterUrl}`;
    const interpreter = await (await fetch(url, { headers: { referer: 'https://music.youtube.com/' } })).text();
    await page.addScriptTag({ content: interpreter });
    await page.addScriptTag({ content: bundle });

    const token = await page
      .evaluate(
        async ({ program, globalName }) => {
          const bg: any = (globalThis as any).__BG;
          if (!bg) return null;
          const client = (window as any).ytcfg?.get('INNERTUBE_CONTEXT')?.client;
          const c = await bg.BotGuardClient.create({ program, globalName, globalObject: window });
          const out: unknown[] = [];
          const bgr = await c.snapshot({ webPoSignalOutput: out });
          const itr = await (
            await fetch('https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json+protobuf',
                'x-goog-api-key': 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw',
                'x-user-agent': 'grpc-web-javascript/0.1',
              },
              body: JSON.stringify(['o43z0dpjhgX20SCx4KAo', bgr]),
            })
          ).json();
          const minter = await bg.WebPoMinter.create(
            {
              integrityToken: itr[0],
              estimatedTtlSecs: itr[1],
              mintRefreshThreshold: itr[2],
              websafeFallbackToken: itr[3],
            },
            out,
          );
          return await minter.mintAsWebsafeString(client.visitorData);
        },
        { program: challenge.program, globalName: challenge.globalName },
      )
      .catch(() => null);

    this.emit('potoken', { ok: !!token, length: (token as string | null)?.length ?? 0 });
    return !!token;
  }

  /* ----------------------------- housekeeping --------------------------- */

  async close(videoId: string): Promise<void> {
    const s = this.sessions.get(videoId);
    if (!s) return;
    s.phase = 'closed';
    this.sessions.delete(videoId);
  }

  async reap(): Promise<void> {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (this.capturing.has(id)) continue;
      if (now - s.lastUsedAt > this.opts.sessionTtlMs) {
        s.phase = 'closed';
        this.sessions.delete(id);
      }
    }
    if (this.sessions.size === 0 && this.browser && now - this.lastBrowserUse > this.opts.browserIdleMs) {
      const b = this.browser;
      this.browser = null;
      this.context = null;
      await b.close().catch(() => {});
    }
  }

  async shutdown(): Promise<void> {
    this.sessions.clear();
    const b = this.browser;
    this.browser = null;
    this.context = null;
    await b?.close().catch(() => {});
  }
}
