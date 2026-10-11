# syntax=docker/dockerfile:1
# ============================================================================
# OpenDeck — self-hosted music client
#
# Multi-stage build: compile the React client + TypeScript server, then ship a
# slim runtime image that serves both from a single process on :4000.
#
#   docker build -t opendeck .
#   docker run -p 4000:4000 -e APP_SECRET=$(openssl rand -hex 32) opendeck
#
# Node 24 (LTS) is required: the server uses the built-in `node:sqlite`
# module, which is available without a flag from Node 24 onward.
# ============================================================================

FROM node:24-alpine AS build
WORKDIR /app

# Install dependencies against the lockfile before copying sources, so an
# edited file does not re-run the (slow) install step.
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
# Playwright browsers are only needed for `npm run test:e2e`, which is not
# part of this build; skip the download entirely.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

COPY . .
RUN npm run build


FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    DATA_DIR=/data

# Production dependencies only.
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev && npm cache clean --force

# Compiled artifacts from the build stage. Paths must line up with the
# server's relative lookup: `server/dist` → `../../client/dist`.
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
# Rendered as the public /docs API reference page.
COPY --from=build /app/docs ./docs

# SQLite (and the generated dev secret, if ever created) live on a volume.
RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "server/dist/index.js"]
