# Music API — System Integration Guide

How to deploy, integrate, and operate this service as a **standalone music
service**: system architecture, authentication flows, the playback pipeline,
client integration patterns, and production operations.

- Endpoint-by-endpoint reference: [API.md](API.md)
- Machine-readable spec: [openapi.yaml](openapi.yaml)
- Feature parity audit vs the original desktop app:
  [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md)

---

## 1. What this service is

**OpenDeck** is a self-hostable, **multi-user** music service: one process,
one SQLite file, any number of accounts. It fronts YouTube Music (and lyrics
providers) with everything a client needs — accounts with passwords + TOTP,
a per-user library of playlists and liked songs, search, metadata, streaming
bytes, caching, per-user settings, and scrobbling — while keeping all
credentials on the server. Attribution and licensing: rebuilt from
[JustAnotherMusicClient](https://github.com/2latemc/JustAnotherMusicClient)
(Apache-2.0); see the README.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Client (any same-origin browser app / the shipped React SPA)        │
│   • session cookie od_sid (HttpOnly)                                │
│   • youtubei.js engine for parsing InnerTube responses              │
│   • BotGuard po-token attestation (browser → jnn-pa.googleapis.com) │
└───────────────┬─────────────────────────────────────────────────────┘
                │ same-origin fetch (JSON, cookies)
┌───────────────▼─────────────────────────────────────────────────────┐
│ Music API (Express 5 + helmet + node:sqlite, single process)        │
│                                                                     │
│  /api/auth/*      password + TOTP, Google OAuth code+PKCE, sessions  │
│  /api/library/*   per-user playlists, tracks, liked songs          │
│  /api/youtube/*   device-code linking (tokens AES-256-GCM at rest)  │
│  /api/yt/proxy    allowlisted upstream proxy + Bearer injection     │
│  /api/media/stream googlevideo audio passthrough (Range, 403-retry) │
│  /api/cache/*     SQLite LRU cache (namespaced per user)            │
│  /api/settings/*  durable per-user settings                         │
│  /api/keys/*      per-account API keys (Bearer odk_…)               │
│  /api/admin/*     role-based admin panel (users, OIDC, reset)       │
│  /healthz         liveness probe                                    │
│  static           client/dist SPA                                   │
│                                                                     │
│  middleware: helmet CSP → JSON body (10 MB) → origin check →        │
│              session → per-IP rate limiter → error mapper           │
└───────┬───────────────┬────────────────┬────────────────┘
        │               │                │
        ▼               ▼                ▼
  Google OIDC     YouTube OAuth      Googlevideo
  (discovery,     (TV device-code,   CDN (audio
   JWKS verify)    refresh, revoke)   bytes, Range)
        │               │
        └───────┬───────┘
                ▼
   InnerTube / music.youtube.com / ytimg / lrclib (allowlisted hosts)
```

Design pillars:

1. **The browser never holds a secret.** OAuth client secret
   and YouTube refresh tokens live only in server env + SQLite
   (encrypted). The client holds an opaque session cookie.
2. **One choke point for upstream traffic.** Everything the client fetches
   from YouTube-land goes through `POST /api/yt/proxy` (host allowlist,
   header stripping, per-hop redirect validation) or
   `GET /api/media/stream` (googlevideo only) — no open proxy, no SSRF.
3. **Same-origin by construction.** Cookies + CSRF origin check assume the
   API and the UI share an origin. Cross-origin browser clients are not a
   supported topology (use a server-side BFF if you need one).
4. **Accounts are isolated by construction.** Every per-user row (sessions,
   tokens, settings, cache namespace, playlists, tracks, likes, api keys) is
   keyed by the id resolved from the credential (session cookie or API
   key). No route accepts a user
   id from the client, so a crafted URL cannot reach another account's data.

---

## 2. Repository / package layout

```
webapp/
├─ package.json            # npm workspaces: server + client; dev/build/start/test
├─ Dockerfile              # multi-stage: build client+server → slim runtime
├─ docker-compose.yml      # one service, named volume for SQLite, healthcheck
├─ LICENSE · NOTICE        # Apache-2.0 + attribution to the reference project
├─ playwright.config.ts    # E2E: fake IdP (:4310) + app (:4000) + unconfigured (:4100)
├─ .env / .env.example     # runtime configuration (docs for every variable)
├─ e2e/                    # Playwright suites + fake Google OIDC provider
├─ client/                 # Vite 7 + React 19 SPA (the shipped product UI)
│  ├─ src/datasource/      # YouTubeMusicDataSource — search/library/streams
│  ├─ src/auth/            # session client, password/TOTP, appLibrary sync
│  └─ src/player/          # queue/tabs/controller
├─ server/                 # the API (this doc's subject)
│  ├─ src/app.ts           # createApp: helmet, routes, static, error mapper
│  ├─ src/index.ts         # boot: .env load, config, db, listen, shutdown
│  ├─ src/config.ts        # env → ServerConfig (fail-fast in production)
│  ├─ src/db.ts            # node:sqlite, migrations, WAL
│  ├─ src/middleware/      # session, rate limiter, origin check
│  ├─ src/routes/          # auth, library, youtubeAuth, proxy, media, data(cache/settings), apiKeys, admin
│  └─ src/services/        # password, totp, libraryStore, googleOAuth, youtubeOAuth,
│                          # proxy, safeFetch, tokenCipher, cacheStore, youtubeAccount
└─ docs/                   # API.md · INTEGRATION.md · openapi.yaml · FEATURE_INVENTORY.md
```

---

## 3. Authentication flows

### 3.1 Email + password (with optional TOTP)

The default sign-in path for a self-hosted instance — no Google project, no
OAuth client, nothing to register with a third party.

```
Client                              Service
  │ POST /api/auth/register           │
  │  {email,password,name}            │ scrypt-hash password (N=16384)
  │──────────────────────────────────▶│ INSERT users (unique email)
  │◀──────────────────────────────────│ 201 + Set-Cookie: od_sid
  │                                   │
  │ POST /api/auth/login              │
  │──────────────────────────────────▶│ constant-time verify
  │◀──────────────────────────────────│ 200 {status:"ok"}          (no 2FA)
  │                              or   │ 200 {status:"totp_required", challenge}
  │ POST /api/auth/login/totp         │        (still NO cookie)
  │  {challenge, code}                │
  │──────────────────────────────────▶│ verify TOTP (±1 step) or consume
  │                                   │ a single-use backup code
  │◀──────────────────────────────────│ 200 + Set-Cookie: od_sid
```

Integration contract:

- Read `GET /api/auth/session` first and branch on its capability flags:
  `registrationEnabled`, `passwordLoginEnabled`, `googleSignInEnabled`,
  `inviteCodeRequired`. Never assume a Google button exists.
- Keep the `challenge` in memory only (it is an HMAC-signed string with a
  5-minute lifetime); no cookie is issued until the second factor passes.
- Handle **429** on `/login` as a lockout, not a rate limit to retry: 10
  consecutive failures locks that account for 15 minutes and the response
  carries `Retry-After`.
- TOTP enrolment is three calls — `/totp/setup` (returns a base32 secret and
  an `otpauth://` URI), `/totp/enable` (confirm a code, returns 10 backup
  codes — show them once, only digests are stored), and `/totp/disable`
  (needs password **and** a live code).

### 3.2 Google Sign-In (optional — only when configured)

```
Client                          Service                         Google
  │  GET /api/auth/google/start    │                               │
  │  (popup or top-level redirect) │                               │
  │───────────────────────────────▶│ set od_oauth (HMAC state,     │
  │                                │ PKCE verifier, returnTo)      │
  │                                │ 302 authorization_endpoint ◀──│
  │◀───────────────────────────────│                               │
  │  user consents ────────────────┼──────────────────────────────▶│
  │                                │ GET /api/auth/google/callback │
  │                                │◀──────────────────────────────│
  │                                │ verify state+cookie,          │
  │                                │ exchange code (code_verifier),│
  │                                │ verify id_token via JWKS,     │
  │                                │ upsert users, create session, │
  │                                │ set od_sid                    │
  │  HTML + auth-callback.js:      │                               │
  │  postMessage{odAuth, ok}     │                               │
  │◀───────────────────────────────│                               │
  │  GET /api/auth/session → authenticated:true                    │
```

Integration contract:

- **Shipped client: cross-device QR handoff.** `POST
  /api/auth/google/qr/start` → render the returned `qrUrl` as a QR code →
  the phone scans it and runs the consent (callback marks the attempt
  complete and shows a confirmation page — the phone gets **no** session) →
  the desktop presses Verify (`POST /api/auth/google/qr/verify` with the
  `attemptId`) and receives `od_sid`. Attempts are single-use, 10-minute
  bearer handles; `pending` means keep waiting, `409/410/404` mean start a
  new one.
- Same-browser popup contract (still supported server-side): open
  `window.open("/api/auth/google/start?returnTo=/settings", …)` and
  listen for `{odAuth:true, ok:boolean}` on `message` (same origin only).
- The endpoint answers **503** when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
  are unset — hide the button rather than surfacing the error.
- **Also poll `GET /api/auth/session`** every ~1.5 s up to 5 minutes —
  popup blockers, COOP severing `window.opener`, and mobile browsers make
  the message best-effort. The shipped client races both.
- Fallback when popups are blocked: top-level redirect to the same
  `start` URL; the callback page redirects back to `returnTo` after 800 ms.
- Redirect URI registered at Google must equal
  `{APP_URL}/api/auth/google/callback` **exactly** (one URI, Web application
  client type).

### 3.3 YouTube Music linking (account for authenticated InnerTube)

Separate from Google Sign-In — it establishes the YouTube OAuth token the
proxy injects. Uses the **TV device-code flow** entirely server-side:

1. `POST /api/youtube/link` → server scrapes the YouTube TV client identity,
   requests a device code, starts polling, returns
   `{state:"pending", userCode, verificationUrl, expiresInSec}`.
2. User scans the QR code the app renders (it encodes
   `verificationUrl?user_code=…`, so the phone lands on the activation page
   with the code pre-filled) or enters the code at `youtube.com/activate` /
   `google.com/device` manually. The card's **Verify** button checks
   `GET /api/youtube/status` immediately, then the background poller
   completes the link.
3. Server polls, receives tokens, encrypts them (AES-256-GCM,
   HKDF(APP_SECRET)) into `youtube_tokens`, and flips
   `GET /api/youtube/status` to `{state:"linked", linked:true}`.
4. From then on, `POST /api/yt/proxy` attaches
   `Authorization: Bearer <fresh access token>` (+ `x-goog-request-time`)
   to `*.youtube.com/youtubei/*` and `/api/stats/*` requests, refreshing
   transparently (60 s skew; refresh on expiry; `invalid_grant` marks the
   token invalid → `youtubeLinked:false`).
5. `POST /api/youtube/unlink` revokes remotely and deletes local state.

Tokens are **never** serialized into any response — verify with
`GET /api/youtube/status` (state only) and any proxy response (headers
stripped). Link state is per app-user, so multi-user deployments can attach
one YouTube account per user; the proxy pool story for sharing accounts
across users is roadmap work (see §9).

### 3.4 Session mechanics

- Opaque 32-byte id, 30-day sliding expiry (touched after 60 s idle or
  within 15 days of expiry), destroyed server-side on logout.
- Cookie flags: `HttpOnly; SameSite=Lax; Path=/` (+ `Secure` when
  `APP_URL` is https). Set `APP_URL=https://…` behind TLS or cookies will
  be non-`Secure` in production.
- CSRF: mutations with a foreign `Origin` or `Sec-Fetch-Site: cross-site`
  → 403. Non-browser clients (no Origin header) pass — this is how curl,
  tests, and server-side integrations authenticate (they just send
  `Cookie: od_sid=…`).

---

### 3.5 Roles and administration

Every account carries `role = admin | user`, exposed in the session payload
alongside `needsSetup` (no accounts yet) and `oauthProvider`:

- **Bootstrap:** while the instance is empty, `POST /api/auth/register`
stays open (even with `ALLOW_REGISTRATION`/`INVITE_CODE` set) and the
first account created at `/login` becomes the admin.
- **`ADMIN_EMAILS`** grants (and keeps) admin at every sign-in without
demoting anyone else.
- **`/api/admin/*`** requires a browser session on an admin (API keys are
refused, non-admins get 403): user CRUD, role changes (self-demotion and
removing the last admin are blocked), session revocation, TOTP resets for
stuck accounts, the runtime OIDC provider config (`instance_config`,
overrides the `OAUTH_*` env), the public account-creation switch
(`registration.enabled` in `instance_config`, overrides
`ALLOW_REGISTRATION` — closed means `/register` 403s, the sign-up option
vanishes from `/login`, and unknown OIDC identities can no longer mint
accounts; existing accounts and the first-run exemption are unaffected),
and the instance data reset.
- **The reset (`POST /api/admin/reset`)** wipes durable settings + cache
and signs everyone out except the acting admin — and only after that
admin re-proves TOTP (403 otherwise), so a hijacked session alone cannot
destroy data.

---

## 4. Data-plane integration

### 4.1 Search & metadata via `/api/yt/proxy`

The client does **not** speak InnerTube directly — it calls the proxy with
the upstream URL/method/headers/body, and decodes the base64 envelope:

```js
async function proxyFetch(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch("/api/yt/proxy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url, method, headers,
      body_base64: body ? btoa(String(body)) : undefined,
      timeout_ms: 30000,
    }),
  });
  const envelope = await res.json();
  if (!res.ok) throw new Error(envelope.error);            // 400/403/429/502
  const bytes = Uint8Array.from(atob(envelope.body_base64), c => c.charCodeAt(0));
  return new Response(bytes, { status: envelope.status, headers: envelope.headers });
}
```

Notes:

- Envelope HTTP status is **200 on successful forwarding** even when the
  upstream replied 4xx/5xx — always inspect `envelope.status`.
- Request headers `cookie`/`authorization`/`origin`/`referer`/… are
  stripped server-side; the Bearer token is attached there instead when the
  user has a linked YouTube account.
- For full parsing (search shelves, artist/album pages, playlists, stream
  formats) you want `youtubei.js` — the shipped clients construct it with a
  fetch function that routes every request through this proxy. Reuse
  `client/src/datasource/youtube/tauriFetch.ts` (drop-in `fetch`
  replacement) and `YouTubeMusicDataSource` (`search/getStreamData/…`).

Verified example (raw InnerTube search, no client library):

```console
BODY=$(printf '%s' '{"context":{"client":{"clientName":"WEB_REMIX",
  "clientVersion":"1.20260609.07.00","hl":"en","gl":"US"}},"query":"believer"}' | base64 -w0)
curl -s -X POST $API/api/yt/proxy -H 'content-type: application/json' \
  -d "{\"url\":\"https://music.youtube.com/youtubei/v1/search?prettyPrint=false\",
       \"method\":\"POST\",\"headers\":{\"content-type\":\"application/json\",
       \"x-youtube-client-name\":\"67\",
       \"x-youtube-client-version\":\"1.20260609.07.00\"},\"body_base64\":\"$BODY\"}" \
  | jq -r .body_base64 | base64 -d > search.json
```

Lyrics, artwork, and connectivity probes use the same channel
(`lrclib.net`, `api.lrclib.net`, `lyrics-api.boidu.dev`, `*.ytimg.com`,
`*.ggpht.com`, `fonts.gstatic.com`, `cp.cloudflare.com`, …) — extend with
`YT_PROXY_EXTRA_HOSTS`.

### 4.2 Po-token attestation (browser-side, unchanged)

googlevideo now requires a BotGuard `pot` parameter on resolved URLs. The
client mints it **directly in the browser** against
`https://jnn-pa.googleapis.com` (explicitly CSP-`connect-src` allowed);
no API key or proxy involvement. Server-side fetches without it 403 — which
is why the proxy injects nothing here and `/api/media/stream` retries 403
once with YouTube origin headers. If you write your own client, keep
attestation in the browser (see `client/src/datasource/youtube/poToken.ts`).

---

## 5. Playback pipeline

```
search result (videoId)
   │  yt.getBasicInfo(videoId, { po_token })   ── proxy ──▶ InnerTube /player
   │  pick audio format by quality (normal/high; mp4 preference)
   │  decipher signature with session player   ── proxy ──▶ ytimg player script
   ▼
googlevideo https://…/videoplayback?...&pot=…
   │  buildMediaStreamUrl(url)  →  /api/media/stream?url=…
   ▼
<audio src="/api/media/stream?…">      (Range → seek, CORS-free, rate 300/min)
```

Client order falls through per track: authenticated streaming setting
decides `music → web → anonymous` vs `anonymous → web → music`; downloads
try `download` first. Every client is attested (`po_token`); a client that
fails is logged and the next is tried; total failure surfaces
"Unable to resolve a playable YouTube audio stream."

Integration points:

- **Server:** only `GET /api/media/stream` (validate your resolved URL is
  `https://*.googlevideo.com/videoplayback` or it 400s).
- **Your UI:** `new Audio('/api/media/stream?url=' + encodeURIComponent(u))`
  — real-time `timeupdate` drives seek UI; `Range` requests make scrubbing
  instant. Rate budget: 300 requests/min/IP (a seek-heavy client stays
  well under; pre-resolve once per track rather than re-resolving per seek).
- **Downloads:** same endpoint with `fetch` → `blob` → object URL; use the
  `download`-first resolution order for long-lived URLs.

E2E coverage: `e2e/playback.spec.ts` proves search → stream → real-time
seek → pause/resume against a real Google account flow.

---

## 6. Client integration patterns

| Pattern | How | When |
|---|---|---|
| **A. Same-origin SPA** (supported) | Serve UI from this process (`SERVE_CLIENT=1`) or put UI+API behind one origin in your reverse proxy; cookies just work | Default. The shipped React app |
| **B. API-only + separate UI on same origin** | `SERVE_CLIENT=0`, nginx serves the UI and proxies `/api` → the process | Static CDN frontends |
| **C. Server-side / non-browser client** | Send `Cookie: od_sid=…` (obtain via the browser OAuth flow once), no `Origin` header required; enqueue scrobbles/cache/settings from your backend | Bots, desktop wrappers, mobile BFFs |
| **D. Cross-origin browser client** | **Not supported** (no CORS on API routes, CSRF origin check rejects mutations). Build a same-origin BFF instead | — |

Minimal end-to-end script (pattern C):

```bash
API=http://localhost:4000
# 1. obtain od_sid by completing the popup flow in a browser, then:
curl -s -b od_sid=$SID $API/api/auth/whoami
# 2. link YouTube:  curl -s -b od_sid=$SID -X POST $API/api/youtube/link
# 3. search:        POST $API/api/yt/proxy  (§4.1 / API.md §2.4)
# 4. play:          GET  $API/api/media/stream?url=…
# 5. persist:       POST $API/api/settings/set  {"key":"…","value":…}
# 6. api key:       POST $API/api/keys {"label":"cli"}  → plaintext odk_… once
```

---

## 7. Running it

### Development

```bash
cd webapp
npm install
cp .env.example .env          # optional: add Google creds
npm run dev                   # API :4000 (tsx watch) + Vite :5173 (proxies /api)
```

- `npx tsx server/src/index.ts` with `PORT=4000` runs the API alone.
- Restart after editing `.env` (`tsx watch` does not reload it).

### Docker Compose (the recommended way to self-host)

```bash
cd webapp
cp .env.example .env            # set APP_SECRET (openssl rand -hex 32)
docker compose up -d --build
```

- Single multi-stage image: builds the React client + TypeScript server, then
  runs `node server/dist/index.js` as a non-root user on `:4000`.
- SQLite lives in the `opendeck-data` named volume (`/data`), so rebuilds
  and upgrades never touch accounts.
- The image ships a `HEALTHCHECK` against `GET /healthz`; Compose reports
  the container unhealthy if the process stops answering.
- Only `APP_SECRET` is required. Set `APP_URL`/`TRUST_PROXY=true` when you
  put it behind a domain, and `ALLOW_REGISTRATION=false` once your accounts
  exist.
- `HOST_PORT` changes the published port (container stays on 4000).

Upgrade: `git pull && docker compose up -d --build` — data is untouched.

### Production (bare Node)

```bash
npm ci
npm run build                 # client → client/dist, server → server/dist

export NODE_ENV=production
export APP_SECRET="$(openssl rand -hex 32)"
export APP_URL=https://music.example.com
export PORT=4000
export TRUST_PROXY=1
# optional: export GOOGLE_CLIENT_ID=…  GOOGLE_CLIENT_SECRET=…

npm start                     # node server/dist/index.js
```

Fail-fast behavior: missing or short `APP_SECRET` aborts boot with
instructions. Google credentials are **optional** — password accounts work
without them; boot logs a warning when *neither* registration nor Google is
available (nobody could sign in), and another when `APP_URL` is still
localhost in production.

Reverse proxy (nginx/Caddy):

- terminate TLS → `proxy_pass http://127.0.0.1:4000`;
- set `TRUST_PROXY=1` (rate limiting and logs see real client IPs);
- set `APP_URL` to the **https** origin (redirect URI + `Secure` cookies);
- if the UI is served separately, proxy `/api` and `/healthz` to the
  process and keep both under one origin (pattern B).

Verify:

```bash
curl -fsS https://music.example.com/healthz     # {"ok":true,"version":"1.0.0"}
curl -fsSI https://music.example.com/           # CSP, COOP, HSTS present
```

### Scaling & operations notes

| Concern | Current behavior | When you outgrow it |
|---|---|---|
| Process model | Single Node process; `SIGINT/SIGTERM` → drain + close DB (5 s force-exit) | Run N replicas only after externalizing state |
| Rate limits | In-memory fixed window per IP | Move to shared store (Redis) before horizontal scaling |
| Sessions/cache/settings | SQLite (WAL) on `DATA_DIR` | One writer per DB file — single writer today; shard by user or move to a server DB |
| Sessions | Cookie-based, sticky by DB | Any replica with the same DB file works |
| Device-code polls | In-memory `Map` per user | Not replica-safe — pin `/api/youtube/*` to one instance or persist pending state |
| Upstream failures | 502 + structured warn logs | Add retry/circuit-breaking at the proxy layer |
| YouTube tokens | Encrypted per user, auto-refresh | Roadmap: pooled accounts + load balancing (§9) |

Health/monitoring: scrape `GET /healthz`; logs are single-line structured
`[level] message {json}` with automatic redaction (cookies, tokens,
secrets, URLs reduced to origin+path) — safe to ship to a log store;
`LOG_LEVEL=debug` for upstream tracing.

Backups: stop or use `sqlite3 .backup` on `DATA_DIR/app.db` (WAL mode —
copying the file live can lose recent writes).

---

## 8. Security posture (integration checklist)

- [ ] `APP_SECRET` ≥ 32 random chars, unique per environment (rotating it
      invalidates sessions **and** undecrypts stored YouTube tokens).
- [ ] `APP_URL=https://…` + TLS + `TRUST_PROXY=1` behind the proxy.
- [ ] Google OAuth client: type **Web application**, exactly one redirect
      URI `{APP_URL}/api/auth/google/callback`, no JS origin needed.
- [ ] Not exposing port 4000 directly — only the reverse proxy.
- [ ] `SERVE_CLIENT=0` if another layer serves the UI (still same-origin).
- [ ] `YT_PROXY_EXTRA_HOSTS` kept minimal (every entry is fetchable by any
      client, authenticated only by allowlist).
- [ ] Egress rules: the process needs `accounts.google.com`,
      `www.youtube.com`, `*.googlevideo.com`, `*.ytimg.com`,
      `*.googleapis.com`, `ws.audioscrobbler.com`, `lrclib.net`,
      `fonts.*`, `cp.cloudflare.com`.
- [ ] Registration policy decided: `ALLOW_REGISTRATION=false` (or an
      `INVITE_CODE`) once your users exist, so strangers cannot mint accounts.
- [ ] Two-step verification enabled for every account that matters — it is
      offered per account in **Settings → Two-step verification**, and backup
      codes are shown exactly once.
- [ ] Rate-limit buckets sized for your audience (`rateLimit` in routes) —
      `register` 5/min and `login` 10/min are intentionally tight; behind a
      shared NAT raise them or expect lockouts to be IP-scoped.
- [ ] Back up the `opendeck-data` volume (`sqlite3 app.db .backup`); it is
      the only state that exists.

Threat-model details (SSRF-via-redirect hardening, header stripping,
encryption, CSP rationale) are in [API.md §6](API.md#6-security-model-what-the-api-guarantees)
and the README security notes.

---

## 9. Roadmap — planned service capabilities

Done since the first cut: **account passwords + TOTP second factors** and
**server-side per-user playlists/likes** (§3.1, §2.3 in API.md) are live.

Still not implemented; tracked here so integrators know what is coming and
what **not** to rely on today:

1. **Realtime channel (WSS + 15-digit TOTP device/user identity).**
   Clients will authenticate the WebSocket in the handshake header or first
   frame (never the query string), WSS-only. Replay protection (reject a
   duplicate TOTP in the same time step), IP rate limiting, and IP bans for
   repeated auth failures.
2. **Multi-account streaming pool + load balancing.** Multiple Google/YouTube
   accounts attached across users; requests balanced by weight so adding
   accounts reduces per-account quota pressure and wait time.
3. **Transcode cache.** Every played song cached re-encoded to **Opus @96
   kbps** with per-space storage quotas (dedupe + LRU eviction).
4. **Favorites / albums / recently-played as a separate secure service**
   over the "NIX PUCA" domain — a distinct trust boundary from the
   streaming plane.

Until then: the documented HTTP surface above is the contract, and
everything in [API.md](API.md) is implemented and covered by tests
(152 server tests, 39 client tests, 7 Playwright E2E flows).

---

## 10. Testing your integration

```bash
npm test          # server (152) + client (39) unit/integration
npm run test:e2e  # Playwright: needs ports 4000/4100/4310 free
npm run test:all  # both
```

For your own client:

1. Point it at a dev instance (`npm run dev`, API on :4000).
2. Reuse `tauriFetch.ts` (proxy envelope) + `buildMediaStreamUrl` +
   `poToken.ts` — those three files are the entire network contract.
3. Verify 401/403/429/503 behavior against an unconfigured instance
   (`GOOGLE_CLIENT_ID= PORT=4100 npm start`) — the E2E suite does exactly
   this for sign-in.
4. Multi-user checks are cheap to script: register two accounts, create a
   playlist with the first, and confirm the second gets 404 on it (see
   `server/src/library.test.ts` for the canonical assertions).
