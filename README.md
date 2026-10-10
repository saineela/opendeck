# OpenDeck

**A self-hosted, multi-user music client for YouTube Music.**

OpenDeck is a full-stack web application you run on your own server: one
container, one process, any number of accounts. Every user who signs in gets
their **own** library — playlists, liked songs, settings, and YouTube Music
link — isolated from everyone else on the same host.

It is rebuilt from the desktop application
[2latemc/JustAnotherMusicClient](https://github.com/2latemc/JustAnotherMusicClient)
(Tauri + React + TypeScript). That project is the **reference** for the
architecture, UI, and feature set; OpenDeck replaces the desktop shell with a
Node backend and adds multi-user accounts, second-factor authentication,
server-side library storage, and container packaging. See
[Credits and license](#credits-and-license) — upstream is Apache-2.0, which
permits this kind of modification and redistribution.

> Independent project. Not affiliated with, authorized by, sponsored by, or
> endorsed by YouTube or Google.

---

## Features

**Accounts and security**

- **Multiple users per server** — each account's playlists, likes, settings,
  cache namespace, and YouTube link are scoped to its owner.
- **Email + password sign-in** with scrypt-hashed passwords (no Google
  account or OAuth client required to run the server).
- **TOTP two-step verification** (RFC 6238) with single-use backup codes;
  disabling it requires password + live code, so a stolen session can't
  downgrade your account.
- **Optional sign-in with any OIDC provider** (Google, Keycloak, Authentik, …)
  via authorization-code + PKCE; configure through `OAUTH_*` env vars or live
  in **Settings → Admin → Sign-in provider**.
- **Branded sign-in page at `/login`** — first-run admin setup, email +
  password, invite codes, and the TOTP step on one full page you can link to.
- **Admin panel (role based)** — the first account becomes admin (first-run
  setup, `ADMIN_EMAILS` override); admins create users, change roles, revoke
  sessions, reset a stuck second factor, and run a **TOTP-reauthenticated**
  instance data reset from Settings → Admin.
- **Per-account API keys** — mint `odk_…` bearer tokens in Settings → API for
  scripted access; the plaintext key is shown once and only its SHA-256 hash
  is stored. Key management itself still requires the browser session, so a
  leaked key cannot mint or revoke keys.
- Account lockout after repeated failures, per-IP rate limits on every
  auth route, CSRF origin checks, and constant-time comparisons throughout.

**Library**

- **Server-side playlists and liked songs** — create playlists, add/remove/
  reorder tracks, and like songs; they sync through `/api/library` and follow
  the account to any browser.
- **YouTube Music library** merged in when you link an account (library,
  albums, history, subscribe/save/like).
- Local-folder playlists still work for files on your machine.

**Playback**

- Search (tracks, artists, albums, playlists, live suggestions), play/pause,
  seek, volume, shuffle, repeat, autoplay radio.
- Multi-tab players — each tab has its own queue and state; session survives
  reload.
- Queue with drag reorder, play-next, and context menus; synced lyrics.
- **Offline play** — cache tracks in the browser and keep listening without a
  connection. The save-to-**disk** download feature of the desktop app has
  been **removed on purpose**: audio stays in app-managed storage and is never
  handed to the browser's download manager.
- Media Session API (OS media keys, lock-screen controls).

**Social**

- **Song recommendations between accounts** — right-click any track →
  “Recommend to…” sends it (with an optional note) to another registered
  user; it lands in their Recommendations tab with a play button, and a
  Web Push notification fires even when their app is closed. Tracks are
  snapshotted at send time, so recommendations keep working regardless of
  the sender's library. The whole surface is bearer-key compatible, ready
  for a mobile client.

**Interface**

- **Light-first theme with 12 themes** — opens in Daylight by default. Settings → Style
  ships Midnight, Prism (glass), Terminal (rain), the anime-inspired Sakura, Neon Tokyo,
  Ghibli, and Cel Shade, plus Sunset, Deep Sea, Nordic, and a Custom CSS override. Every
  surface follows the active theme — splash screens, menus, toasts, lyrics, and player.

---

## OpenDeck vs JustAnotherMusicClient

OpenDeck started as a faithful web port of
[2latemc/JustAnotherMusicClient](https://github.com/2latemc/JustAnotherMusicClient)
(**JAMC**) — a Tauri (Rust) + React desktop app. Everything JAMC does well was
brought across nearly unchanged; what changed, changed because a browser and a
shared server are not a desktop app with a private profile. Full per-feature
provenance is in [docs/FEATURE_INVENTORY.md](docs/FEATURE_INVENTORY.md).

### Same as JAMC (carried over)

| Area | What you get — identical behaviour to JAMC |
|---|---|
| Playback | Play/pause, seek, volume, next/prev, shuffle, repeat, autoplay radio, queue with drag reorder + play-next |
| Multiple tabs | Each tab has its own queue, volume, and player state; state survives reload |
| Search | Tracks, artists, albums, playlists, live suggestions; Ctrl+K search overlay |
| Browse | Home shelves, artist pages (popular/albums/subscribe), album pages, playlist pages, liked songs |
| Library actions | Like/unlike, save/unsave albums & playlists, add/remove/reorder playlist tracks, Ctrl+S context menus |
| Lyrics | Real-time synced lyrics via LRCLIB, BetterLyrics, YouTube transcripts |
| Recommendations feed | Home-tab personalized suggestions + the **MagicDice** shuffle wheel |
| Caching | LRU cache with size cap, stats, and clear (moved server-side, same semantics) |
| Streaming | youtubei.js InnerTube, po-token/BotGuard attestation, normal/high quality selection, play reporting |
| Offline | Tracks cached for playback without a connection |
| Themes | Theme picker + custom CSS override |
| Media keys | Media Session API (OS media keys, lock-screen controls) |
| Local files | Local-folder playlists and playback |
| Settings | Durable settings that follow the account, keyboard-shortcut editor, onboarding flow |
| Sign-out | Revokes the YouTube session, deletes tokens, clears cache |

### New in OpenDeck (not in JAMC)

| Feature | What it does |
|---|---|
| **Multi-user accounts** | Any number of users on one host; playlists, likes, settings, cache, history, and YouTube link are scoped to the owner |
| **Email + password sign-in** | Runs with zero third-party credentials — no Google OAuth client or YouTube account needed to start |
| **TOTP two-step verification** | RFC 6238 + single-use backup codes; removing it needs password + live code |
| **Any OIDC provider sign-in** | Google, Keycloak, Authentik, … via authorization-code + PKCE, configurable in the admin panel |
| **Admin panel** | Create users, change roles, revoke sessions, reset a stuck 2FA, close/reopen registration, TOTP-gated instance reset |
| **Per-account API keys** | `odk_…` bearer tokens (SHA-256 at rest) for scripted access, with per-key play statistics |
| **Song recommendations between people** | Right-click a track → **Recommend to…** → pick a registered user; it lands in their Recommendations tab with a note, and a **Web Push** notification fires even when the app is closed |
| **Web Push (VAPID)** | Server-side push subscriptions, per device, for recommendation notifications |
| **Documented REST API** | [docs/API.md](docs/API.md), a rendered `/docs` page, and `docs/openapi.yaml` — session cookie *or* bearer key, so a future mobile client can reuse it |
| **Play history + statistics** | Server-side listening history for app and API plays, attributed to the API key |
| **Server-side library** | Playlists and liked songs stored in SQLite — they follow the account to any browser, and survive cleared browser data |
| **QR cross-device sign-in** | Phone completes the consent, desktop claims the session |
| **Container packaging** | Dockerfile + compose, health-check, single named volume for SQLite |
| **YouTube library on the web** | `GET /api/youtube/library` — an OAuth device-code token only works with InnerTube's TVHTML5 client, so the server does the round trip and normalizes it (WEB_REMIX rejects OAuth) |
| **Light-first theming** | Opens in Daylight; 12 themes including Sakura, Neon Tokyo, Ghibli, Cel Shade, Terminal |
| **Independent HTTP surface** | `/api/yt/proxy` (allowlisted InnerTube proxy with Bearer injection), `/api/media/stream` (Range-capable audio), `/api/feed/*`, `/api/cache/*`, `/api/settings/*` |
| **Hardening** | Account lockout, per-IP rate limits, CSRF origin checks, helmet headers, constant-time comparisons, no route accepts a user id |
| **Tests** | 191 server + 39 client unit/integration tests and a Playwright E2E suite with a fake OIDC provider |

### Different from JAMC

| Area | JAMC (desktop) | OpenDeck (web) | Why |
|---|---|---|---|
| Shell | Tauri 2 (Rust), native window, tray, autostart, mini-player window | Browser tab; server serves the SPA | A web app has no OS window |
| YouTube sign-in | Native webview polls SAPISID cookies, OS-keychain encrypted | Google OAuth (code + PKCE) for the account, **device-code** flow for YouTube; tokens AES-256-GCM on the server | Browsers can't read cookies cross-origin; the browser must never hold tokens |
| Upstream traffic | Rust `proxy_http_request` with a cookie jar | `POST /api/yt/proxy`, host-allowlisted, injects `Authorization: Bearer` | CORS + a single choke point |
| Cache / settings | Rust disk LRU + JSON files | SQLite LRU with byte cap, per-user namespace | Shared server, per-account isolation |
| Local files | Full filesystem scan via Rust | File System Access API directory picker (plus `<input type=file>` fallback) | Browser sandbox |
| Custom CSS | Filesystem read/write | Theme picker + custom CSS stored in settings | Browser sandbox |
| Logging | Rust log file + in-app viewer | Server logs + browser console (devtools) | Platform equivalent |
| Mini player, tray, window chrome, updater, release modal | Present | Removed — Media Session API covers OS media keys | Not reproducible in a browser |
| Save-to-disk download | Downloader plugin writes audio files | **Removed on purpose** — offline caching stays in app-managed storage, never handed to the browser download manager | A browser must not hand audio to the OS download manager |
| Last.fm scrobbling | Full Last.fm integration | **Removed** (routes, table, and UI deleted) | Deliberate scope decision |
| Discord RPC | Rich Presence over local IPC | **Not possible in a browser** | Requires local Discord IPC |

**In short:** same music player, same feel — plus accounts, 2FA, an admin
panel, an open API, push-enabled recommendations between people, and Docker.

---

## Quick start — Docker Compose

```bash
git clone <this-repository>
cd <repository>/webapp

cp .env.example .env
# Edit .env: APP_SECRET is mandatory.
#   openssl rand -hex 32

docker compose up -d --build
```

Open **http://localhost:4000**, choose **Create an account**, and sign up —
the first account becomes the instance's **administrator**. Registration can
be closed afterwards with `ALLOW_REGISTRATION=false` or at runtime from
**Settings → Admin → Account creation**.

- Data (SQLite `app.db`) lives in the `opendeck-data` volume, so rebuilds and
  upgrades never touch accounts.
- The image health-checks against `GET /healthz`.
- Behind a domain, set `APP_URL=https://music.example.com` and
  `TRUST_PROXY=true`, and terminate TLS in a reverse proxy in front of it.

Only `APP_SECRET` is required. Google and invite codes are opt-in —
see [.env.example](.env.example).

---

## Quick start — development

```bash
cd webapp
npm install
cp .env.example .env     # optional in dev
npm run dev
```

- Client (Vite HMR): **http://localhost:5173** — proxies `/api` to the server
- Server (tsx watch): **http://localhost:4000**

Search and playback work signed out; sign in to save a library.

### Google Sign-In setup (optional)

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   create an **OAuth client ID → Web application**.
2. Add the redirect URI `<APP_URL>/api/auth/google/callback`
   (dev: `http://localhost:4000/api/auth/google/callback`).
3. Put the client ID/secret in `.env` and restart the server. The sign-in
   dialog shows the Google button only when both are present.

### Connecting YouTube Music (optional)

**Settings → Account → Connect YouTube Music** shows a one-time code. Enter it
at `https://www.youtube.com/activate`, and the server stores the tokens
encrypted. Your YouTube library, playlists, likes, and history then merge with
the playlists you created in OpenDeck.

---

## Production (without Docker)

```bash
npm ci
npm run build                 # client → client/dist, server → server/dist

export NODE_ENV=production
export APP_SECRET="$(openssl rand -hex 32)"
export APP_URL=https://music.example.com
export PORT=4000

npm start                     # serves API + built client on $PORT
```

`NODE_ENV=production` requires `APP_SECRET` (≥ 32 chars) and fails fast without
it. Google credentials are **not** required — password accounts work alone.

Behind a reverse proxy (nginx/Caddy/Traefik):

- terminate TLS and forward to the app; set `TRUST_PROXY=1`
- set `APP_URL` to the public **https** origin (drives OAuth redirect URIs and
  the `Secure` cookie flag)

Verify with `curl https://your-domain/healthz` → `{"ok":true,...}`.

---

## Environment variables

All variables are documented with defaults in [.env.example](.env.example).
The server loads `./.env` and `webapp/.env` on startup; variables already
present in the environment always win.

| Variable | Required | Purpose |
|---|---|---|
| `APP_SECRET` | **production** | Signs cookies/state; derives the token-encryption key |
| `ALLOW_REGISTRATION` | no (`true`) | Baseline for sign-up; admins can override it at runtime in the Admin panel |
| `INVITE_CODE` | no | Require this code to register |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | no | Enables the provider button (`GOOGLE_*` still work as aliases) |
| `OAUTH_PROVIDER_NAME`, `OAUTH_DISCOVERY`, `OAUTH_SCOPES` | no (`Google`, Google's, `openid email profile`) | Provider button label / discovery URL / scopes |
| `ADMIN_EMAILS` | no | Comma-separated emails granted the admin role |
| `TOTP_ISSUER` | no (`OpenDeck`) | Issuer label in authenticator apps |
| `APP_URL` | recommended | Public origin (OAuth redirect URI, cookie `Secure` flag) |
| `PORT` | no (4000) | Listen port |
| `NODE_ENV` | no (development) | `production` enables strict checks |
| `DATA_DIR` / `DB_PATH` | no | SQLite DB location (`/data` in Docker) |
| `TRUST_PROXY` | behind proxy | Honor `X-Forwarded-For` for rate limiting |
| `LOG_LEVEL` | no (`info`) | `debug`–`error` |
| `SERVE_CLIENT` | no (`1`) | `0` runs API-only |
| `YT_PROXY_EXTRA_HOSTS` | no | Extra allowlisted proxy hostnames |
| `VITE_API_TARGET`, `VITE_REPOSITORY_URL` | client build only | Vite proxy target; source link target |

---

## API documentation

This repo ships a **standalone music service API** with full documentation:

| Doc | Contents |
|---|---|
| [docs/API.md](docs/API.md) | Complete HTTP reference — every endpoint, request/response schemas, auth (password/TOTP/OAuth) & CSRF rules, rate limits, error format, security headers, config table, curl recipes |
| `/docs` | The same reference as a **web page** — served read-only at `http://localhost:4000/docs`, rendered server-side from `docs/API.md` with a table of contents |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | System integration — architecture, auth flows (password, TOTP, OIDC, YouTube device code, roles & admin panel), playback pipeline, client integration patterns, Docker + reverse-proxy deployment, ops, security checklist, roadmap |
| [docs/openapi.yaml](docs/openapi.yaml) | Machine-readable OpenAPI 3.1 spec (validated against the routes) |
| [docs/FEATURE_INVENTORY.md](docs/FEATURE_INVENTORY.md) | Feature-by-feature audit vs the original desktop app |

### API overview

| Endpoint | Auth | Description |
|---|---|---|
| `GET /healthz` | — | Liveness + version |
| `GET /api/auth/session` | cookie | Session + capability flags (`authenticated`, `totpEnabled`, `googleSignInEnabled`, …) |
| `POST /api/auth/register` | — | Create an email/password account (rate-limited, optional invite code) |
| `POST /api/auth/login` | — | Password sign-in; returns `totp_required` + challenge when 2FA is on |
| `POST /api/auth/login/totp` | challenge | Complete sign-in with a TOTP code or backup code |
| `GET /api/auth/totp/status` · `POST /setup` · `/enable` · `/disable` | session | Two-step verification lifecycle |
| `GET /api/auth/google/start` · `/callback` | — | Optional Google OAuth (PKCE); 503 when unconfigured |
| `POST /api/auth/google/qr/start` · `GET /qr/open` · `POST /qr/verify` | — | Cross-device QR sign-in: phone runs the consent, desktop claims the session with Verify |
| `POST /api/auth/logout` · `GET /api/auth/whoami` | cookie | Session lifecycle |
| `GET /api/library` · `POST /api/library/sync` | session | Full per-user library snapshot / bulk sync |
| `GET/POST /api/library/playlists` · `GET/PATCH/DELETE /playlists/:id` | session | Playlist CRUD |
| `POST /playlists/:id/tracks` · `DELETE /playlists/:id/tracks/:trackId` · `POST /playlists/:id/reorder` | session | Playlist contents |
| `GET /api/library/likes` · `PUT/DELETE /likes/:trackId` | session | Liked songs |
| `GET /api/youtube/status` · `POST /api/youtube/link` · `/cancel` · `/unlink` | session | Device-code linking lifecycle |
| `POST /api/yt/proxy` | session (optional) | CORS proxy to allowlisted YouTube hosts; injects `Authorization: Bearer` when linked |
| `GET /api/media/stream?url=…` | — | Range-capable audio passthrough (rate-limited); **records play history** (app + API plays) |
| `GET/POST /api/cache/*` | — | LRU cache stats/trim/clear (per-user namespace) |
| `GET/POST /api/settings/*` | session | Durable per-user app settings |
| `GET/POST /api/keys` · `DELETE /api/keys/:id` | cookie session | Per-account API keys (plaintext returned once at creation); list includes **per-key play statistics** |
| `GET /api/history` · `GET /api/history/stats` · `DELETE /api/history` | session | Play history (web + API plays, attributed to the key) + listening statistics |
| `GET/POST/DELETE /api/recommendations/*` | session | Send/receive song recommendations between accounts (directory, inbox, sent, read, delete) |
| `GET/POST /api/push/*` | cookie session | Web Push subscriptions for recommendation notifications (VAPID key, subscribe, unsubscribe) |
| `GET/POST/PATCH/DELETE /api/admin/*` | cookie session (admin) | Roles, user CRUD, session revocation, OIDC config, TOTP-gated reset |

Authenticated routes accept either the session cookie **or** an
`Authorization: Bearer odk_…` API key; key management, TOTP reconfiguration,
and push subscriptions accept the cookie only. Routes resolve their user **from the credential only** —
there is no route that accepts a user id, so one account cannot address
another's rows even with a crafted URL.

Mutations are protected by a same-origin check (rejects cross-site `Origin` /
`Sec-Fetch-Site`); responses ship `helmet` headers (CSP, COOP, HSTS, `nosniff`,
`frame-ancestors`).

---

## Testing

```bash
npm test          # server (191) + client (39) unit & integration tests
npm run test:e2e  # Playwright end-to-end suite
npm run test:all  # both
```

First E2E run:

```bash
npx playwright install chromium
npm run test:e2e
```

The E2E harness (`playwright.config.ts`) starts three processes and **requires
ports 4000, 4100, and 4310 to be free**:

1. a **fake Google OIDC provider** (`e2e/fixtures/fake-google.ts`, PKCE-enforcing, auto-approving) — no Google account or credentials needed,
2. the **app under test** on `:4000` pointed at the fake provider,
3. an **unconfigured app** on `:4100` that verifies graceful "sign-in not configured" behavior.

Covered flows: boot/onboarding skip + first-run tour, SPA fallback + health,
settings navigation, unconfigured sign-in, **full browser OAuth popup sign-in →
reload session persistence → logout**, and **search → stream through
`/api/media/stream` → real-time seek → pause/resume → queue toggle**.

---

## Bare API test client

`test-app/` is a framework-free page that talks to **nothing but this server's
own endpoints** — useful for poking at the API (and for seeing every request
in one place):

```bash
npm run build:test-app   # bundles test-app/vendor/engine.js (rarely needed)
npm run dev               # then open http://localhost:4000/test-app/
```

Panels: health + security headers · Google sign-in (popup flow) · YouTube
device-code link · search · player + queue (streams via `/api/media/stream`) ·
cache/settings probes · a live log of **every** request the page makes,
including the InnerTube calls routed through `/api/yt/proxy` and the audio
element's media requests (captured via resource timing).

The engine bundle (`vendor/engine.js`) is the real data layer
(youtubei.js + BotGuard po-token + proxy fetch) built with esbuild — its whole
network surface is `/api/yt/proxy`, `/api/media/stream`, and `/api/cache/*`.

---

## Project structure

```
webapp/
├─ package.json            # workspace root: dev/build/start/test scripts
├─ Dockerfile              # multi-stage: build client+server, slim runtime
├─ docker-compose.yml      # one service + named volume for SQLite
├─ playwright.config.ts    # E2E: fake IdP + app + unconfigured app
├─ .env.example            # every environment variable, documented
├─ LICENSE · NOTICE        # Apache-2.0 + upstream attribution
├─ e2e/
│  ├─ fixtures/fake-google.ts   # standalone OIDC provider for tests
│  ├─ fixtures/helpers.ts       # shared selectors/setup
│  └─ *.spec.ts
├─ test-app/                    # bare API test client (served at /test-app)
├─ client/                 # Vite + React 19 + youtubei.js
│  ├─ src/ui/              # App shell, pages, components (AuthDialog, SecurityCard…)
│  ├─ src/player/          # PlayerController, Queue, TabManager, LibraryController…
│  ├─ src/datasource/      # DataSource abstraction + YouTubeMusicDataSource
│  ├─ src/auth/            # session client, password/TOTP, appLibrary sync
│  └─ src/internal/        # settings, cache, logging, persistence
├─ server/                 # Express 5 + node:sqlite + jose
│  ├─ src/routes/          # auth, library, youtubeAuth, proxy, media, data
│  ├─ src/services/        # password, totp, libraryStore, googleOAuth, cacheStore…
│  ├─ src/middleware/      # session, rate limit, CSRF origin check
│  └─ src/db.ts            # schema + migrations (v2: multi-user + library)
└─ docs/                   # API.md · INTEGRATION.md · openapi.yaml · FEATURE_INVENTORY.md
```

---

## Security notes

- **Isolation first** — every per-user table (users, sessions, YouTube tokens,
  settings, cache, playlists, likes) is keyed by the session's user
  id; requests never accept a user id from the client.
- **Passwords** — scrypt (N=16384, r=8, p=1, 64-byte key, per-user salt),
  parameters stored in the hash so they can be raised later; verification is
  constant-time, and an unknown account burns equivalent work so timing does
  not reveal whether the email exists.
- **Second factor** — TOTP secrets are only *enrolled* after a valid code is
  confirmed; backup codes are stored as SHA-256 digests and are single-use;
  removing TOTP needs password + current code.
- **Lockout** — 10 consecutive failures locks the account for 15 minutes
  (429 + `Retry-After`), and the counter clears on successful sign-in.
- OAuth secrets and YouTube refresh tokens live **only** on the server; the
  browser holds an opaque `HttpOnly` session cookie (`SameSite=Lax`, `Secure`
  on https).
- Tokens at rest: AES-256-GCM with a key derived via HKDF(`APP_SECRET`); the
  DB holds ciphertext + nonce + auth tag only.
- OAuth `state` is HMAC-signed and single-use; PKCE (`S256`) is enforced.
- Strict CSP (`default-src 'self'`) with only the relaxations playback needs
  (`unsafe-eval` for signature deciphering, `jnn-pa.googleapis.com` for
  BotGuard).
- Host-allowlisted proxy with header stripping (no cookie/origin leakage
  upstream); rate limits on auth, media, and proxy routes.
- Recommended deployment: TLS + `TRUST_PROXY=1` + `APP_URL=https://…`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Registration is disabled on this server" | An admin closed self-service sign-up (Admin panel → Account creation) or `ALLOW_REGISTRATION=false` — reopen it there, or sign in with an existing account |
| "A valid invite code is required" | Set `INVITE_CODE` in `.env` and share it, or unset it |
| "Google Sign-In is not configured" | Expected when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are unset — use email + password instead |
| Sign-in redirect URI mismatch | The URI in Cloud Console must exactly match `APP_URL` + `/api/auth/google/callback` |
| "Too many failed attempts" | Account locked for 15 min after 10 failures; wait it out (429 includes `Retry-After`) |
| YouTube connect code not accepted | Use the exact code at `youtube.com/activate`; codes expire in ~30 min, cancel and retry |
| Playback stalls on a track | YouTube may throttle; retry, or link YouTube Music and enable "Stream with your account" |
| `proxy.forward failed … fetch failed` warnings | Upstream YouTube host unreachable from your network/region; retry or check egress |
| E2E: port already in use | Free ports 4000/4100/4310 (or set `E2E_APP_PORT`, `E2E_UNCONFIGURED_PORT`, `E2E_FAKE_GOOGLE_PORT`) |
| Autoplay blocked in the browser | Interact with the page once (a click) before/while a track starts |

---

## Credits and license

**Reference project.** OpenDeck was built by reverse-engineering
[**JustAnotherMusicClient**](https://github.com/2latemc/JustAnotherMusicClient)
by 2latemc — a desktop YouTube Music client written with Tauri, React, and
TypeScript. Its application logic, UI structure, and feature set are the
reference for this work, and its README, screenshots, and design informed the
interface you see here. All credit for the original concept and implementation
belongs to that project's author.

**License.** JustAnotherMusicClient is licensed under the
**Apache License, Version 2.0** ([LICENSE](LICENSE) in this repository; upstream
copy: [2latemc/JustAnotherMusicClient/blob/main/LICENSE](https://github.com/2latemc/JustAnotherMusicClient/blob/main/LICENSE)).
Apache-2.0 expressly permits reproduction, modification, and distribution —
including under a different project name — provided that:

- a copy of the Apache-2.0 license is distributed with the work (**[LICENSE](LICENSE)**),
- changes are stated in a prominent place (**[NOTICE](NOTICE)** lists the
  modifications made here), and
- attribution to the original project is retained (**this section** and
  [NOTICE](NOTICE)).

Upstream ships no `NOTICE` file of its own, so no additional notices need to be
carried forward beyond this attribution.

**Third-party.** Streaming uses
[youtubei.js](https://github.com/LuanRT/YouTube.js) (MIT); lyrics use LRCLIB
and BetterLyrics. Not affiliated with Google or YouTube.

**Domain names.** "YouTube" and "Google" are trademarks of their respective
owners; this project is not endorsed by them.
