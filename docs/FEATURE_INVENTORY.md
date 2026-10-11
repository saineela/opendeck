# Feature Inventory — JustAnotherMusicClient → Web

Source of truth: `../JustAnotherMusicClient` (Tauri desktop YouTube Music client, React 19 + TS + `youtubei.js` v17).

## Architecture of the original

- **Shell**: Tauri 2 (Rust). Rust side (`src-tauri/src/lib.rs`) provides:
  - `proxy_http_request` — CORS-bypass HTTP proxy for all InnerTube/YouTube calls (adds SAPISIDHASH cookie auth, cookie jar persistence).
  - Encrypted YouTube cookie storage (OS keychain / encrypted file).
  - `sign_in_youtube_music` — opens a native webview at the Google login URL, polls for SAPISID cookies, saves them.
  - Disk LRU cache (`cache_*`), durable app settings (`app_setting_*`).
  - Local audio scan/read, audio source fetch (with Range), downloads to disk.
  - Last.fm API (token/auth/scrobble), Windows/macOS media keys, tray, updater.
- **Frontend** (all reusable, runs in a webview today):
  - `datasource/` — abstract `DataSource` + `YouTubeMusicDataSource` (4.6k LOC: search, suggestions, artist/album/playlist pages, library, likes, subscriptions, recommendations, lyrics via LRCLIB/BetterLyrics/YouTube transcripts, stream resolution with quality selection, play reporting, po-token attestation).
  - `player/` — `AudioEngine` (YouTube IFrame API + native `<audio>` fallback), `PlayerController` (state machine, queue navigation, autoplay radio, repeat/shuffle, scrobble ticks), `Queue` (manual vs automatic queue semantics), `TabManager` (multiple independent player tabs), `LibraryController` (sign-in/refresh state machine with optimistic like/save), `SearchController` (stream-sorted results), `localPlaylists`, `LastFm` (threshold logic), `useMediaSession` (browser Media Session API + native), `appSession` persistence (localStorage).
  - `ui/` — tab-based navigation (home/album/artist/playlist/search/settings per tab), Sidebar, SearchOverlay (Ctrl+K), PlayerBar/ExpandedPlayer, QueuePanel, LyricsView, Track/Playlist context menus (Ctrl+S), MagicDice recommendation wheel, Onboarding, error toasts, themes, keyboard shortcuts, settings pages.

## Feature-by-feature inventory

| # | Feature | Original implementation | Data / API | Web adaptation | Status |
|---|---|---|---|---|---|
| 1 | Search (tracks/artists/albums/playlists + suggestions) | `YouTubeMusicDataSource.search/searchTracks/getSearchSuggestions` via `youtubei.js` InnerTube `search` | InnerTube (no auth needed) | Same code; HTTP via backend `/api/yt/proxy` (CORS) | Reuse |
| 2 | Home / recommendations / MagicDice | `HomePage.tsx`, `getRecommendations` (watch-next) | InnerTube player/watch-next | Reuse | Reuse |
| 3 | Artist pages (popular, albums, subscribe) | `getArtist`, `setArtistSubscribed` | InnerTube browse | Reuse | Reuse |
| 4 | Album pages, save album | `getAlbumTracks`, `setAlbumSaved` | InnerTube browse + library edit | Reuse (needs YT sign-in) | Reuse |
| 5 | Playlists (view, create?, add/remove track, save) | `getPlaylistTracks/TrackPage`, `addTrackToPlaylist`, `removeTrackFromPlaylist`, `setPlaylistSaved` | InnerTube playlist edit | Reuse (needs YT sign-in) | Reuse |
| 6 | Liked songs / like toggle | `getLikedSongs`, `setTrackLiked` | InnerTube `like` endpoint | Reuse (needs YT sign-in) | Reuse |
| 7 | Library landing (albums, playlists, history) | `getLibrary` (browse `FElibrary`/history) | InnerTube | Reuse (needs YT sign-in) | Reuse |
| 8 | Playback: play/pause/seek/volume/next/prev, repeat/shuffle, queue, autoplay radio | `PlayerController` + `Queue` + `AudioEngine` | YouTube IFrame API (browser-native already) | Reuse as-is | Reuse |
| 9 | Multi-tab players (each tab own queue/volume/state) | `TabManager`, `appSession` localStorage persistence | — | Reuse as-is (in-page tabs) | Reuse |
| 10 | Session restore on restart (tabs, queue, position, paused) | `appSession.ts` + `restoreWithoutAutoplay` | localStorage | Reuse as-is (survives browser refresh) | Reuse |
| 11 | Lyrics (synced; LRCLIB, BetterLyrics, YT transcript, YT Music) | `getLyrics` + `lyricsSources.ts` | lrclib.net, lyrics-api.boidu.dev, BetterLyrics, InnerTube | Reuse; non-YouTube hosts CORS-blocked → route via `/api/yt/proxy` allowlist | Reuse w/ proxy |
| 12 | **Sign-in** (Google account → YouTube Music session) | Native webview + cookie polling + keychain encryption (`sign_in_youtube_music`) | Google login webview | **Two-part web equivalent:** (a) Google Sign-In (OAuth 2.0 code+PKCE, env credentials) = app account/session; (b) YouTube Music account connect via youtubei.js device-code OAuth (`verificationUrl`+`userCode`, matches original `AuthPrompt` type), tokens stored server-side encrypted, injected as `Authorization: Bearer` by the proxy | **Rebuilt (web constraints)** |
| 13 | Sign out (revoke + clear cache) | `delete_youtube_music_cookie` etc. | — | Server revokes OAuth token, deletes rows, clears user cache namespace | Rebuilt |
| 14 | Caching (disk LRU, size limit, stats, clear) | Rust `cache_*` commands | Filesystem | Server SQLite LRU cache with byte cap + `/api/cache/*` endpoints | Rebuilt |
| 14b | Artwork cache (album art, thumbnails, channel avatars) | Not cached — every `<img>` hit Google directly | Filesystem | `GET /api/artwork?url=…` serves SQLite **BLOBs** keyed by `sha256(url)`, once per instance instead of once per browser. ETag/304, concurrent-miss coalescing, 5 s failure cooldown, `immutable` 30-day browser caching. Budget is admin-set (64 MB – 64 GB) and enforced by evicting least-played artwork first, using `play_history` matched through a normalized artwork identity. Admins get a manual “format” that empties the cache and VACUUMs the file back down. | **Added beyond original** |
| 15 | Durable app settings | Rust `app_setting_*` | JSON file | Server SQLite per-user settings `/api/settings/*` + localStorage mirror (original dual-write pattern kept) | Rebuilt |
| 16 | Stream URL resolution / quality (normal/high) | `resolveStream` client order + `audioQuality.ts` | InnerTube player | Reuse | Reuse |
| 17 | Play reports (watchtime stats ping) | `beginPlayReport/updatePlayReport` | `pagestats` via proxy | Reuse (Bearer injected when signed in) | Reuse |
| 18 | Downloads (downloader plugin: queue, progress, folder listing) | `downloaderStore` + Rust `download_audio_*` | googlevideo streams → disk | **Intentionally changed:** save-to-disk removed (browser apps must not hand audio to the OS download manager). Offline *playback* kept: the same store caches bytes in IndexedDB, a playlist-level "make available offline" button and per-track status badge remain, and the queue/progress popover was relabelled "Offline audio". | **Changed** |
| 19 | Last.fm (auth, now-playing, scrobble thresholds) | `LastFm.ts` logic + Rust `lastfm_*` (md5 api_sig) | ws.audioscrobbler.com | **Removed entirely** in the web app: UI section, client service, server routes, `lastfm_sessions` table (dropped by migration), and env config all deleted. | **Removed** |
| 21 | Media Session / OS media keys | `useMediaSession.ts` (browser Media Session API branch + Windows native branch) | navigator.mediaSession | Browser branch reused as-is; native branch unreachable (`isTauri()` false) | Reuse |
| 22 | Synced lyrics view + lyrics button | `LyricsView`, `LyricsButton` | — | Reuse | Reuse |
| 23 | Queue panel (reorder, remove, click-to-play) | `QueuePanel` + Queue ops | — | Reuse | Reuse |
| 24 | Context menus (add to queue/play next/playlist/like, Ctrl+S) | `TrackContextMenu`, `PlaylistContextMenu` | LibraryController | Reuse | Reuse |
| 25 | Search history? | Not present (only `recentlyPlayed` library + recents in search overlay?) | — | — | N/A |
| 26 | Settings: audio quality, authenticated streaming, YT scrobbling toggles | `audioQuality.ts`, `youtubeAccount.ts` | — | Reuse | Reuse |
| 27 | Settings: themes + custom CSS import (file) | `themes.ts` + Rust `custom_theme_css_*` | Filesystem | Web: theme selection reused; custom CSS via file input (stored in localStorage/durable settings) | Adapted |
| 28 | Settings: keyboard shortcuts editor | `keyboardShortcuts.ts` | — | Reuse | Reuse |
| 29 | Settings: account (profile, sign-in/out) | SettingsPage Account section | — | Rewritten for Google Sign-In + YT connect | Rebuilt |
| 30 | Onboarding flow | `Onboarding.tsx` | — | Reuse (sign-in step now Google OAuth) | Reuse/Adapt |
| 31 | Error toast viewport, loading screen | `ErrorToastViewport`, `AppLoadingScreen` | — | Reuse | Reuse |
| 32 | Mini player (separate OS window) | Tauri `WebviewWindow` + `mini.html` | — | **Desktop-only concept.** Web equivalent = browser Media Session (OS-level controls) + always-visible player bar; separate window not reproducible (could use Document PiP later). Documented. | N/A (documented) |
| 33 | Update toast / release changelog modal | GitHub releases fetch | api.github.com | **N/A on web** (server-pulled deployments update themselves). Removed; documented. | N/A (documented) |
| 34 | Window controls, tray, autostart, window geometry, drag regions, paper PC mode | Tauri window APIs | — | Desktop-only chrome → removed for web (browser provides window management). | N/A (documented) |
| 35 | Local files / local playlists | Rust `local_audio_scan/read` (full filesystem scan) | Filesystem | File System Access API directory picker (Chromium) + `<input type=file>` fallback; playback via existing native-audio path in AudioEngine | Adapted |
| 36 | Logging (frontend_log → file, log viewer) | Rust log file + sanitize | — | Browser console + server logs; in-app log viewer removed (browser devtools is the equivalent) | Adapted |
| 37 | Plugin host (zip import) | `pluginHost.ts` | Zip from disk | Kept for official plugins only? Zip import via file input possible; keep host, keep downloader plugin. | Reuse |
| 38 | po-token / attestation for download streams | `poToken.ts` (bgutils-js/BotGuard) | Browser challenge | Reuse (browser-native) | Reuse |
| 39 | Sleep-recovery, visibility handling, back/forward mouse buttons, tab history | `App.tsx` | — | Reuse | Reuse |

## Backend requirements (new)

1. `/api/yt/proxy` — mirrors `proxy_http_request`: `{url, method, headers, body_base64, timeout_ms}` → `{status, headers, body_base64}`. Host allowlist; injects `Authorization: Bearer <YouTube OAuth access token>` for signed-in sessions with a linked YouTube account (replaces SAPISID cookie auth); automatic token refresh.
2. Google OAuth 2.0 authorization-code + PKCE (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), discovery against accounts.google.com; sessions in SQLite, httpOnly `SameSite=Lax` cookie, revocable.
3. YouTube device-code OAuth (server-side, youtubei.js `OAuth2` endpoints at `youtube.com/o/oauth2/*`), tokens AES-256-GCM encrypted at rest keyed by `APP_SECRET`, per user.
4. SQLite (`node:sqlite`): users, sessions, oauth tokens, cache entries (LRU + byte cap), image cache (BLOBs + byte cap), durable settings, api keys.
5. `/api/media/download` — resolve + stream audio bytes (Range-capable) for the downloader plugin.
6. `/api/cache/*`, `/api/settings/*` — ports of Rust cache/app-setting commands. `/api/artwork` is new: the shared binary image cache described in row 14b, with its admin budget/format controls at `/api/cache/artwork/*` and `/api/admin/image-cache`.
7. `/api/keys` — per-account API keys (Bearer `odk_…`), SHA-256-hashed at rest; management requires a browser session.

## Explicitly not reproducible on the web (documented in README)

- Native OS window chrome: tray, autostart, window geometry, minimize-to-tray, native title bar buttons, native Windows/macOS media-key integration (browser Media Session covers OS media keys).
- Auto-update + release changelog modal (web deployments are updated server-side).
- Mini player as separate OS window (browser equivalent: Media Session + player bar; Document PiP is a possible future enhancement).
- Encrypted OS-keychain credential storage (replaced by server-side AES-GCM encryption of OAuth tokens; browser never sees tokens).
