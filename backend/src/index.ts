import { buildServer } from './server.js';
import { config } from './config.js';

async function main(): Promise<void> {
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      `listening on http://${config.host}:${config.port} | ` +
        `engine=sabr maxFetches=${config.maxConcurrentFetches} cache=${config.cacheDir || 'off'} ` +
        `bandwidthCap=${config.bandwidthCapBytes ? `${(config.bandwidthCapBytes / 1024 ** 3).toFixed(2)}GB` : 'unlimited'}`,
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
