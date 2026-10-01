# Production image for the YouTube Music web backend.
#
# No browser is installed: playback speaks YouTube's SABR protocol directly
# (see backend/src/sabr.ts), which keeps the image small and resident memory
# near ~150-300 MB instead of ~800 MB for a headless Chromium.

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --include=dev

COPY backend/tsconfig.json backend/bg-entry.mjs ./
COPY backend/src ./src
COPY backend/assets ./assets
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# tini reaps the odd child process; nothing else is needed without a browser.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=10000 \
    CACHE_DIR=/tmp/ytmusic-cache \
    STATIC_DIR=/app/public

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
COPY backend/package.json ./
COPY frontend/public ./public

RUN mkdir -p /tmp/ytmusic-cache && chown -R node:node /tmp/ytmusic-cache
USER node

EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
