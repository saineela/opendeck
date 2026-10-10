/**
 * Engine bundle for the bare API test client (webapp/test-app/).
 *
 * Bundles the real data layer (youtubei.js + BotGuard po-token + proxy fetch)
 * into a single browser ESM file so the test app needs no build tooling of
 * its own. Every network request this engine makes goes through the music API
 * we built:
 *
 *   InnerTube / YouTube Music  →  POST /api/yt/proxy
 *   audio bytes                →  GET  /api/media/stream
 *   search-result cache        →  POST /api/cache/*
 *   BotGuard attestation       →  https://jnn-pa.googleapis.com (CSP-allowed,
 *                                 identical to the real client)
 *
 * Build: node test-app/build.mjs  (from webapp/)
 */
import { YouTubeMusicDataSource } from "../client/src/datasource/youtube/YouTubeMusicDataSource";

/** Shared singleton — same data layer the production client instantiates. */
export const dataSource = new YouTubeMusicDataSource();

export { YouTubeMusicDataSource };
