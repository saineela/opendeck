# syntax=docker/dockerfile:1
# ============================================================================
# OpenDeck — self-hosted music client
#
# Multi-stage build: compile the React client + TypeScript server, bundle the
# PO token provider, then ship a slim runtime image that serves both from a
# single process on :4000.
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


# The PO token provider stays in this image and listens on loopback only, so
# gated tracks get their proof-of-origin token without a second container, a
# published port or a reachable hostname.
FROM node:24-bookworm-slim AS pot-provider
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates python3 make g++ pkg-config \
      libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch 2.0.2 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /src
WORKDIR /src/server
RUN npm ci --no-audit --no-fund && npx tsc


FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    DATA_DIR=/data \
    POT_PROVIDER_URL=http://127.0.0.1:4416

# wget backs the healthcheck; the rest are the runtime libraries the bundled
# provider's canvas build links against (the build stage installs the -dev
# packages, which are not shipped here).
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo \
      libgif7 librsvg2-2 libfontconfig1 \
 && rm -rf /var/lib/apt/lists/*

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
# Public env template — served as the /docs/.env.example companion page.
COPY --from=build /app/.env.example ./
# Apache-2.0 requires LICENSE and NOTICE to ship with a binary distribution.
COPY --from=build /app/LICENSE /app/NOTICE ./
# Bundled token provider: built sources plus their production dependencies.
COPY --from=pot-provider /src/server/build /opt/pot-provider/build
COPY --from=pot-provider /src/server/node_modules /opt/pot-provider/node_modules
COPY --from=pot-provider /src/server/package.json /opt/pot-provider/package.json

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# SQLite (and the generated dev secret, if ever created) live on a volume.
RUN mkdir -p /data && chown -R node:node /app /data /opt/pot-provider
USER node

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
