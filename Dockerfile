# Production image for the YouTube Music web backend.
#
# Chromium is installed from Debian rather than using the official Playwright
# image: Render's free instance has 512 MB RAM, and the Playwright base image
# alone runs ~500 MB before Node starts. The plain chromium package gives us the
# same engine with far more headroom.
#
# `playwright-core` needs no browser download — it launches CHROMIUM_PATH.

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --include=dev

COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/assets ./assets
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Chromium plus the fonts/libs it needs to render YouTube Music.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libgtk-3-0 \
      libnss3 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    HEADLESS=true \
    PORT=10000 \
    CACHE_DIR=/tmp/ytmusic-cache \
    STATIC_DIR=/app/public

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
COPY backend/package.json ./
COPY frontend/public ./public

# Run unprivileged: the node image already provides a `node` user.
RUN mkdir -p /tmp/ytmusic-cache && chown -R node:node /tmp/ytmusic-cache
USER node

EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
