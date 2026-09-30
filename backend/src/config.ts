/** Runtime configuration, all overridable by environment variable. */
import { existsSync } from 'node:fs';

/**
 * Find a usable Chromium binary.
 *
 * `playwright-core` ships no browser, and the path differs between distros
 * (`chromium` on Debian/Ubuntu 24.04+, `chromium-browser` on Ubuntu 22.04 and
 * older). Checking well-known locations keeps deployment working without having
 * to pin CHROMIUM_PATH per platform.
 */
function detectChromium(): string {
  const candidates = [
    process.env.CHROME_PATH ?? '',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/usr/lib/chromium/chromium',
    '/opt/google/chrome/chrome',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return '';
}


function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export const config = {
  port: num('PORT', 10000),
  host: process.env.HOST ?? '0.0.0.0',

  /** Path to a Chromium/Chrome binary. Blank triggers auto-detection. */
  chromiumPath: process.env.CHROMIUM_PATH || detectChromium(),
  headless: bool('HEADLESS', true),

  /** Concurrency + lifetimes, tuned for a 512 MB / 0.1 CPU free instance. */
  maxSessions: num('MAX_SESSIONS', 2),
  sessionTtlMs: num('SESSION_TTL_MS', 10 * 60_000),
  browserIdleMs: num('BROWSER_IDLE_MS', 3 * 60_000),
  negotiateTimeoutMs: num('NEGOTIATE_TIMEOUT_MS', 30_000),

  userAgent:
    process.env.USER_AGENT ??
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',

  /**
   * Bandwidth guard. Render's free tier gives the whole workspace 5 GB/month and
   * suspends every free service when it runs out. 0 disables the guard (default,
   * because this deployment is intentionally public). Set BANDWIDTH_CAP_GB=4 to
   * keep a safety margin.
   */
  bandwidthCapBytes: num('BANDWIDTH_CAP_GB', 0) * 1024 ** 3,

  /** Simple rate limit for expensive endpoints. */
  rateLimitPerMin: num('RATE_LIMIT_PER_MIN', 60),

  /** Shared password. When set, all /api routes require it. */
  accessPassword: process.env.ACCESS_PASSWORD ?? '',

  corsOrigin: process.env.CORS_ORIGIN ?? '*',

  /** Serve the built frontend from this directory when present. */
  staticDir: process.env.STATIC_DIR ?? '',

  /**
   * Captured audio cache. Ephemeral on Render's free tier (no persistent disks),
   * but it survives for the life of the instance and makes seeking work.
   * Empty CACHE_DIR disables caching and forces live streaming only.
   */
  cacheDir: process.env.CACHE_DIR ?? '/tmp/ytmusic-cache',
  cacheMaxBytes: num('CACHE_MAX_MB', 512) * 1024 ** 2,
  captureMaxMs: num('CAPTURE_MAX_MS', 150_000),
};

export type Config = typeof config;
