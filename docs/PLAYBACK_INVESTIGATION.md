# YouTube playback: how JAMC does it, and what this app now does

Status: investigation completed October 2026 against live YouTube, a real Chromium
session and this repository. Every claim below was measured, not assumed.

## 1. Root cause in one paragraph

YouTube Music answers **`LOGIN_REQUIRED — Sign in to confirm you're not a bot`** for
gated label tracks to every InnerTube client that is not a *fully signed-in web
session with attestation*. The app resolved nothing because it had neither a real
cookie session on the server nor a working BotGuard token, and its only
authenticated path (OAuth on TVHTML5) cannot mint the attestation YouTube now
demands. "Reconnect YouTube" re-ran the device-code OAuth flow, which authenticates
**library reads** only — it can never fix playback. That is why reconnecting changed
nothing.

## 2. How the JAMC desktop client actually plays

Read from `JustAnotherMusicClient/src` and `src-tauri/src`:

| Piece | JAMC implementation | Why it matters |
|---|---|---|
| Transport | `tauriFetch` → Rust `proxy_http_request` (reqwest) | No CORS, no browser origin limits; requests leave from the user's own IP. |
| Credentials | `document.cookie` from the **embedded YouTube webview**, then `SAPISIDHASH = SHA1("<ts> <SAPISID> <origin>")` plus `x-goog-authuser: 0` | It owns a real signed-in YouTube session, including httpOnly cookies. |
| Attestation | `bgutils-js` BotGuard **inside the webview** (`po_token.ts`), mint → `mintAsWebsafeString(videoId)` | A secure context with a real browser VM gives tokens YouTube accepts. |
| Resolution | `getStreamingData()` / `getInfo().chooseFormat()` across MUSIC → WEB → TV → ANDROID; `retrieve_player: true` for deciphering | Multiple clients, all authenticated by the same cookie session. |
| Media | Rust fetches `googlevideo` bytes and hands them to the webview | CDN URL and request share one IP. |

So JAMC wins on three things at once: **real cookies + real browser attestation +
same-IP transport**. A web app served from `http://192.168.0.152:4100` has none of
them by default.

## 3. Why the web app could not simply copy that

* It cannot read `youtube.com` cookies — different origin, and the session cookies
  (`SID`, `HSID`, `SSID`) are httpOnly.
* The origin is plain HTTP on a LAN address, so `window.isSecureContext === false`
  and `crypto.subtle` is `undefined` — host BotGuard tooling assumes a secure
  context.
* All InnerTube traffic is proxied through the server (`/api/yt/proxy`), so the
  requests leave from the server's IP with the server's credentials, not the
  browser's.

## 4. Iteration log

| # | Hypothesis | Experiment | Result |
|---|---|---|---|
| 1 | The deployed build is fine and YouTube is down | `tmp-yt-matrix.mjs`: raw `/player` for WEB, WEB_REMIX, ANDROID, IOS, TVHTML5, ANDROID_VR on a public video | IOS and ANDROID_VR return plain URLs (CDN `206`); TVHTML5 `UNPLAYABLE — page needs to be reloaded`; WEB family refused |
| 2 | `youtubei.js` misbehaves | Same ladder through the library in Node | MUSIC/WEB succeed but withhold URLs (metadata-only); IOS/ANDROID_VR fine; confirms server-side library behaviour matches raw HTTP |
| 3 | The proxy breaks `youtubei.js` | Harness calling the real `forwardProxyRequest` with a `Request`-aware adapter | First run showed `405` — a **harness bug**, not app code; after fixing the adapter everything matched direct calls |
| 4 | The proxy is stripping something YouTube needs | Inspected `prepare()` in `services/proxy.ts` | Confirmed: client `Origin`/`Referer` were dropped and never re-added → `WEB`/`WEB_REMIX` answer `UNPLAYABLE — Video unavailable`. **Fixed**: origin/referer are now derived from host + client name |
| 5 | The linked account's OAuth token should unlock playback | Raw TVHTML5 `/player` with a Bearer | With a fake token: `invalid authentication credentials`; anonymous TVHTML5: PO-token wall. OAuth cannot carry playback |
| 6 | A web-minted po-token breaks mobile clients | IOS `/player` with a bogus `serviceIntegrityDimensions.poToken` | Still `OK` — a bogus token is ignored, so token plumbing is not what fails there. **Fixed anyway**: the client no longer attaches a web token to `tv`/`android`/`ios` |
| 7 | Gated tracks are just unavailable | Same matrix on real label tracks | Every client: `LOGIN_REQUIRED — Sign in to confirm you're not a bot`. This is the user's actual failure |
| 8 | The user's network is blocked | Played the same track in a real Chromium on `music.youtube.com` | Plays (281 s, `readyState 4`) — but the browser profile was **signed in** (`ytcfg LOGGED_IN true`, `SAPISID` present). Network is fine; the account is doing the work |
| 9 | Cookies alone are enough | Same-origin `/player` call from that signed-in page, cookies sent, no po-token | `LOGIN_REQUIRED` — the site must also attach a BotGuard token |
| 10 | Server-side BotGuard can replace the browser | `bgutils-js` in Node, `Create` + snapshot + `GenerateIT` | Works: real integrity token and a 116-char po-token. But playing with it still returns `LOGIN_REQUIRED` (tokens minted from a Node VM are not accepted for `/player`) |
| 11 | The modern `att/get` challenge fixes acceptance | `Innertube.getAttestationChallenge` + interpreter + snapshot + `GenerateIT` | `GenerateIT` returns **no integrity token** for a jsdom VM — the WAA rejects headless attestation |
| 12 | jsdom just needs a DOM shim | jsdom window/document/globals before eval | VM runs, snapshot produced, still no integrity token. Server-side attestation is a dead end |
| 13 | If the VM runs in the browser it will be accepted | Same flow executed in real Chromium via `preview_evaluate` | **Works** — 116-char token. BotGuard acceptance is environment-bound |
| 14 | A browser token + server cookies will play | `POST /api/media/resolve` with the browser token | Still `LOGIN_REQUIRED`. A token without the session-bound visitor is not enough |
| 15 | The token must match the session's visitor | Bootstrap `music.youtube.com` **with** the user's cookies before minting | Still `LOGIN_REQUIRED`; the imported session itself is the problem (next row) |
| 16 | The imported cookie header is a real session | `account_menu` through the proxy with the stored cookies | `logged_in: 0`, no account. The header came from `document.cookie`, which **cannot see httpOnly `HSID`/`SSID`** — so SAPISIDHASH signs nothing |
| 17 | A bookmarklet is a good UX for that | Built a fragment-import bookmarklet and ran it end to end | It imports smoothly and *looks* successful, but the session is not authenticated — a trap. **Removed** |
| 18 | Verification at import time would have caught this | Added `verifyYouTubeSession()` (account menu with SAPISIDHASH) and rejected unverified headers | Confirmed: partial header → `400` with the exact DevTools instruction; server logs no secrets |

## 5. Final design shipped in this branch

### Credential ladder (server, `services/youtubePlayback.ts`)

`POST /api/media/resolve` tries, in order, and reports each attempt:

1. **cookies** — `WEB_REMIX` then `WEB` on `music.youtube.com`, signed with
   `SAPISIDHASH`, using the visitor id from a cookie-authenticated bootstrap and the
   current client version.
2. **tv** — `TVHTML5` with the linked account's OAuth Bearer (library path, kept).
3. **anonymous** — `ANDROID_VR` then `IOS`, which still serve plain URLs for public
   tracks.

Failures return `{ error, attempts[] }` where each attempt names the client, its
playability status and how many playable formats it offered. The UI can therefore
say "connect the YouTube session" instead of "playback failed".

### Proxy (`services/proxy.ts`)

* Derives `Origin`/`Referer` from the hop and the InnerTube client (never from the
  caller), so `WEB`/`WEB_REMIX` stop answering "Video unavailable".
* Still strips client-supplied cookies/authorization; still never leaks credentials
  across a redirect to another origin.
* Injects the stored session (SAPISIDHASH) and the OAuth Bearer only where each is
  accepted.

### Playback sign-in (`/api/youtube/cookies`)

* Accepts a full `Cookie:` header, validates it structurally **and** against
  YouTube (`account_menu` with SAPISIDHASH) before storing it.
* Rejects partial headers (the `document.cookie` trap) with instructions to copy the
  DevTools request header, which includes the httpOnly cookies.
* Stores it encrypted with `APP_SECRET`; never returns it to the browser or logs it.
* Settings now leads with that flow, and the playback-failure action opens Settings
  instead of restarting the OAuth device flow that cannot fix playback.

### Attestation

The browser mints BotGuard tokens itself (`client/src/datasource/youtube/poToken.ts`,
verified working in Chromium) and the token travels with `/api/media/resolve` for the
web clients. The server never pretends to mint what YouTube will not accept.

## 6. What was verified, and what was not

Verified locally (real server, real network):

* Public track resolves through the anonymous ladder (`via: anonymous`, itag 140,
  `audio/mp4`) and `/api/media/stream` relays `206` with 131,072 bytes.
* Gated track without a session → `502` with per-client `LOGIN_REQUIRED` attempts and
  the "Playback sign-in" guidance.
* Full cookie import (verified session) → library browse works through the proxy.
* Partial header → `400` with the httpOnly explanation.
* BotGuard in-browser mint → 116-char token.
* `266 → 269` server tests and `46` client tests pass; both packages typecheck.

Not verified here: a gated track playing with a **fully valid** cookie header. This
machine's browser session is the user's own Google account, and its httpOnly cookies
(`HSID`, `SSID`) are not readable through the automation surface, so the complete
header could not be assembled without extracting credentials. The mechanism is the
one JAMC uses; the remaining step is the user pasting the DevTools header once,
which the import endpoint now validates before accepting.
