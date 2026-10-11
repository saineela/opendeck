# OpenDeck vs. JustAnotherMusicClient — feature diff & contributor notes

OpenDeck is a self-hosted, multi-user web adaptation of
[JustAnotherMusicClient](https://github.com/2latemc/JustAnotherMusicClient)
(Tauri + React + TypeScript desktop client). Upstream is **Apache-2.0**, which
expressly permits derived works with attribution, so this port exists legally
and respectfully. This document lists everything OpenDeck adds beyond the
original, for comparison and for upstreaming ideas back.

## What OpenDeck keeps from JAMC

Everything that made JAMC good: multiple tabs with independent queues/volume,
YouTube Music browse/search/like, recommendations home tab with the shuffle
wheel, synced lyrics, mini player, offline downloads with quality selection,
plugins (official + imported zip), twelve themes + custom CSS, context-menu
song management, and the general UI language.

## What OpenDeck adds

### Accounts & security (largest category — JAMC is single-user)

| Addition | Detail |
|---|---|
| Multi-user accounts | Email+password (scrypt) and/or any OIDC provider; every playlist, like, setting, API key, and YouTube link is scoped per account |
| TOTP two-step verification | RFC 6238 + single-use backup codes; disabling needs password + live code, so a hijacked session can't downgrade the account |
| Any OIDC sign-in | Google, Keycloak, Authentik… authorization-code + PKCE, reconfigurable at runtime from the admin panel (secret is write-only) |
| Admin panel | Create users, change roles, revoke sessions everywhere, reset stuck 2FA, TOTP-gated instance reset |
| First-run setup + invite codes | Zero-account instances show a setup screen; registration is env- and admin-switchable |
| Hardening | Per-IP rate limits on every auth route, account lockout, CSRF origin checks, constant-time comparisons, session revocation |

### Platform & theming

| Addition | Detail |
|---|---|
| Instance theme | Admin sets the default theme for the whole server — it applies to the **sign-in page** and to every account that hasn't chosen its own; personal themes still win inside the app ("Use instance theme" resets to it) |
| Branded sign-in page at `/login` | Full page: first-run setup, password, invite codes, TOTP step, OIDC |

### Caching & performance (server-side, shared)

| Addition | Detail |
|---|---|
| Shared artwork cache | Album art/thumbnails/avatars cached **once per instance** as SQLite BLOBs keyed by `sha256(url)`; ETag/304, concurrent-miss coalescing, 5 s failure cooldown, 30-day immutable browser caching, admin budget (64 MB–64 GB) with least-played eviction and a "format" that VACUUMs the file |
| JSON LRU cache | Upstream API responses cached with a byte cap, shared across all users |
| Debug overlay | Admin-only, per-page cache inspector: every rendered image tagged "our cache" vs "direct", server cache totals, browser storage |

### Developer surface

| Addition | Detail |
|---|---|
| HTTP API + keys | Per-account `odk_…` bearer keys (plaintext shown once, SHA-256 stored; key management requires the browser session) with per-key play stats |
| Self-hosted docs | `/docs` — rendered API reference, INTEGRATION guide, OpenAPI spec, bare test client |
| Play history API | Record plays with `source: "app" | "api"`, per-key and per-user stats |
| Container packaging | Dockerfile + docker-compose; one process, any NAS |

### Ideas borrowed *back* from other clients (planned roadmap)

Crossfade + Web Audio EQ, Last.fm scrobbling, scored multi-source lyrics
(LRCLIB/Genius with duration-aware matching), negative caching of misses —
researched from YTubic and others; several are already on the roadmap.

---

## Message for the JAMC repo (issue or PR intro)

> **Subject: Porting JAMC's spirit to a self-hosted web build — and a few
> features worth borrowing back**
>
> Hi! I've been a fan of JustAnotherMusicClient for a while and recently
> built a self-hosted, multi-user web port of it — same UI language, same
> feature heart (tabs, queues, synced lyrics, recommendations wheel, plugins,
> themes), but running as a Node + SQLite server you share with friends
> instead of a desktop app. Your Apache-2.0 license made that possible, and
> the attribution/permission terms were clear and easy to respect — thank you
> for licensing it the way you did.
>
> A few things I built along the way that might interest this project, in case
> any are worth upstreaming or discussing:
>
> > 1. **Instance/default theme concept.** For anyone self-hosting variants:
>    an admin-chosen default theme that also styles the sign-in surface, while
>    each user keeps their own override. Directly relevant to the
>    customization requests in #1 and the theming discussion in #49.
> 2. **Server-side shared artwork cache.** In my port, album art is fetched
>    once per *instance* (SQLite BLOBs, ETag/304, LRU by least-played, admin
>    budget) instead of once per client. For JAMC this idea could translate to
>    a smarter on-disk image cache with proper eviction — you already do
>    IndexedDB/local caching, and a byte-bounded LRU layer on top would make
>    the "Caching" feature even stronger.
>
> I know JAMC is Tauri-first and this is a web build, so a direct code PR
> mostly won't apply — but I'd be happy to contribute any of the above as
> proper desktop-side PRs (1 and 2 are genuinely small: a menu item +
> settings flag, and a payload field). If any of that sounds useful, point me
> at the right area and I'll follow the contributing flow — fork, branch,
> local test, clear description — and sign the CLA.
>
> Either way, thanks for building something worth porting. 🙏
>
> — (your GitHub handle)

### Notes before posting

- JAMC is Apache-2.0 with a **CLA**: contributing grants the owner a
  perpetual, worldwide, irrevocable, sublicensable license to your work.
  Read [CLA.md](https://github.com/2latemc/JustAnotherMusicClient/blob/main/CLA.md)
  before a PR; posting an idea in an issue carries no such grant.
- Relevant upstream issues: **#1** (feature requests and customization),
  **#36** (dynamic colors from album cover), **#49** (theming).
- Legal contact upstream: team@2late.org. Sponsored via Ko-fi/GitHub
  Sponsors (`2latemc`).
