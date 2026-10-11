# OpenDeck API — Reference

Complete HTTP reference for **OpenDeck**, the standalone music service
(server package `opendeck-server`, Express 5 + `node:sqlite`). Everything a
client needs to create accounts, sign in (password, TOTP, Google), manage a
per-user library, search, stream audio, cache data, persist settings, and
scrobble.

- Companion guides: [INTEGRATION.md](INTEGRATION.md) (system integration,
  deployment, flows), [openapi.yaml](openapi.yaml) (machine-readable spec),
  [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md) (feature audit).

---

## 1. Conventions

### Base URL

All paths are relative to the service origin. Development default:
`http://localhost:4000`. In production set `APP_URL` to the public origin
(e.g. `https://music.example.com`) — it drives OAuth redirect URIs and the
cookie `Secure` flag.

### Content types

| Direction | Type |
|---|---|
| Request bodies (mutations) | `application/json` |
| Responses (except media + callback HTML/JS) | `application/json; charset=utf-8` |
| `GET /api/media/stream` | passthrough audio (`audio/mp4`, `audio/webm`, …) |
| `GET /api/artwork` | cached image bytes (`image/jpeg`, `image/webp`, …) |

JSON bodies are capped at **10 MB** (`express.json({ limit: "10mb" })`).
A malformed body returns **400** `{"error":"Invalid JSON body."}`; an
oversized one returns **413** `{"error":"Request body too large."}`.

### Error envelope

Every error is a JSON object with a single human-readable field:

```json
{ "error": "Sign in is required." }
```

| Status | Meaning |
|---|---|
| 400 | Invalid/malformed request (payload, URL, method, JSON, key) |
| 401 | No valid session cookie or API key on an authenticated route; wrong email/password; invalid TOTP code |
| 403 | Cross-site request rejected (CSRF) or proxy host not allowed |
| 404 | Unknown `/api/*` route — `{"error":"Not found."}` |
| 409 | Conflict (duplicate email, playlist id in use) |
| 413 | Body or cache entry too large |
| 429 | Rate limited — always accompanied by a `Retry-After` header (seconds) |
| 500 | Unhandled server error — `{"error":"Internal server error."}` |
| 502 | Upstream (Google / YouTube / googlevideo) failure |
| 503 | Feature not configured on this server (Google Sign-In) |

### Authentication

Two schemes authenticate a request:

| Scheme | How | Accepted by |
|---|---|---|
| Session cookie `od_sid` | `credentials: "same-origin"` (browser) or a `Cookie:` header (non-browser) | Every authenticated route — the **only** scheme on `/api/keys`, the TOTP setup/enable/disable routes, and `/api/push/*` |
| API key | `Authorization: Bearer odk_…` header | Every authenticated route except the cookie-only ones above; keys are created in Settings → API (see §2.10) |

| Cookie | Set by | Purpose | Attributes |
|---|---|---|---|
| `od_sid` | successful registration, password login, TOTP login, or Google callback | 64-hex session id, 30-day sliding expiry | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `APP_URL` is https |
| `od_oauth` | `GET /api/auth/google/start` | HMAC-signed PKCE state (single-use, 10 min) | same as above |
| `od_qr_attempt` | `GET /api/auth/google/qr/open` | Marks the phone side of a QR sign-in attempt so the callback skips session creation (single-use, 10 min) | same as above, `Path=/api/auth` |
| — | `POST /api/auth/login` (2FA accounts) | Returns a short-lived signed `challenge` string instead of a cookie; exchange it at `/login/totp` | n/a (kept in memory by the client) |

Send cookies with `credentials: "same-origin"` (browser) or a `Cookie:`
header (non-browser); non-browser clients may send an API key instead.
Routes marked **session** below return 401 without either;
routes marked **cookie** read it when present but work anonymously.

`GET /api/auth/session` describes the caller: `role` (`admin`/`user`/`null`),
`needsSetup` (true while the instance has no accounts — the sign-in page
then offers first-run admin creation), and `oauthProvider`
(`{name, configured}` for the custom OIDC button).

### CSRF (origin check)

All non-`GET`/`HEAD`/`OPTIONS` requests are rejected with **403** when:

- `Sec-Fetch-Site: cross-site` is present, or
- an `Origin` header is present and does not match `APP_URL` (or the request
  `Host`) origin, or is unparseable.

Requests **without** an `Origin`/`Sec-Fetch-Site` header (curl, server-side
fetch, tests) pass. Cross-origin browser pages cannot call mutations —
serve your client same-origin or proxy through your own backend.

### Rate limits

Fixed 60-second windows, keyed by client IP + bucket. Exceeding returns
429 + `Retry-After`. With `TRUST_PROXY=1` the limiter sees the real client IP.

| Bucket | Route(s) | Limit |
|---|---|---|
| `register` | `POST /api/auth/register` | 5 / min |
| `login` | `POST /api/auth/login` · `POST /api/auth/login/totp` | 10 / min |
| `totp` | `POST /api/auth/totp/*` | 15 / min |
| `google-start` | `GET /api/auth/google/start` · `GET /api/auth/google/qr/open` | 20 / min |
| `google-qr` | `POST /api/auth/google/qr/start` · `POST /api/auth/google/qr/verify` | 10 / min |
| `library` | `/api/library/*` | 300 / min |
| `feed` | `/api/feed/*` | 120 / min |
| `yt-link-start` | `POST /api/youtube/link` | 10 / min |
| `yt-proxy` | `POST /api/yt/proxy` | 900 / min |
| `media` | `GET /api/media/stream` | 300 / min |
| `history` | `/api/history/*` | 180 / min |
| `recommend-send` | `POST /api/recommendations` | 30 / min |
| `recommend-read` | recommendation reads, marks, deletes | 180 / min |
| `push-sub` | `/api/push/*` | 30 / min |
| `cache` | `/api/cache/*` | 600 / min (6000 / min for `GET /api/artwork`) |
| `settings` | `/api/settings/*` | 300 / min |
| `apikeys` | `GET /api/keys` · `DELETE /api/keys/:id` | 60 / min |
| `apikeys-create` | `POST /api/keys` | 10 / min |
| `admin-list` | `GET /api/admin/*` | 60 / min |
| `admin-mutate` | admin `PATCH`/`DELETE`/`POST` mutations, `PUT /api/admin/oauth`, `PUT /api/admin/registration` | 30 / min |
| `admin-create` | `POST /api/admin/users` | 10 / min |

Rate-limit state is in-memory (single-process deployments). Behind a reverse
proxy set `TRUST_PROXY=1` so IPs are not collapsed to the proxy address.

### Security headers

Every response ships `helmet` headers: a strict CSP
(`default-src 'self'` with the minimal playback relaxations — see
`app.ts`), `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Resource-Policy: same-origin`,
`Referrer-Policy: strict-origin-when-cross-origin`, HSTS,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`.
`GET /api/media/stream` additionally sets `Access-Control-Allow-Origin: *`.

---

## 2. Endpoint reference

### 2.1 Health

#### `GET /healthz`

Liveness/readiness probe. No auth, no rate limit.

```console
$ curl -s http://localhost:4000/healthz
{"ok":true,"version":"1.0.0"}
```

| Field | Type | Description |
|---|---|---|
| `ok` | boolean | Always `true` when the process is serving |
| `version` | string | Service version (`1.0.0`) |

---

### 2.2 Authentication — `/api/auth`

#### `GET /api/auth/session` · `GET /api/auth/whoami`

`session` is anonymous-friendly (reports signed-out state); `whoami` requires
a session (401 otherwise). Same payload:

```json
{
  "authenticated": true,
  "user": { "name": "Ada", "email": "ada@example.com", "picture": null },
  "youtubeLinked": false,
  "totpEnabled": true,
  "authProvider": "password",
  "passwordLoginEnabled": true,
  "registrationEnabled": true,
  "googleSignInEnabled": false,
  "inviteCodeRequired": false
}
```

| Field | Type | Description |
|---|---|---|
| `authenticated` | boolean | Valid `od_sid` cookie resolved to a user |
| `user` | object \| null | `name`, `email`, `picture` (null when signed out) |
| `youtubeLinked` | boolean | A valid YouTube Music token exists for this user |
| `totpEnabled` | boolean | This account requires a second factor at sign-in |
| `authProvider` | string \| null | `"password"` or `"google"`; null when signed out |
| `passwordLoginEnabled` | boolean | Whether `POST /login` is open (`ALLOW_REGISTRATION`) |
| `registrationEnabled` | boolean | Whether self-service sign-up is open — env baseline overridden by the admin panel's runtime switch (`PUT /api/admin/registration`) |
| `googleSignInEnabled` | boolean | A Google OAuth client is configured — show the button |
| `inviteCodeRequired` | boolean | Registration demands an `inviteCode` |

Branch on these flags instead of assuming a sign-in method: hide the Google
button when `googleSignInEnabled` is false, and hide the sign-up form when
`registrationEnabled` is false.

#### `POST /api/auth/register`

Creates an email/password account and signs it in (sets `od_sid`).
Rate limited to **5/min/IP**.

```json
// request
{ "email": "ada@example.com", "password": "correct horse battery", "name": "Ada", "inviteCode": "optional" }
```

| Field | Rules |
|---|---|
| `email` | required, lower-cased and trimmed, must look like an address (max 254) |
| `password` | required, **8–256 characters** (length-only policy, NIST-style) |
| `name` | optional, trimmed, max 80 chars (defaults to the email local part) |
| `inviteCode` | required when `INVITE_CODE` is configured; compared in constant time |

```json
// 201
{ "ok": true, "user": { "name": "Ada", "email": "ada@example.com", "picture": null } }
```

| Status | Case |
|---|---|
| **201** | Account created and session issued |
| **400** | Invalid email, or password below the length floor |
| **403** | Registration disabled (`ALLOW_REGISTRATION=false`) or wrong invite code |
| **409** | An account with that email already exists |
| **429** | More than 5 attempts in a minute |

A Google identity is never bound onto an existing password account with the
same address (and vice versa): the two stay separate so neither credential can
inherit the other.

#### `POST /api/auth/login`

Step 1 of password sign-in. Rate limited to **10/min/IP**. The failure
response is deliberately identical for an unknown email and a wrong password.

```json
// request
{ "email": "ada@example.com", "password": "correct horse battery" }
```

```json
// 200 — no second factor: cookie is set
{ "status": "ok", "user": { "name": "Ada", "email": "ada@example.com", "picture": null } }

// 200 — second factor required: NO cookie is set yet
{ "status": "totp_required", "challenge": "<hmac-signed>", "expiresInSeconds": 300 }
```

| Status | Case |
|---|---|
| **200** | Password accepted (`ok` or `totp_required`) |
| **401** | Wrong password or unknown email (identical body) |
| **403** | Password sign-in disabled on this server |
| **429** | 10 consecutive failures locked the account for 15 minutes, or the IP is rate-limited |

#### `POST /api/auth/login/totp`

Step 2 — exchanges the challenge for a real session. Accepts a 6-digit TOTP
code **or** one of the 10 single-use backup codes (a code that is not 6 digits
is treated as a backup code). Rate limited by both `login` (10/min) and
`totp` (15/min) buckets per IP.

```json
// request
{ "challenge": "<value from /login>", "code": "123456" }

// 200
{ "status": "ok", "user": { "name": "Ada", "email": "ada@example.com", "picture": null } }
```

| Status | Case |
|---|---|
| **200** | Code accepted; `od_sid` set, failure counter cleared |
| **401** | Unknown, expired, or forged challenge; wrong code |
| **429** | Account locked or IP rate-limited |

A consumed backup code is deleted server-side, so replaying it returns 401.

#### `GET /api/auth/totp/status`

```json
{ "enabled": true, "enrolled": true, "backupCodesRemaining": 7 }
```

Requires a session **and** a `password` account — Google accounts get **400**
(their second factor lives at Google, so a local one would be security
theatre).

#### `POST /api/auth/totp/setup`

Requests and stores a fresh secret **without enabling it** — `enabled` stays
false until a valid code proves the authenticator was really scanned, so a
half-finished setup can never lock anyone out. Replaces any unconfirmed
secret.

```json
// 200
{
  "secret": "JBSWY3DPEHPK3PXP",
  "otpauthUri": "otpauth://totp/OpenDeck%3Aada%40example.com?secret=…&issuer=OpenDeck&algorithm=SHA1&digits=6&period=30",
  "issuer": "OpenDeck",
  "digits": 6,
  "periodSeconds": 30
}
```

Enter the `secret` manually in any authenticator app (SHA-1, 6 digits, 30 s).

#### `POST /api/auth/totp/enable`

```json
// request
{ "code": "123456" }

// 200 — write these down now; only SHA-256 digests are stored server-side
{ "enabled": true, "backupCodes": ["A1B2C-D3E4F", "5G6H7-J8K9L", "…"] }
```

**400** for a wrong code (state unchanged) · **409** when already enabled.

#### `POST /api/auth/totp/disable`

Removing the second factor requires re-authentication — a stolen session is
not enough to downgrade account security:

```json
// request
{ "password": "correct horse battery", "code": "123456" }
```

**200** `{"enabled":false}` · **400** when the password or code is wrong ·
**409** when it is not enabled.

#### `POST /api/auth/logout`

Destroys the session server-side and clears the cookie. Works with or
without a session.

```json
{ "ok": true }
```

#### `GET /api/auth/google/start?returnTo=/settings`

**Optional** — only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are
configured; otherwise it answers 503 (see below).

Begins Google Sign-In (authorization-code + PKCE `S256`).

- **200/302** → redirects to Google's `authorization_endpoint` with
  `client_id`, `redirect_uri = {APP_URL}/api/auth/google/callback`,
  `response_type=code`, `scope` (default `openid email profile`),
  `state`, `code_challenge`, `code_challenge_method=S256`,
  `access_type=offline`, `prompt=select_account`. Sets `od_oauth`.
- **503** when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are unset:
  `{"error":"Google Sign-In is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see .env.example)."}`.
- **429** past 20/min · **502** if discovery fails.
- `returnTo` must be a same-site absolute path starting with `/` (not
  `//`); anything else becomes `/`.

#### `GET /api/auth/google/callback?code=…&state=…`

OAuth landing page (browser navigates here). Validates the HMAC-signed
`od_oauth` cookie and `state`, exchanges the code (with `code_verifier`),
verifies the ID token against the provider JWKS, upserts the user (matched
on `google_sub`), and then branches on the `od_qr_attempt` cookie:

- **QR attempt (phone)** → marks the attempt complete with the resolved
  user id and renders a plain "Signed in on your computer" confirmation
  page. **No session cookie is set on this browser** — the desktop claims
  the session via `POST /api/auth/google/qr/verify`.
- **Direct / popup** → creates the session, sets `od_sid`, and returns a
  small HTML page that `postMessage`s `{ odAuth: true, ok: boolean }` to the
  opener and closes itself (or redirects to `returnTo` when opened top-level).

- **200** `text/html` on success · **400** `text/html` on any failure
  (expired cookie, tampered cookie, state mismatch, cancelled consent,
  exchange failure) with the reason visible in `<p id="auth-error">`.
- Query `?error=…` from the provider maps to "Google sign-in cancelled or refused."

#### `POST /api/auth/google/qr/start`

Creates a cross-device sign-in attempt (the QR flow the shipped login page
uses). Arms a single-use, high-entropy id for 10 minutes and returns the
link to encode as a QR code. Rate limit: 10/min.

```json
{ "attemptId": "…", "qrUrl": "{APP_URL}/api/auth/google/qr/open?attempt=…", "expiresInSec": 600 }
```

- **503** when no OIDC client is configured · **429** past 10/min.

#### `GET /api/auth/google/qr/open?attempt=…`

Phone-facing entry point after scanning the QR code. Validates the attempt,
sets `od_oauth` + `od_qr_attempt`, and 302-redirects to the provider's
authorization endpoint — the consent runs entirely on the phone.

- **302** on success · **404** unknown/consumed attempt (HTML) ·
  **410** expired (HTML) · **502** discovery failure · **503** not configured.

#### `POST /api/auth/google/qr/verify`

The desktop **Verify** button. Reports `pending` while the phone has not
finished; on a completed attempt it mints the session for *this* browser
(sets `od_sid`) and consumes the attempt — each attempt issues at most one
session, so the id acts as a single-use bearer token for 10 minutes. Rate
limit: 10/min.

```bash
curl -sS -X POST "$APP_URL/api/auth/google/qr/verify" \
  -H 'content-type: application/json' \
  -d '{"attemptId":"<attemptId from qr/start>"}'
# {"status":"pending"} → retry after finishing on the phone
# {"status":"verified","user":{…}} → od_sid set for this client
```

- **400** missing id · **404** unknown id · **409** already consumed ·
  **410** expired.

#### `GET /api/auth/auth-callback.js`

The popup helper script referenced by the callback page
(`application/javascript`). Contract for your own client:

```js
window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  const data = event.data;                       // { odAuth: true, ok: boolean }
  if (data && data.odAuth === true) { /* ok === true → session cookie is set */ }
});
window.open("/api/auth/google/start?returnTo=%2F", "opendeck-signin", "width=520,height=640");
```

Because popup delivery can be blocked, also poll `GET /api/auth/session`
until `authenticated` flips true (the shipped client polls every 1.5 s with
a 5-minute deadline).

#### `POST /api/auth/logout`

Destroys the session server-side and clears the cookie. Works with or
without a session.

```json
{ "ok": true }
```

---

### 2.3 Library — `/api/library`

This account's **own** library: playlists, their ordered tracks, and liked
songs, stored server-side so they follow the account to any browser. It is
separate from the linked YouTube Music library, which the client merges
alongside it.

All routes **require a session** and are scoped to the session's user id —
there is no route that accepts a user id, so another account cannot address
your rows even with a crafted URL (a foreign or unknown id simply reads as
404). Rate limited to **300/min**.

Track payloads use the client's track shape:

```json
{
  "id": "dQw4w9WgXcQ",
  "source": "youtube",
  "title": "Never Gonna Give You Up",
  "artist": "Rick Astley",
  "album": "Whenever You Need Somebody",
  "artworkUrl": "https://…/hqdefault.jpg",
  "durationSec": 213
}
```

`id` (≤256) and `title` (≤300) are required; `source` defaults to `"youtube"`.

#### `GET /api/library`

Full snapshot — everything the client needs in one round trip.

```json
{
  "playlists": [
    {
      "id": "pl-6f1c…", "name": "Road Trip", "description": null,
      "artworkUrl": null, "createdAt": 1791520291780, "updatedAt": 1791520291780,
      "trackCount": 2,
      "tracks": [
        { "id": "t2", "source": "youtube", "title": "Second", "artist": "Beta",
          "album": null, "artworkUrl": null, "durationSeconds": null,
          "position": 0, "addedAt": 1791520316756 }
      ]
    }
  ],
  "likedSongs": [
    { "id": "t1", "source": "youtube", "title": "First", "artist": "Alpha",
      "album": null, "artworkUrl": null, "durationSeconds": 180 }
  ],
  "counts": { "playlists": 1, "likedSongs": 1 }
}
```

#### `POST /api/library/sync`

Bulk **replace** of this account's library — the sync endpoint a client
pushes its full snapshot to. Anything absent from the snapshot is deleted, so
it implements device-to-device sync: pull, merge locally, push.

```json
// request — either shape works
{ "snapshot": { "playlists": [ … ], "likedSongs": [ … ] } }
{ "playlists": [ … ], "likedSongs": [ … ] }

// 200
{ "playlists": 2, "likedSongs": 14, "tracks": 37 }
```

Applies in a single transaction: a validation failure rolls back completely
and never leaves a half-applied library (400 in that case). Limits: 500
playlists, 1000 tracks per playlist, 20 000 likes (413 beyond).

#### `GET /api/library/playlists`

```json
{ "playlists": [ { "id": "pl-…", "name": "Road Trip", "description": null,
                   "artworkUrl": null, "trackCount": 2,
                   "createdAt": …, "updatedAt": … } ] }
```

Newest activity first.

#### `POST /api/library/playlists`

```json
// request
{ "name": "Road Trip", "description": "Windows down", "artworkUrl": "https://…" }

// 201
{ "playlist": { "id": "pl-6f1c…", "name": "Road Trip", …, "trackCount": 0 } }
```

**400** empty or >120 char name · **413** past 500 playlists · **429** rate
limit.

#### `GET /api/library/playlists/:id`

```json
{ "playlist": { "id": "pl-…", "name": "Road Trip", …, "trackCount": 2 },
  "tracks": [ { "id": "t2", …, "position": 0, "addedAt": … }, … ] }
```

Tracks come back in playlist order. **404** when the id does not exist
**or belongs to another account**.

#### `PATCH /api/library/playlists/:id`

```json
// request — any subset
{ "name": "Road Trip 2026", "description": "…", "artworkUrl": "…" }

// 200
{ "playlist": { … } }
```

#### `DELETE /api/library/playlists/:id`

```json
{ "ok": true }
```

Cascades to its tracks. **404** if not found (or not yours).

#### `POST /api/library/playlists/:id/tracks`

```json
// request
{ "tracks": [ { "id": "t1", "title": "First", "artist": "Alpha" } ] }

// 200
{ "added": 1, "replaced": 0, "trackCount": 3, "trackIds": ["t1"] }
```

At most 200 tracks per call (413). Duplicate ids inside the batch collapse to
one; an id already in the playlist is **replaced in place** (metadata
refreshed, position preserved) and counted under `replaced`.

#### `DELETE /api/library/playlists/:id/tracks/:trackId`

```json
{ "ok": true }
```

`{"ok":false}` when the track simply is not in the playlist.

#### `POST /api/library/playlists/:id/reorder`

```json
// request — the new leading order; anything omitted keeps its relative order
{ "trackIds": ["t3", "t1"] }

// 200
{ "trackCount": 3 }
```

Idempotent, and safe to call from a drag handler: unknown ids are rejected
with 400 (state untouched), duplicates with 400.

#### `GET /api/library/likes`

```json
{ "likedSongs": [ { "id": "t1", "source": "youtube", "title": "First", "artist": "Alpha", … } ] }
```

Most recently liked first; a bulk sync stamps ties in the order supplied.

#### `PUT /api/library/likes/:trackId`

```json
// request — the track payload; the path id always wins over a body id
{ "id": "t1", "title": "First", "artist": "Alpha" }

// 200
{ "liked": true, "total": 1 }
```

Idempotent. **413** past 20 000 likes.

#### `DELETE /api/library/likes/:trackId`

```json
{ "liked": false, "total": 0 }
```

Idempotent — deleting an unliked id still returns 200.

---

### 2.4 YouTube Music linking — `/api/youtube`

Device-code OAuth executed **entirely server-side**; tokens are stored
AES-256-GCM-encrypted (key derived from `APP_SECRET` via HKDF) and never
returned to any client. All four routes require a session.

#### `GET /api/youtube/status`

```json
{
  "state": "pending",
  "linked": false,
  "verificationUrl": "https://www.youtube.com/activate",
  "userCode": "ABCD-EFGH",
  "expiresInSec": 1740
}
```

| Field | Type | Description |
|---|---|---|
| `state` | `"idle" \| "pending" \| "linked" \| "error"` | Link lifecycle state |
| `linked` | boolean | Valid encrypted token present |
| `verificationUrl` | string? | Where to enter the code (while `pending`) |
| `userCode` | string? | The one-time code (while `pending`) |
| `expiresInSec` | number? | Seconds until the device code expires |
| `error` | string? | Human-readable failure (expired/cancelled/denied) |

#### `POST /api/youtube/link`

Starts the device-code flow (idempotent: returns the current status if
already `pending` or `linked`). Server polls Google's token endpoint at the
advertised interval until the user approves at `youtube.com/activate`.

- **200** → status object · **401** no session · **429** past 10/min ·
  **502** if the device-code request fails.

#### `POST /api/youtube/cancel`

Aborts a pending device-code poll. Returns the status object
(`state` back to `idle`/`linked`).

#### `POST /api/youtube/unlink`

Revokes the token remotely (best effort) and deletes local rows.

```json
{ "state": "idle", "linked": false }
```

#### `GET /api/youtube/library`

The linked account's YouTube Music library — playlists, liked songs, saved
albums, and recently played — as plain JSON.

This endpoint exists because **an OAuth token is rejected by the client a
browser sends**. InnerTube's `WEB_REMIX` (client 67) answers
`400 Request contains an invalid argument` to every OAuth-authenticated
request, regardless of `X-Goog-AuthUser`, `Origin`, or `Referer`; it wants a
browser cookie this server does not have. The same token succeeds against
`TVHTML5` (client 7), so the read runs server-side there and the TV-shaped
payload (`tvBrowseRenderer` / `tileRenderer`) is normalised below.

| Status | Case |
|---|---|
| **200** | Library returned (an account with an empty library still gets 200) |
| **401** | Not signed in |
| **409** | No YouTube Music account is linked on this account |
| **502** | YouTube Music did not return a library (upstream failure/timeout) |

```json
// 200
{
  "account": { "name": null },
  "playlists": [
    { "id": "LM", "title": "Liked Music", "owner": "You",
      "artworkUrl": "https://…/liked-songs-576.png", "trackCount": 51 },
    { "id": "PLUVfMkXK0SrfyJ0A7n4FskNjFgNc3aXXB", "title": "Sai Music",
      "owner": "GingyBaby", "artworkUrl": "https://…", "trackCount": 4 }
  ],
  "likedSongs": [
    { "id": "UNZqm3dxd2w", "title": "The Box", "artist": "Roddy Ricch",
      "artworkUrl": "https://i.ytimg.com/vi/UNZqm3dxd2w/hq720.jpg…", "durationSec": 213 }
  ],
  "albums": [],
  "recentlyPlayed": [
    { "id": "…", "title": "Lucid Dreams", "artist": "Juice WRLD", "durationSec": 240 }
  ]
}
```

`id` is the bare playlist id with the `VL` browse prefix stripped (`LM` is
the auto Liked Music playlist, so it also appears in `playlists`); `artist`
is an empty string when YouTube supplied none; `account.name` is always null
here — the display name comes from the OpenDeck session, not YouTube.
Continuation pages are followed (capped at 8 per surface) and each upstream
call is bounded to 25s.

---

### 2.5 InnerTube / upstream proxy — `POST /api/yt/proxy`

The service's data plane: browsers cannot call YouTube (CORS), so clients
send the request here and it is forwarded server-side. Session optional —
when the caller has a linked YouTube account, a fresh
`Authorization: Bearer` token is injected for `*.youtube.com/youtubei/*`
and `/api/stats/*` targets (tokens never leave the server).

**Request**

```json
{
  "url": "https://music.youtube.com/youtubei/v1/search?prettyPrint=false",
  "method": "POST",
  "headers": { "content-type": "application/json", "x-youtube-client-name": "67" },
  "body_base64": "eyJxdWVyeSI6ImJlbGlldmVyIn0=",
  "timeout_ms": 30000
}
```

| Field | Type | Constraints |
|---|---|---|
| `url` | string | Required, ≤ 8192 chars, **https only**, host must be allowlisted |
| `method` | string | `GET` (default), `POST`, `HEAD`, `PUT`, `DELETE` — others → 400 |
| `headers` | object | Values must be strings; name ≤ 256 chars, value ≤ 16384 chars. `cookie`, `authorization`, `origin`, `referer`, `host`, `content-length`, `connection`, `keep-alive`, `transfer-encoding`, `upgrade` are **stripped** |
| `body_base64` | string | Base64 request body; omitted for GET/HEAD |
| `timeout_ms` | number | Clamped to 1 000–120 000, default 30 000 |

**Response** — the upstream reply is always wrapped in an envelope and this
route answers **200** when forwarding succeeded, regardless of the upstream
status (read `status`):

```json
{
  "status": 200,
  "headers": { "content-type": "application/json", "date": "…" },
  "body_base64": "eyJyZXNwb25zZSI6…"
}
```

- Response headers `set-cookie`, `content-encoding`, `content-length`,
  `transfer-encoding`, `connection`, `keep-alive`, `upgrade` are stripped;
  names are lower-cased. Bodies are capped at **64 MB**
  (`502 Upstream response too large.`).
- Redirects are followed manually, up to 5 hops, **re-validating the
  allowlist at every hop**; credentials are never carried across origins.

**Allowlist** (HTTPS only; subdomains of these match):

```
youtube.com, www.youtube.com, music.youtube.com, m.youtube.com,
youtubei.googleapis.com, googlevideo.com, ytimg.com, i.ytimg.com,
googleusercontent.com, ggpht.com, lrclib.net, api.lrclib.net,
lyrics-api.boidu.dev, fonts.gstatic.com, fonts.googleapis.com,
cp.cloudflare.com
```

Extend with `YT_PROXY_EXTRA_HOSTS=host1,host2`. `localhost`/`127.0.0.1`
are always denied.

**Status codes:** 400 invalid payload/URL/method/base64 · 403 host not
allowed (`{"error":"Host not allowed: example.com"}`) · 429 rate limit ·
502 upstream failure, blocked redirect, or oversized response.

**Worked example** (InnerTube search, verified):

```console
$ BODY=$(printf '%s' '{"context":{"client":{"clientName":"WEB_REMIX","clientVersion":"1.20260609.07.00","hl":"en","gl":"US"}},"query":"believer"}' | base64 -w0)
$ curl -s -X POST http://localhost:4000/api/yt/proxy -H 'content-type: application/json' \
    -d "{\"url\":\"https://music.youtube.com/youtubei/v1/search?prettyPrint=false\",\"method\":\"POST\",
         \"headers\":{\"content-type\":\"application/json\",\"x-youtube-client-name\":\"67\",
                     \"x-youtube-client-version\":\"1.20260609.07.00\"},\"body_base64\":\"$BODY\"}" \
  | jq -r .body_base64 | base64 -d | jq '.contents | keys'
["responseContext", "contents", "trackingParams"]
```

---

### 2.6 Feed — `/api/feed`

Normalized, render-ready data for the home screen: shelf sections, watch-next
recommendations, and playlist detail. Every route requires a session (cookie
or API key), is rate limited to **120/min**, and calls InnerTube server-side
through the same allowlisted proxy as §2.5 — a linked YouTube account gets its
Bearer token injected automatically. Upstream failures answer **502** with a
generic message; they never pass YouTube's response through.

Locale is optional on all three upstream routes: `?hl=de&gl=DE` (defaults
`en`/`US`), validated as `^[a-z]{2,3}$` / `^[A-Z]{2}$`.

#### `GET /api/feed/home`

Browses `FEmusic_home` and returns its carousels as sections. The
tastebuilder shelf is omitted; each item carries `id`, `type`
(`song`·`video`·`playlist`·`album`·`artist`·`other`), `title`, `subtitle`,
`artworkUrl` (largest thumbnail), plus `videoId` or `browseId`+`params` for
navigation.

```json
{"sections":[{"title":"Today's biggest hits","items":[
  {"id":"VLRDCLAK…","type":"playlist","title":"Country Hotlist",
   "subtitle":"Ella Langley, Morgan Wallen","artworkUrl":"https://…=w544…",
   "browseId":"VLRDCLAK…","params":"ggMEgALjBA%3D%3D"}]}]}
```

| **200** | `{sections:[…]}` · **400** invalid `hl`/`gl` · **401** no session · **429** · **502** upstream |

#### `GET /api/feed/next?videoId=dQw4w9WgXcQ`

The watch-next panel for a seed video, **minus the seed entry**. Items include
`videoId`, `subtitle` (artist/first byline), `artworkUrl`, and
`durationText`/`durationSeconds` when present.

```json
{"items":[{"id":"dQw4w9WgXcQ","type":"song","title":"Never Gonna Give You Up",
  "subtitle":"Rick Astley","artworkUrl":"https://…","videoId":"dQw4w9WgXcQ",
  "durationText":"3:34","durationSeconds":214}]}
```

| **200** | `{items:[…]}` · **400** missing/malformed `videoId` (`^[\w-]{6,20}$`) · **401** · **429** · **502** upstream |

#### `GET /api/feed/playlist?browseId=VLRD…&params=ggMEgALjBA%3D%3D`

Playlist (or album) header with its thumbnail and every song in order. `params`
is echoed from the feed item that linked the playlist (optional). Unplayable
rows keep their title and carry `videoId: null`.

```json
{"playlist":{"browseId":"VLRD…","title":"Country Hotlist",
  "subtitle":"Playlist • 2026","artworkUrl":"https://…","description":"…",
  "tracks":[{"videoId":"6q5F7UUiXK0","title":"Been By Now",
    "artist":"Morgan Wallen","album":null,"artworkUrl":"https://…",
    "durationText":"3:35","durationSeconds":215}]}}
```

| **200** | `{playlist:{…,tracks:[…]}}` · **400** missing `browseId` or bad `params` (`^[\w%=-]{1,512}$`) · **401** · **404** unknown browse id · **429** · **502** upstream |

#### `GET /api/feed/playlists`

This account's library playlists **with tracks inline** — one call for the
playlist grid (thumbnail + song list). Database-only; no upstream request.
Equivalent to the `playlists` array of `GET /api/library`.

```json
{"playlists":[{"id":"pl-…","name":"Road trip","artworkUrl":"https://…",
  "trackCount":2,"tracks":[{"id":"vid…","title":"Liar","artist":"Camila Cabello",
  "durationSeconds":198,"position":0,"addedAt":1730000000000}]}],
 "counts":{"playlists":1,"likedSongs":0}}
```

| **200** | `{playlists:[…],counts:{…}}` · **401** · **429** |

### 2.7 Audio streaming — `GET /api/media/stream`

Streams resolved YouTube audio bytes server-side: CORS-free, `Range`-capable
(for seeking), rate-limited. This is the desktop app's
`fetch_audio_source`/`download_audio_source` + local media server,
reimplemented as one endpoint.

**Query**

| Param | Rules |
|---|---|
| `url` | Must be `https`, host `googlevideo.com` or `*.googlevideo.com`, path exactly `/videoplayback` (≤ 8192 chars) — otherwise **400** `{"error":"Invalid media URL."}` |

**Request headers honored:** `Range` (forwarded upstream; use
`bytes=0-` / `bytes=start-end` for seeking), `User-Agent` (forwarded).

**Response**

- Status 200 (or the upstream 206 for ranges); passthrough headers:
  `content-type`, `content-length`, `content-range`, `accept-ranges`,
  `cache-control`, `expires`, `date`, `etag`; plus
  `access-control-allow-origin: *` and `x-content-type-options: nosniff`.
- A 403 from the CDN is retried once with `origin`/`referer` of
  `music.youtube.com` (some googlevideo nodes reject bare server fetches).
- Redirect hops must stay on the googlevideo CDN.

**Status codes:** 400 bad `url` · 429 rate limit (300/min) · 502 fetch
failed or upstream 403/404 (`{"error":"Audio source returned HTTP 403."}`) ·
other upstream errors are passed through with their original status.

**Play history:** every successful stream records a play in the caller's
[play history](#213-play-history--apihistory) — session-cookie plays as
`source: "app"`, bearer-key plays as `source: "api"` attributed to the key
(see the per-key stats in `GET /api/keys`). Optional metadata params enrich
the row (all capped at 2048 chars, sanitized; the CDN URL's `id` param is
the fallback video id):

| Param | Meaning |
|---|---|
| `videoId` | Overrides the `id`-derived video id |
| `title` | Track title (defaults to the video id) |
| `artist` / `album` | Free-form credits |
| `artwork` | Artwork URL |
| `durationSec` | Track length in seconds (positive number) |

Repeated requests for the same track within **90 seconds** (ranged
requests while seeking/buffering) count as one play. History recording is
best-effort — it never fails a stream.

**Play it:**

```js
const audio = new Audio(`/api/media/stream?url=${encodeURIComponent(streamUrl)}`);
audio.addEventListener("timeupdate", () => { /* real-time position */ });
```

`streamUrl` is a deciphered googlevideo URL produced by stream resolution
(quality selection + po-token attestation) — see
[INTEGRATION.md §5](INTEGRATION.md#5-playback-pipeline).

---

### 2.8 Cache — `/api/cache`

Server-side LRU JSON cache (SQLite), mirroring the desktop app's Rust disk
cache. Entries are **namespaced**: `u:{userId}` for signed-in users,
`anon` otherwise — reads/writes/clears only touch the caller's namespace.
All routes are `POST` + JSON, rate-limited 600/min, no session required
except `setMaxBytes`.

#### `POST /api/cache/get`

```json
{ "key": "youtube-music:mixed-search:v5:believer" }
```
→ `{"value":"[…] | null"}` · 400 if `key` missing/not a string/`>256` chars.

#### `POST /api/cache/set`

```json
{ "key": "…", "value": "[{\"id\":\"…\"}]" }
```
→ `{"changed":true}` · `value` must be a **string**; ≤ 64 MB (413 above);
an entry larger than the whole budget stores nothing and returns
`{"changed":false}`. LRU eviction trims to the byte budget on change.

#### `POST /api/cache/stats`

```json
{ "maxBytes": 536870912, "usedBytes": 140583, "entryCount": 13 }
```
Global totals across all namespaces. Default budget **512 MB**
(`DEFAULT_CACHE_MAX_BYTES`).

#### `POST /api/cache/setMaxBytes` · **session required**

```json
{ "maxBytes": 4294967296 }
```
→ current stats after re-trimming. 400 unless `maxBytes` is a positive
finite number; 401 without a session. (The shipped client exposes this as
a GB slider in Settings → default 4 GB.)

#### `POST /api/cache/clear`

Clears only the **caller's** namespace (signed-in vs anonymous), returns
stats.

#### `GET /api/artwork?url=…` · **public**

The **artwork cache** — album art, track thumbnails and channel avatars.
The client points every `<img>` here instead of at YouTube, so one copy of
a picture is fetched from the origin **once per instance** rather than
once per browser session, and it survives switching devices. Rate limit
6000/min.

| | |
|---|---|
| Query | `url` — absolute `https` URL, ≤ 8192 chars (400 otherwise) |
| 200 | Image bytes with `Content-Type` from upstream, `Content-Length`, `ETag: "<sha256 of url>"`, `Cache-Control: public, max-age=2592000, immutable` |
| 304 | `If-None-Match` matched — an index probe, no body |
| 403 | Host outside the artwork allowlist, or not `https` |
| 415 | The URL answered with a non-image `Content-Type` (never cached) |
| 502 | Origin failed, timed out (15 s), or is inside a 5 s retry cooldown |

**Why the host policy is narrower than `/api/yt/proxy`.** This endpoint is
unauthenticated (an `<img>` cannot usefully carry a session), so it only
accepts `*.ytimg.com`, `*.googleusercontent.com` and `*.ggpht.com`. The
general proxy allowlist also covers JSON and font origins, which would
turn this into an open relay.

Bytes are stored as SQLite **BLOBs** keyed by `sha256(url)`, not base64:
a 40 KB thumbnail costs 40 KB of disk and needs no decode pass. Concurrent
misses on one URL are coalesced into a single origin fetch (opening a
50-track grid otherwise fires the same picture N times), and a failed
fetch is not retried for five seconds so a dead host is not hammered once
per thumbnail.

**Eviction.** When the budget is reached the least valuable picture goes
first — played least, then requested least, then seen least. Plays are
matched through `play_history.artwork_url`, normalized so a play recorded
against `…/hqdefault.jpg` still counts against `…/w540-h540.jpg`. The
sweep trims to 90% of the budget so the next few thousand inserts do not
each pay for another pass.

#### Artwork budget — admin only

| Route | Body | Response |
|---|---|---|
| `POST /api/cache/artwork/stats` | — | `{maxBytes, usedBytes, entryCount, usageRatio}` — **session required**; the numbers are instance-wide |
| `POST /api/cache/artwork/setMaxBytes` | `{ "maxBytes": 536870912 }` | Same stats after re-trimming. 401 anonymous, 403 non-admin; clamped to 64 MB – 64 GB |
| `POST /api/cache/artwork/format` | — | Same stats, always empty. Drops every picture and **VACUUMs**, so the disk space is really returned |

The cache is global (artwork is public content, and the same thumbnail is
shared by every account), so the budget and the format affect everyone and
both sit behind the admin gate. The shipped client renders `usageRatio` as
a meter in Settings → System, and exposes the format both there and under
Settings → Admin → *Artwork storage*.

---

### 2.9 Settings — `/api/settings`

Durable per-user key/value store (SQLite), replacing the desktop app's
Rust `app_setting_*` commands. **All three routes require a session**
(401 otherwise), rate-limited 300/min. Keys are isolated per user.

| Route | Body | Response |
|---|---|---|
| `POST /api/settings/get` | `{ "key": "player" }` | `{"value": <any JSON> \| null}` |
| `POST /api/settings/set` | `{ "key": "player", "value": <any JSON> }` | `{"ok":true}` |
| `POST /api/settings/remove` | `{ "key": "player" }` | `{"ok":true}` |

Rules: `key` must be a non-empty string ≤ 256 chars (400 otherwise);
`value` must be JSON-serializable (400) and serialize to ≤ 128 KB (413).

---

### 2.10 API keys — `/api/keys`

Per-account bearer tokens for scripted access, created in **Settings → API**
in the web client. A key is `odk_` + 43 URL-safe characters; only its
SHA-256 hash is stored server-side. **Management routes require a browser
session cookie** — a bearer key is rejected there (401), so a leaked key
can neither list nor mint keys. Rate limits: 60/min for list and revoke,
10/min for create; at most **25 keys** per account (429).

Send a key as `Authorization: Bearer odk_…`; it authenticates as your
account on every **session** route below, except `/api/keys` and the TOTP
setup/enable/disable routes (cookie only).

| Route | Body | Response |
|---|---|---|
| `GET /api/keys` | — | `{"keys":[{"id","label","keyPrefix","createdAt","lastUsedAt","stats":{"totalPlays","playsLast7Days","lastPlayedAt"}}]}` — newest first, never a usable key; `stats` counts plays made [through the API](#213-play-history--apihistory) with that key (`lastPlayedAt` null until it plays once) |
| `POST /api/keys` | `{ "label": "laptop" }` | **201** `{id, label, key, keyPrefix, createdAt}` — `key` is the plaintext and is returned **exactly once** |
| `DELETE /api/keys/:id` | — | `{"ok":true}`; bearer auth stops working immediately |

Rules: `label` is trimmed and must be 1–80 chars (400 otherwise);
`keyPrefix` is the first 12 characters of the key (safe to display);
`lastUsedAt` is epoch ms of the last bearer use, or `null` until first used.
Revoking an unknown or another account's key → **404**.

---

### 2.11 Admin — `/api/admin`

Role-based instance administration for the **Admin** tab in Settings.
Every route demands a **browser session on an account with `role=admin`**
(401 anonymous/bearer, 403 signed-in non-admin), rate-limited 60/min for
reads and 30/min for mutations (10/min for user creation).

Accounts get their role at creation: the **first account on an instance is
always admin** (first-run setup at `/login`), emails in `ADMIN_EMAILS` are
admin, everyone else is `user` until promoted. The session payload reports
`role` (`admin`/`user`/`null`), `needsSetup` (no accounts yet), and
`oauthProvider` (`{name, configured}`).

| Route | Body | Response |
|---|---|---|
| `GET /api/admin/overview` | — | `{users, admins, sessions, apiKeys, cacheEntries, imageCacheBytes, settings}` counts |
| `GET /api/admin/users` | — | `{users:[{id, name, email, role, authProvider, totpEnabled, createdAt, lastLoginAt}]}` — oldest first, never credential material |
| `POST /api/admin/users` | `{ "email", "password", "name"?, "role"? }` | **201** `{user}` — creates a password account (no invite needed); 409 duplicate |
| `PATCH /api/admin/users/:id` | `{ "role": "admin" \| "user" }` | `{user}` — 400 self-demotion, 409 last-admin, 404 unknown |
| `DELETE /api/admin/users/:id` | — | `{"ok":true}` — cascades sessions/keys/settings; 400 self, 409 last admin |
| `POST /api/admin/users/:id/logout` | — | `{"ok":true}` — revokes every session of that account |
| `POST /api/admin/users/:id/totp-reset` | — | `{"ok":true}` — clears the second factor + signs the target out; 400 self |
| `GET /api/admin/oauth` | — | `{provider:{providerName, discoveryUrl, clientId, clientSecretSet, configured, source}}` — secret is write-only |
| `PUT /api/admin/oauth` | `{providerName?, discoveryUrl?, clientId?, clientSecret?}` | `{provider}` — instance overrides of the OIDC config; empty string deletes an override (env wins again) |
| `GET /api/admin/registration` | — | `{registration:{enabled, overridden, envDefault, inviteCodeRequired}}` — the public account-creation switch |
| `PUT /api/admin/registration` | `{ "enabled": true \| false }` | `{registration}` — closes/opens self-service sign-up at runtime (overrides `ALLOW_REGISTRATION`) |

| `GET /api/admin/image-cache` | — | `{stats, images:[{hash, url, contentType, bytes, createdAt, lastUsed, hitCount, playCount}]}` — the 25 largest pictures, largest first |
| `POST /api/admin/image-cache/format` | — | `{ok, stats}` — empties the artwork cache and VACUUMs it back down |
| `POST /api/admin/reset` | `{ "totpCode": "…" }` | `{ok, settingsCleared, cacheCleared, sessionsRevoked}` — **needs a fresh TOTP/backup code from the admin** (403 without two-step enabled) |

Closing **Account creation** (`PUT /api/admin/registration`) takes effect
immediately everywhere: the sign-up option disappears from `/login`,
`POST /api/auth/register` answers 403, and an **unknown OIDC identity can no
longer mint an account** through the provider flow. Existing accounts —
password and OIDC — keep signing in, and the first-run setup exemption is
untouched: an instance with zero accounts can always be provisioned.

`POST /api/admin/reset` wipes every account's durable settings, the
JSON cache and the shared artwork cache, and signs everyone out **except
the admin presenting the code**; accounts, playlists, likes, and API keys
are untouched.

---

### 2.12 Static routes

| Path | Serving |
|---|---|
| `/api/*` (unmatched) | `404 {"error":"Not found."}` |
| `/*` (non-`/api`) | Built SPA `client/dist` with HTML5 fallback, when `SERVE_CLIENT≠0` and `npm run build` has run; `assets/*` are immutable-cached |
| `/docs` | This page — rendered as static HTML server-side (no JS); falls back to JSON 500 if the file is missing |

Set `SERVE_CLIENT=0` to run the process API-only and host the frontend
elsewhere (then you must solve CORS/cookies yourself — same-origin
deployment is the supported topology).

---

### 2.13 Play history — `/api/history`

Every successful `GET /api/media/stream` records a play — both web-app
playback (session cookie) and plays made through the Music API with a
bearer key, the latter attributed to the key that requested them (feeding
the per-key statistics in `GET /api/keys`). All three routes require a
**session** (bearer API keys are accepted; 401 otherwise), are
rate-limited **180/min**, and are scoped to the signed-in account —
another account's plays are never visible.

#### `GET /api/history`

Newest-first, cursor-paginated.

| Query | Rules |
|---|---|
| `limit` | 1–200, default 50 |
| `before` | Epoch ms — returns plays older than this `playedAt` (pass the previous page's `nextCursor`) |

```console
curl -s -b od_sid=<session> 'http://localhost:4000/api/history?limit=2'
```

```json
{
  "plays": [
    {
      "id": "8f6c2f9e-3f1b-4f69-9f57-2b0a5f6a1d21",
      "videoId": "OpUjVfUrqZQ",
      "title": "Believer",
      "artist": "Imagine Dragons",
      "album": "Evolve",
      "artworkUrl": "https://i.ytimg.com/vi/OpUjVfUrqZQ/hq720.jpg",
      "durationSeconds": 204,
      "source": "api",
      "apiKeyId": "3d1f0c6a-9c2b-4a8e-9f3a-6b1d2e4f5a6b",
      "apiKeyLabel": "laptop",
      "playedAt": 1770500000000
    },
    {
      "id": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "videoId": "7wtfhZwyrcc",
      "title": "NotSupportedException",
      "artist": "Tempo",
      "album": null,
      "artworkUrl": null,
      "durationSeconds": 158,
      "source": "app",
      "apiKeyId": null,
      "apiKeyLabel": null,
      "playedAt": 1770490000000
    }
  ],
  "hasMore": true,
  "nextCursor": 1770490000000
}
```

`source` is `"app"` (web player) or `"api"` (bearer-key request);
`apiKeyId`/`apiKeyLabel` are `null` for app plays (and for plays whose key
was revoked after the fact); `artist` may be an empty string when unknown;
`hasMore: false` + `nextCursor: null` at the end.

#### `GET /api/history/stats`

Aggregated statistics for the account (the History tab in the client).

```console
curl -s -b od_sid=<session> http://localhost:4000/api/history/stats
```

```json
{
  "totalPlays": 42,
  "totalListeningSeconds": 9135,
  "playsToday": 3,
  "plays7d": 17,
  "bySource": { "app": 34, "api": 8 },
  "topTracks": [
    {
      "videoId": "OpUjVfUrqZQ",
      "title": "Believer",
      "artist": "Imagine Dragons",
      "plays": 5,
      "lastPlayedAt": 1770500000000
    }
  ],
  "topArtists": [ { "artist": "Imagine Dragons", "plays": 9 } ]
}
```

`playsToday` counts since server-local midnight; `topTracks` and
`topArtists` are capped at 10 entries each (artists with an empty name are
excluded); `totalListeningSeconds` sums track durations across plays.

#### `DELETE /api/history`

Irreversible; deletes every play of the signed-in account only.

```console
curl -s -X DELETE -b od_sid=<session> -H 'origin: http://localhost:4000' \
  http://localhost:4000/api/history
# {"ok":true,"removed":42}
```

---

### 2.14 Song recommendations — `/api/recommendations` + `/api/push`

Send a song to another registered OpenDeck account. A recommendation
**snapshots the track** (video id, title, artist, album, artwork, duration)
at send time, so it keeps playing for the recipient even if the sender's
library changes later. Delivery is instant in-app (the Recommendations tab
polls on open) and push-notified when the recipient's device has subscribed
via Web Push.

The whole surface is plain JSON authenticated by **session cookie or
bearer API key**, so a mobile client can reuse it unchanged: same
endpoints, same payloads, `Authorization: Bearer odk_…` instead of the
cookie. Rate limits: **30/min** for sending (`recommend-send`),
**180/min** for reads/marks/deletes (`recommend-read`).

Recommendation item shape (returned by every list and the send route):

```json
{
  "id": "0f9c…",
  "senderUserId": "u-sam", "senderName": "Sam",
  "recipientUserId": "u-rita", "recipientName": "Rita",
  "videoId": "dQw4w9WgXcQ",
  "title": "Never Gonna Give You Up",
  "artist": "Rick Astley",
  "album": "Whenever You Need Somebody",
  "artworkUrl": "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
  "durationSeconds": 213,
  "note": "This chorus!",
  "createdAt": 1770500000000,
  "readAt": null
}
```

`artist` is an empty string when unknown; `album`/`artworkUrl`/
`durationSeconds`/`note` are `null` when absent; `readAt` is null while
unread. `recipientName` is what makes the Sent list readable — it is
`null` once the recipient deletes their account. Email addresses never
appear anywhere in this surface — the directory exposes ids, display
names, and pictures only.

#### `POST /api/recommendations`

```json
// request
{
  "recipientId": "u-rita",
  "videoId": "dQw4w9WgXcQ",
  "title": "Never Gonna Give You Up",
  "artist": "Rick Astley",        // optional, ≤ 200
  "album": "…",                   // optional, ≤ 300
  "artworkUrl": "https://…",      // optional, ≤ 2048
  "durationSeconds": 213,         // optional, positive number (rounded)
  "note": "This chorus!"          // optional, ≤ 500
}

// 201
{ "recommendation": { …item… } }
```

`recipientId`, `videoId`, and `title` are required (400 otherwise). On
success the recipient's subscribed devices receive a Web Push
notification ("Sam recommended a song") — best-effort, it never fails the
send.

| Status | Case |
|---|---|
| **201** | Sent — response carries the stored item |
| **400** | Missing required field, or `recipientId` is your own id |
| **401** | Not signed in |
| **404** | No registered account with that `recipientId` |
| **429** | Past 30 sends/min |

#### `GET /api/recommendations` · `GET /api/recommendations/sent`

Your inbox (newest first) and what you sent.

| Query | Rules |
|---|---|
| `limit` | 1–200, default 50 |
| `unread` | `1`/`true` on the inbox route filters to unopened items |

```console
curl -s -b od_sid=<session> 'http://localhost:4000/api/recommendations?unread=1'
# {"recommendations":[…],"unreadCount":2}

curl -s -H 'Authorization: Bearer odk_…' http://localhost:4000/api/recommendations/sent
# {"recommendations":[…]}
```

`unreadCount` counts **all** unread items for the account regardless of
the `limit`.

#### `GET /api/recommendations/directory`

Registered accounts you can recommend to — `{"users":[{"id","name",
"picture"}]}`, display-name order, capped at 500. The caller is excluded;
emails are never included.

#### `POST /api/recommendations/:id/read`

Marks one received item read. Recipient-only (404 otherwise) and
idempotent — replaying it stays 200.

```json
{ "ok": true }
```

#### `DELETE /api/recommendations/:id`

The sender may retract a sent item; the recipient may dismiss a received
one. Anyone else gets 404, and deleting twice gets 404.

```json
{ "ok": true }
```

#### Web Push — `/api/push`

Push subscription management for "someone recommended a song" alerts.
**Cookie-session-only** (401 with a bearer API key): re-pointing a user's
notifications is credential-adjacent, so a leaked key must not be able to
do it — same policy as key management and TOTP routes. Rate limit:
**30/min** (`push-sub`). VAPID keys come from `VAPID_PUBLIC_KEY`/
`VAPID_PRIVATE_KEY` when set, else are generated once and persisted in
`instance_config`, so subscriptions survive restarts.

| Route | Body | Response |
|---|---|---|
| `GET /api/push/vapid-public-key` | — | `{"publicKey":"<base64url>"}` — use as `applicationServerKey`; 503 when push is unavailable |
| `POST /api/push/subscribe` | standard PushAPI subscription: `{"endpoint","keys":{"p256dh","auth"}}` | **201** `{"ok":true}` — upserts by endpoint (re-subscribing refreshes it) |
| `POST /api/push/unsubscribe` | `{ "endpoint": "…" }` | `{"ok":true,"removed":true\|false}` — removes only the caller's row |

Browser flow (what the shipped client does): register `sw.js`, then
`Notification.requestPermission()`, fetch the VAPID key, subscribe via
`registration.pushManager.subscribe({userVisibleOnly: true,
applicationServerKey})`, and POST the JSON subscription here. Push fan-out
on the server is best-effort: dead subscriptions (HTTP 404/410 from the
push service) are pruned automatically, and an unreachable push service
never fails the recommendation that triggered it.

---

## 3. Endpoint matrix

| Method | Path | Auth | Rate/min | Notes |
|---|---|---|---|---|
| GET | `/healthz` | — | — | Liveness + version |
| GET | `/api/auth/session` | cookie | — | Session state (anonymous OK) |
| GET | `/api/auth/google/start` | — | 20 | 302 → Google · 503 unconfigured |
| GET | `/api/auth/google/callback` | cookie | — | HTML popup helper · 400 on failure |
| GET | `/api/auth/auth-callback.js` | — | — | postMessage helper script |
| POST | `/api/auth/logout` | cookie | — | `{ok:true}` |
| GET | `/api/auth/whoami` | **session** | — | 401 without session |
| POST | `/api/auth/register` | — | 5 | Create account + session · 409 duplicate · 403 closed/invite |
| POST | `/api/auth/login` | — | 10 | `ok` (cookie) or `totp_required` + challenge |
| POST | `/api/auth/login/totp` | challenge | 10 + 15 | Code or backup code → session |
| GET | `/api/auth/totp/status` | **session** | 15 | password accounts only (400 for Google) |
| POST | `/api/auth/totp/setup` | **session** | 15 | Stores an unconfirmed secret · cookie only (401 with API key) |
| POST | `/api/auth/totp/enable` | **session** | 15 | Confirm code → 10 backup codes · cookie only |
| POST | `/api/auth/totp/disable` | **session** | 15 | Needs password + current code · cookie only |
| GET | `/api/library` | **session** | 300 | Full snapshot (playlists + tracks + likes) |
| POST | `/api/library/sync` | **session** | 300 | Atomic bulk replace |
| GET | `/api/library/playlists` | **session** | 300 | Newest activity first |
| POST | `/api/library/playlists` | **session** | 300 | 201 · 413 past 500 playlists |
| GET | `/api/library/playlists/:id` | **session** | 300 | 404 when unknown or another account's |
| PATCH | `/api/library/playlists/:id` | **session** | 300 | Rename / describe |
| DELETE | `/api/library/playlists/:id` | **session** | 300 | Cascades to tracks |
| POST | `/api/library/playlists/:id/tracks` | **session** | 300 | ≤ 200/call · dedupes · replaces in place |
| DELETE | `/api/library/playlists/:id/tracks/:trackId` | **session** | 300 | `{ok:boolean}` |
| POST | `/api/library/playlists/:id/reorder` | **session** | 300 | Explicit leading order |
| GET | `/api/library/likes` | **session** | 300 | Most recent first |
| PUT | `/api/library/likes/:trackId` | **session** | 300 | Idempotent |
| DELETE | `/api/library/likes/:trackId` | **session** | 300 | Idempotent |
| GET | `/api/feed/home` | **session** | 120 | Normalized home shelves · 502 upstream |
| GET | `/api/feed/next` | **session** | 120 | Watch-next minus seed · 400 bad `videoId` |
| GET | `/api/feed/playlist` | **session** | 120 | Header + thumbnail + ordered songs · 404 unknown id |
| GET | `/api/feed/playlists` | **session** | 120 | Library playlists with tracks inline (DB only) |
| GET | `/api/youtube/status` | **session** | — | Link state machine |
| POST | `/api/youtube/link` | **session** | 10 | Device-code start (idempotent) |
| POST | `/api/youtube/cancel` | **session** | — | Abort pending poll |
| POST | `/api/youtube/unlink` | **session** | — | Revoke + delete |
| GET | `/api/youtube/library` | **session** | — | Linked account's library via TVHTML5 · 409 not linked · 502 upstream |
| POST | `/api/yt/proxy` | cookie | 900 | Upstream envelope; Bearer injected when linked |
| GET | `/api/media/stream` | — | 300 | googlevideo passthrough + Range · records play history |
| POST | `/api/cache/get` | — | 600 | Caller namespace |
| POST | `/api/cache/set` | — | 600 | LRU, 64 MB/entry cap |
| POST | `/api/cache/stats` | — | 600 | Global stats |
| POST | `/api/cache/setMaxBytes` | **session** | 600 | Resize budget |
| POST | `/api/cache/clear` | — | 600 | Clears caller namespace |
| GET | `/api/artwork` | — | 6000 | Cached artwork bytes · host-allowlisted · records no play |
| POST | `/api/cache/artwork/stats` | **session** | 600 | Shared artwork-cache usage |
| POST | `/api/cache/artwork/setMaxBytes` | **admin** | 600 | Clamp 64 MB – 64 GB, trims immediately |
| POST | `/api/cache/artwork/format` | **admin** | 600 | Drop everything + VACUUM |
| POST | `/api/settings/get` | **session** | 300 | Per-user JSON values |
| POST | `/api/settings/set` | **session** | 300 | ≤ 128 KB serialized |
| POST | `/api/settings/remove` | **session** | 300 | |
| GET | `/api/keys` | **session** (cookie) | 60 | List key prefixes; bearer keys rejected |
| POST | `/api/keys` | **session** (cookie) | 10 | 201 · plaintext key once · max 25/account |
| DELETE | `/api/keys/:id` | **session** (cookie) | 60 | 404 for unknown/foreign ids |
| GET | `/api/history` | **session** | 180 | Plays newest first · `limit` 1–200 · `before` cursor |
| GET | `/api/history/stats` | **session** | 180 | Totals, app/api split, top tracks/artists |
| DELETE | `/api/history` | **session** | 180 | Wipes the caller's plays · `{ok,removed}` |
| POST | `/api/recommendations` | **session** | 30 | 201 send a song to another account · 404 unknown recipient · 400 self |
| GET | `/api/recommendations` | **session** | 180 | Inbox + `unreadCount` · `unread=1` filter |
| GET | `/api/recommendations/sent` | **session** | 180 | What you sent |
| GET | `/api/recommendations/directory` | **session** | 180 | Ids + names + pictures, no emails, excludes self |
| POST | `/api/recommendations/:id/read` | **session** | 180 | Recipient-only · idempotent |
| DELETE | `/api/recommendations/:id` | **session** | 180 | Sender retracts or recipient dismisses |
| GET | `/api/push/vapid-public-key` | **session** (cookie) | 30 | `applicationServerKey` for the Push API |
| POST | `/api/push/subscribe` | **session** (cookie) | 30 | Upsert device subscription · bearer keys rejected |
| POST | `/api/push/unsubscribe` | **session** (cookie) | 30 | Remove caller's device |
| GET | `/api/admin/overview` | **session** (admin) | 60 | Instance counts |
| GET | `/api/admin/users` | **session** (admin) | 60 | Roles + status, no secrets |
| POST | `/api/admin/users` | **session** (admin) | 10 | 201 · password account, optional role |
| PATCH | `/api/admin/users/:id` | **session** (admin) | 30 | Role change · 400 self · 409 last admin |
| DELETE | `/api/admin/users/:id` | **session** (admin) | 30 | Cascades · 400 self · 409 last admin |
| POST | `/api/admin/users/:id/logout` | **session** (admin) | 30 | Revoke every session of the target |
| POST | `/api/admin/users/:id/totp-reset` | **session** (admin) | 30 | Clear 2FA + sign out · 400 self |
| GET | `/api/admin/oauth` | **session** (admin) | 60 | Secret never echoed |
| PUT | `/api/admin/oauth` | **session** (admin) | 30 | Instance OIDC overrides |
| GET | `/api/admin/registration` | **session** (admin) | 60 | Public account-creation switch |
| PUT | `/api/admin/registration` | **session** (admin) | 30 | Open/close self-service sign-up |
| POST | `/api/admin/reset` | **session** (admin) | 30 | Fresh TOTP code required (403) |

**session** = 401 without a valid `od_sid` cookie or `Bearer odk_…` API key
(cookie only on the rows marked so) · **cookie** = read when
present, works anonymously. Every non-GET additionally passes the
origin check (403 on cross-site).

---

## 4. Quick-start recipes

**Create an account and sign in (password):**

```console
curl -s -c jar.txt -X POST http://localhost:4000/api/auth/register \
  -H 'content-type: application/json' -H 'origin: http://localhost:4000' \
  -d '{"email":"ada@example.com","password":"correct horse battery","name":"Ada"}'
# {"ok":true,"user":{"name":"Ada","email":"ada@example.com","picture":null}}
```

Subsequent calls reuse the cookie (`-b jar.txt`).

**Sign in with Google (QR handoff):** `POST /api/auth/google/qr/start`, render
the returned `qrUrl` as a QR code, let the phone run the consent, then
`POST /api/auth/google/qr/verify` with the `attemptId` until it answers
`{"status":"verified"}` (the session cookie lands on the verifying client).
The classic same-browser flow (`GET /api/auth/google/start` in a popup, then
poll `GET /api/auth/session`) still works for API clients.

**Create a playlist (signed in):**

```console
curl -s -b jar.txt -X POST http://localhost:4000/api/library/playlists \
  -H 'content-type: application/json' -H 'origin: http://localhost:4000' \
  -d '{"name":"Road Trip"}'
# {"playlist":{"id":"pl-…","name":"Road Trip","trackCount":0,…}}
```

**Check health:**

```console
curl -s http://localhost:4000/healthz
```

**Cache a search result (anonymous):**

```console
curl -s -X POST http://localhost:4000/api/cache/set \
  -H 'content-type: application/json' \
  -d '{"key":"demo","value":"[1,2,3]"}'
# {"changed":true}
```

**Fetch lyrics metadata through the proxy:**

```console
curl -s -X POST http://localhost:4000/api/yt/proxy \
  -H 'content-type: application/json' \
  -d '{"url":"https://lrclib.net/api/search?track=Believer","method":"GET"}' \
  | jq -r .body_base64 | base64 -d
```

**Stream audio (after resolving a stream URL):**

```console
curl -s -H 'Range: bytes=0-1023' -o part.bin \
  "http://localhost:4000/api/media/stream?url=<googlevideo-videoplayback-url>"
```

**Persist a setting (signed in):**

```console
curl -s -X POST http://localhost:4000/api/settings/set \
  -H 'content-type: application/json' -H "origin: http://localhost:4000" \
  -b od_sid=<session> \
  -d '{"key":"player","value":{"volume":0.42}}'
# {"ok":true}
```

---

## 5. Configuration

All variables are documented with defaults in
[`.env.example`](../.env.example). The process loads `./.env` and
`webapp/.env` at boot; **shell environment always wins**; restart after
editing (dev `tsx watch` does not reload `.env`).

| Variable | Required | Purpose |
|---|---|---|
| `ALLOW_REGISTRATION` | no (`true`) | Baseline for `/register` and `/login`; the admin panel can override sign-up at runtime (`PUT /api/admin/registration`) |
| `INVITE_CODE` | no | Required (constant-time) on `/register` |
| `TOTP_ISSUER` | no (`OpenDeck`) | Issuer label in the authenticator app |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | Enables Google Sign-In (redirect URI = `{APP_URL}/api/auth/google/callback`) |
| `APP_SECRET` | production (≥ 32 chars) | HMAC for cookies/state; HKDF source for token encryption |
| `APP_URL` | recommended | Public origin — OAuth redirect URI + cookie `Secure` flag |
| `PORT` | no (4000) | Listen port; absent/0/malformed → 4000 |
| `NODE_ENV` | no | `production` requires `APP_SECRET` (≥ 32 chars); Google is optional |
| `DATA_DIR` / `DB_PATH` | no | SQLite DB + generated dev secret location |
| `TRUST_PROXY` | behind proxy | `1`/`true` → trust `X-Forwarded-For` for rate limits |
| `SERVE_CLIENT` | no (`1`) | `0` → API-only (no SPA/static serving) |
| `LOG_LEVEL` | no (`info`) | `debug`–`error`; logs are sanitized (tokens/cookies redacted, URLs reduced to origin+path) |
| `ADMIN_EMAILS` | no | Comma-separated emails granted/kept the admin role at sign-in |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | no | OIDC sign-in client (falls back to `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; also editable in Settings → Admin) |
| `OAUTH_DISCOVERY` | no | OIDC discovery URL (Google's by default; set for Keycloak/Authentik) |
| `OAUTH_PROVIDER_NAME` | no (`Google`) | Button label on the sign-in page |
| `OAUTH_SCOPES` | no (`openid email profile`) | Comma-separated scopes (legacy alias `GOOGLE_OAUTH_SCOPES`) |
| `GOOGLE_OPENID_DISCOVERY` | no | Override OpenID discovery (tests / alternate IdP) |
| `GOOGLE_OAUTH_SCOPES` | no | Comma-separated scopes (default `openid email profile`) |
| `YT_PROXY_EXTRA_HOSTS` | no | Extra allowlisted proxy hostnames (comma-separated) |
| `HOST_PORT` | compose only | Host port published by `docker-compose.yml` (container stays on 4000) |
| `VITE_API_TARGET` | client build only | Vite proxy target (default `http://localhost:4000`) |
| `VITE_REPOSITORY_URL` | client build only | Where "source"/"report an issue" links point |

---

## 6. Security model (what the API guarantees)

- **Secrets stay server-side.** Google client secret and
  YouTube refresh tokens never appear in any response; YouTube tokens are
  AES-256-GCM at rest (HKDF from `APP_SECRET`) and injected into upstream
  requests by the proxy only.
- **Account isolation.** Every per-user table (sessions, YouTube tokens,
  settings, cache, playlists, playlist tracks, likes, api keys) is keyed by
  the id resolved from the credential (session cookie or API key). No route
  accepts a user id from the
  client, so a crafted URL cannot reach another account's rows — foreign ids
  read as 404.
- **Passwords** are hashed with scrypt (N=16384, r=8, p=1, 64-byte output,
  per-user salt), parameters stored inside the hash so they can be raised
  later. Comparison is constant-time, and an unknown account performs
  equivalent work so response timing does not reveal whether the email exists.
- **Second factor** — TOTP (RFC 6238: SHA-1, 6 digits, 30 s, ±1 step). The
  secret only becomes active after a valid code is confirmed; backup codes are
  stored as SHA-256 digests and are single-use; disabling TOTP requires both
  the password and a live code, so a stolen session cannot downgrade security.
- **Lockout** — 10 consecutive failures locks the account for 15 minutes
  (429 + `Retry-After`); the counter clears on successful sign-in.
- **Sessions** are opaque 256-bit ids in `HttpOnly`+`SameSite=Lax` cookies
  with a 30-day sliding window; OAuth `state` is HMAC-signed
  (timing-safe), single-use, 10-minute TTL; PKCE `S256` enforced.
- **No open proxy:** HTTPS-only host allowlist, per-hop redirect
  re-validation, credential scoping per origin, request/response header
  stripping, 64 MB cap, localhost denied.
- **CSRF:** SameSite cookies + origin/`Sec-Fetch-Site` rejection on all
  mutations.
- **API keys** are returned in plaintext exactly once at creation; only
  their SHA-256 hash is stored, and key management demands a browser
  session, so a leaked key cannot mint or revoke keys.
- **Roles** — the first account on an instance is admin (first-run setup),
  `ADMIN_EMAILS` grant admin, and only admins reach `/api/admin/*` (cookie
  session required — API keys are refused). Self-demotion and removing the
  last admin are blocked so an instance can never lock everyone out.
- **Dangerous admin actions re-prove the second factor** — the instance
  reset requires a fresh TOTP (or backup) code even from an admin who is
  already signed in, and refuses entirely when two-step verification is off.
- **Rate limiting** on every sensitive/unauthenticated surface.
- **Hardened headers** (CSP without third-party script origins, COOP,
  CORP, HSTS, nosniff, frame-ancestors) on every response.
- **Validation** on every input: bounded key/value sizes, string typing,
  method whitelists, JSON body limits (400/413 rather than 500).

Deployment checklist and integration flows:
[INTEGRATION.md](INTEGRATION.md).
