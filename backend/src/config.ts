/** Runtime configuration, all overridable by environment variable. */

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

  /** Concurrency for SABR track downloads, tuned for a small instance. */
  maxConcurrentFetches: num('MAX_CONCURRENT_FETCHES', 2),
  /** Abort a track download after this long. */
  fetchMaxMs: num('FETCH_MAX_MS', 150_000),

  userAgent:
    process.env.USER_AGENT ??
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',

  /**
   * Bandwidth guard. A free PaaS tier typically meters egress for the whole
   * account and suspends services when it runs out. 0 disables the guard.
   */
  bandwidthCapBytes: num('BANDWIDTH_CAP_GB', 0) * 1024 ** 3,

  /** Simple rate limit for expensive endpoints. */
  rateLimitPerMin: num('RATE_LIMIT_PER_MIN', 60),

  /** Shared password. When set, all /api routes require it. */
  accessPassword: process.env.ACCESS_PASSWORD ?? '',

  corsOrigin: process.env.CORS_ORIGIN ?? '*',

  /** Serve the built front-end from this directory when present. */
  staticDir: process.env.STATIC_DIR ?? '',

  /**
   * Audio cache. Makes byte-range seeking possible, since SABR is a sequential
   * stream. Empty CACHE_DIR disables caching.
   */
  cacheDir: process.env.CACHE_DIR ?? '/tmp/ytmusic-cache',
  cacheMaxBytes: num('CACHE_MAX_MB', 512) * 1024 ** 2,

  /** Trust X-Forwarded-For for rate limiting (true behind a reverse proxy). */
  trustProxy: bool('TRUST_PROXY', true),

  /**
   * Which address family to prefer for outbound connections.
   * YouTube's DNS answers AAAA first, so on a dual-stack host traffic may leave
   * over IPv6; pin `ipv4` if the v6 route is the one being refused.
   */
  egressFamily: (process.env.EGRESS_FAMILY ?? 'auto') as 'auto' | 'ipv4' | 'ipv6',
};

export type Config = typeof config;
