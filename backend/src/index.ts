import { applyEgressFamily } from './egress.js';
import { configureIpv6Pool, installAddressRouting, reapLeases, ipv6PoolStatus } from './egressip.js';
import { installProxy } from './proxy.js';
import { buildServer } from './server.js';
import { config } from './config.js';

async function main(): Promise<void> {
  // Must run before any outbound request: YouTube binds playback to the egress IP.
  applyEgressFamily(config.egressFamily);
  configureIpv6Pool(config.ipv6Prefix || undefined, config.ipv6PoolSize, config.ipv6RotateHours);
  installAddressRouting();
  installProxy();
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  // Retire idle/expired egress addresses periodically.
  const reap = setInterval(() => reapLeases(), 10 * 60_000);
  reap.unref();

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      `listening on http://${config.host}:${config.port} | ` +
        `engine=sabr maxFetches=${config.maxConcurrentFetches} cache=${config.cacheDir || 'off'} ` +
        `bandwidthCap=${config.bandwidthCapBytes ? `${(config.bandwidthCapBytes / 1024 ** 3).toFixed(2)}GB` : 'unlimited'} ` +
        `ipv6Pool=${config.ipv6Prefix || 'off'}`,
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
