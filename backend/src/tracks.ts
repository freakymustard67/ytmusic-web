/**
 * Track service — SABR playback with an on-disk cache.
 *
 * Deliberately browser-free. YouTube's web clients are SABR-only now, so the
 * server speaks SABR directly (see sabr.ts) instead of driving a headless
 * Chromium page. That keeps the process around ~100 MB resident rather than
 * ~800 MB, which is what lets this run on a small free instance.
 *
 * A track is fetched once and cached to disk. Subsequent requests — including
 * byte-range requests for seeking — are served from the cache, because SABR
 * delivers a sequential stream with no random access.
 */

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchTrackBuffer } from './sabr.js';

export interface TrackCacheOptions {
  cacheDir?: string;
  cacheMaxBytes: number;
  /** Abort a download after this long. */
  fetchMaxMs: number;
  /** How many tracks may download at once. */
  maxConcurrent: number;
}

interface CacheMeta {
  path: string;
  size: number;
  at: number;
}

interface InFlight {
  promise: Promise<Buffer>;
  waiters: number;
}

export interface TrackProgress {
  videoId: string;
  bytes: number;
  done: boolean;
  error?: string;
}

export class TrackService extends EventEmitter {
  private readonly cacheIndex = new Map<string, CacheMeta>();
  private readonly inflight = new Map<string, InFlight>();
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly opts: TrackCacheOptions) {
    super();
  }

  stats() {
    return {
      cached: this.cacheIndex.size,
      cachedBytes: [...this.cacheIndex.values()].reduce((a, v) => a + v.size, 0),
      downloading: this.inflight.size,
      active: this.active,
      queued: this.queue.length,
    };
  }

  private pathFor(videoId: string): string | null {
    if (!this.opts.cacheDir) return null;
    const h = createHash('sha1').update(videoId).digest('hex').slice(0, 16);
    return join(this.opts.cacheDir, `${h}.webm`);
  }

  /** Cached audio for a track, or null. */
  async get(videoId: string): Promise<Buffer | null> {
    const p = this.pathFor(videoId);
    if (!p) return null;
    try {
      const buf = await readFile(p);
      this.cacheIndex.set(videoId, { path: p, size: buf.length, at: Date.now() });
      return buf;
    } catch {
      return null;
    }
  }

  async isCached(videoId: string): Promise<boolean> {
    return (await this.get(videoId)) !== null;
  }

  private async put(videoId: string, buf: Buffer): Promise<void> {
    const p = this.pathFor(videoId);
    if (!p || !buf.length) return;
    try {
      await mkdir(this.opts.cacheDir!, { recursive: true });
      await writeFile(p, buf);
      this.cacheIndex.set(videoId, { path: p, size: buf.length, at: Date.now() });
      await this.evict();
    } catch (err) {
      this.emit('warn', { msg: 'cache write failed', videoId, err: String(err) });
    }
  }

  private async evict(): Promise<void> {
    const max = this.opts.cacheMaxBytes;
    if (!max) return;
    let total = [...this.cacheIndex.values()].reduce((a, v) => a + v.size, 0);
    if (total <= max) return;
    for (const [id, meta] of [...this.cacheIndex.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (total <= max) break;
      await rm(meta.path, { force: true }).catch(() => {});
      this.cacheIndex.delete(id);
      total -= meta.size;
    }
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.opts.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  /**
   * Download a track (or return the cached copy). Concurrent callers for the same
   * video share a single download.
   */
  async fetch(videoId: string): Promise<Buffer> {
    const cached = await this.get(videoId);
    if (cached) return cached;

    const existing = this.inflight.get(videoId);
    if (existing) {
      existing.waiters++;
      return existing.promise;
    }

    const promise = this.withSlot(async () => {
      const buf = await fetchTrackBuffer(videoId, this.opts.fetchMaxMs);
      if (!buf.length) throw new Error('SABR produced no audio');
      await this.put(videoId, buf);
      this.emit('fetched', { videoId, bytes: buf.length });
      return buf;
    }).finally(() => {
      this.inflight.delete(videoId);
    });

    this.inflight.set(videoId, { promise, waiters: 1 });
    return promise;
  }

  /**
   * Start downloading without waiting. Used so the first play request can begin
   * streaming immediately while the rest of the track is fetched.
   */
  prefetch(videoId: string): void {
    if (this.inflight.has(videoId)) return;
    void this.fetch(videoId).catch((err) =>
      this.emit('warn', { msg: 'prefetch failed', videoId, err: String(err) }),
    );
  }
}
