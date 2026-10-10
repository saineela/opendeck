import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase, type Db } from "./db.js";
import { SESSION_COOKIE, createSession } from "./middleware/session.js";
import {
  parseAutomixEndpoint,
  parseHomeSections,
  parsePlaylistDetail,
  parseWatchNext,
} from "./services/feed.js";
import { replaceLibrarySnapshot } from "./services/libraryStore.js";

/**
 * Feed API: home shelves, watch-next recommendations, and playlist detail.
 *
 * Every upstream call is stubbed at the global `fetch` layer, so these cases
 * assert the parsing contract (what a client renders from) and the security
 * contract (session required, input validated, upstream failures become 502
 * rather than raw passthrough) without touching the network.
 */

interface Harness {
  db: Db;
  base: string;
  cookie: string;
  close: () => Promise<void>;
}

let harness: Harness;

/* ------------------------------------------------------------------ *
 * Fixtures — trimmed shapes from live music.youtube.com probes
 * ------------------------------------------------------------------ */

const HOME_FIXTURE = {
  contents: {
    singleColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    musicCarouselShelfRenderer: {
                      header: {
                        musicCarouselShelfBasicHeaderRenderer: {
                          title: { runs: [{ text: "Today's biggest hits" }] },
                        },
                      },
                      contents: [
                        {
                          musicTwoRowItemRenderer: {
                            thumbnailRenderer: {
                              musicThumbnailRenderer: {
                                thumbnail: {
                                  thumbnails: [
                                    { url: "https://img/s226.jpg", width: 226, height: 226 },
                                    { url: "https://img/s544.jpg", width: 544, height: 544 },
                                  ],
                                },
                              },
                            },
                            title: {
                              runs: [
                                {
                                  text: "Country Hotlist",
                                  navigationEndpoint: {
                                    browseEndpoint: {
                                      browseId: "VLRDCLAK5uy_lJ8xZWiZj2GCw7MArjakb6b0zfvqwldps",
                                      params: "ggMEgALjBA%3D%3D",
                                      browseEndpointContextSupportedConfigs: {
                                        browseEndpointContextMusicConfig: {
                                          pageType: "MUSIC_PAGE_TYPE_PLAYLIST",
                                        },
                                      },
                                    },
                                  },
                                },
                              ],
                            },
                            subtitle: {
                              runs: [{ text: "Ella Langley" }, { text: ", " }, { text: "Morgan Wallen" }],
                            },
                          },
                        },
                        {
                          musicTwoRowItemRenderer: {
                            thumbnailRenderer: {
                              musicThumbnailRenderer: {
                                thumbnail: { thumbnails: [{ url: "https://img/a.jpg", width: 226 }] },
                              },
                            },
                            title: { runs: [{ text: "Golden Hour" }] },
                            navigationEndpoint: {
                              browseEndpoint: {
                                browseId: "MPREb_album123",
                                browseEndpointContextSupportedConfigs: {
                                  browseEndpointContextMusicConfig: {
                                    pageType: "MUSIC_PAGE_TYPE_ALBUM",
                                  },
                                },
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                  {
                    musicTastebuilderShelfRenderer: {
                      title: { runs: [{ text: "Taste builder" }] },
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
};

const NEXT_FIXTURE = {
  contents: {
    singleColumnMusicWatchNextResultsRenderer: {
      tabbedRenderer: {
        watchNextTabbedResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                content: {
                  musicQueueRenderer: {
                    content: {
                      playlistPanelRenderer: {
                        contents: [
                          {
                            playlistPanelVideoRenderer: {
                              videoId: "seedVideo01",
                              title: { runs: [{ text: "Seed Song" }] },
                              shortBylineText: { runs: [{ text: "Seed Artist" }] },
                            },
                          },
                          {
                            playlistPanelVideoRenderer: {
                              videoId: "dQw4w9WgXcQ",
                              title: { runs: [{ text: "Never Gonna Give You Up" }] },
                              longBylineText: {
                                runs: [
                                  { text: "Rick Astley" },
                                  { text: " • " },
                                  { text: "1.8B views" },
                                ],
                              },
                              shortBylineText: { runs: [{ text: "Rick Astley" }] },
                              lengthText: { runs: [{ text: "3:34" }] },
                              thumbnail: {
                                thumbnails: [
                                  { url: "https://i.ytimg.com/vi/x/hqdefault.jpg", width: 400, height: 225 },
                                  { url: "https://i.ytimg.com/vi/x/hq720.jpg", width: 800, height: 450 },
                                ],
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
};

const PLAYLIST_FIXTURE = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    musicResponsiveHeaderRenderer: {
                      thumbnail: {
                        musicThumbnailRenderer: {
                          thumbnail: {
                            thumbnails: [{ url: "https://yt3/cover.jpg", width: 600, height: 600 }],
                          },
                        },
                      },
                      title: { runs: [{ text: "Country Hotlist" }] },
                      subtitle: { runs: [{ text: "Playlist" }, { text: " • " }, { text: "2026" }] },
                      description: {
                        musicDescriptionShelfRenderer: {
                          description: { runs: [{ text: "Your one-stop shop for today's hits." }] },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      ],
      secondaryContents: {
        sectionListRenderer: {
          contents: [
            {
              musicPlaylistShelfRenderer: {
                playlistId: "RDCLAK5uy_test",
                contents: [
                  {
                    musicResponsiveListItemRenderer: {
                      thumbnail: {
                        musicThumbnailRenderer: {
                          thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/6q5F/hqdefault.jpg", width: 400 }] },
                        },
                      },
                      flexColumns: [
                        {
                          musicResponsiveListItemFlexColumnRenderer: {
                            text: {
                              runs: [
                                {
                                  text: "Been By Now",
                                  navigationEndpoint: {
                                    watchEndpoint: { videoId: "6q5F7UUiXK0" },
                                  },
                                },
                              ],
                            },
                          },
                        },
                        {
                          musicResponsiveListItemFlexColumnRenderer: {
                            text: { runs: [{ text: "Morgan Wallen" }] },
                          },
                        },
                        {
                          musicResponsiveListItemFlexColumnRenderer: { text: {} },
                        },
                      ],
                      fixedColumns: [
                        {
                          musicResponsiveListItemFixedColumnRenderer: {
                            text: { runs: [{ text: "3:35" }] },
                          },
                        },
                      ],
                      playlistItemData: { videoId: "6q5F7UUiXK0" },
                    },
                  },
                  {
                    musicResponsiveListItemRenderer: {
                      flexColumns: [
                        {
                          musicResponsiveListItemFlexColumnRenderer: {
                            text: { runs: [{ text: "Deleted Track" }] },
                          },
                        },
                        {
                          musicResponsiveListItemFlexColumnRenderer: {
                            text: { runs: [{ text: "Someone" }] },
                          },
                        },
                      ],
                      fixedColumns: [
                        {
                          musicResponsiveListItemFixedColumnRenderer: {
                            text: { runs: [{ text: "0:42" }] },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
};

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "feed-test-secret-0123456789abcdef",
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "od-feed-")),
  });
  const db = openDatabase(":memory:");
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, auth_provider, google_sub, name, email, picture, created_at, last_login_at)
     VALUES (?, 'password', NULL, ?, ?, NULL, ?, ?)`,
  ).run(crypto.randomUUID(), "Fay Feed", "fay@example.com", now, now);

  const server = http.createServer(createApp(config, db));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const userId = (
    db.prepare("SELECT id FROM users WHERE email = ?").get("fay@example.com") as { id: string }
  ).id;
  harness = {
    db,
    base: `http://127.0.0.1:${port}`,
    cookie: `${SESSION_COOKIE}=${createSession(db, userId)}`,
    close: async () => {
      server.close();
      await once(server, "close");
      db.close();
    },
  };
});

afterEach(async () => {
  await harness.close();
  vi.unstubAllGlobals();
});

/** Stubs global fetch: InnerTube URLs answer with `payload`, everything else falls through. */
function stubUpstream(
  payload: unknown | unknown[],
  options: { status?: number; body?: string } = {},
): Array<{ url: string; body: Record<string, unknown> }> {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const queue = Array.isArray(payload) ? payload : [payload];
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (!url.startsWith("https://music.youtube.com/")) return realFetch(input, init);
    // The proxy sends the InnerTube payload as a Buffer (body_base64 decoded).
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } else if (init?.body) {
      body = JSON.parse(Buffer.from(init.body as ArrayBuffer).toString("utf8")) as Record<string, unknown>;
    }
    calls.push({ url, body });
    const next = options.body !== undefined ? options.body : JSON.stringify(queue[Math.min(calls.length - 1, queue.length - 1)]);
    return Promise.resolve(
      new Response(next, {
        status: options.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return calls;
}

function call(method: string, pathname: string, cookie?: string): Promise<Response> {
  return fetch(`${harness.base}${pathname}`, {
    method,
    headers: cookie ? { cookie } : {},
  });
}

/* ------------------------------------------------------------------ *
 * Pure parser cases
 * ------------------------------------------------------------------ */

describe("feed parsers", () => {
  it("normalizes home shelves and skips the tastebuilder shelf", () => {
    const sections = parseHomeSections(HOME_FIXTURE);
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe("Today's biggest hits");
    expect(sections[0].items).toHaveLength(2);

    const [playlist, album] = sections[0].items;
    expect(playlist).toMatchObject({
      id: "VLRDCLAK5uy_lJ8xZWiZj2GCw7MArjakb6b0zfvqwldps",
      type: "playlist",
      title: "Country Hotlist",
      subtitle: "Ella Langley, Morgan Wallen",
      artworkUrl: "https://img/s544.jpg", // largest thumbnail wins
      params: "ggMEgALjBA%3D%3D",
    });
    expect(album).toMatchObject({ type: "album", title: "Golden Hour" });
  });

  it("returns no shelves for an unrecognizable payload", () => {
    expect(parseHomeSections({ error: "unexpected" })).toEqual([]);
  });

  it("drops the seed video from watch-next and keeps durations", () => {
    const items = parseWatchNext(NEXT_FIXTURE, "seedVideo01");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      videoId: "dQw4w9WgXcQ",
      title: "Never Gonna Give You Up",
      subtitle: "Rick Astley",
      artworkUrl: "https://i.ytimg.com/vi/x/hq720.jpg",
      durationText: "3:34",
      durationSeconds: 214,
    });
  });

  it("parses the playlist header, description, and ordered tracks", () => {
    const playlist = parsePlaylistDetail(PLAYLIST_FIXTURE, "VLRDCLAK_test");
    expect(playlist).toMatchObject({
      browseId: "VLRDCLAK_test",
      title: "Country Hotlist",
      subtitle: "Playlist • 2026",
      artworkUrl: "https://yt3/cover.jpg",
      description: "Your one-stop shop for today's hits.",
    });
    expect(playlist.tracks).toHaveLength(2);
    expect(playlist.tracks[0]).toMatchObject({
      videoId: "6q5F7UUiXK0",
      title: "Been By Now",
      artist: "Morgan Wallen",
      album: null,
      artworkUrl: "https://i.ytimg.com/vi/6q5F/hqdefault.jpg",
      durationText: "3:35",
      durationSeconds: 215,
    });
    // Rows without a watchEndpoint keep their title but carry no videoId.
    expect(playlist.tracks[1]).toMatchObject({ title: "Deleted Track", videoId: null });
  });

  it("throws 404 when no header renderer exists", () => {
    expect(() => parsePlaylistDetail({ contents: {} }, "VLRD_x")).toThrowError(
      /No playlist found/,
    );
  });

  it("extracts the automix watchPlaylistEndpoint from a seed-only panel", () => {
    expect(
      parseAutomixEndpoint({
        playlistPanelRenderer: {
          contents: [
            { automixPreviewVideoRenderer: { content: { automixPlaylistVideoRenderer: { navigationEndpoint: { watchPlaylistEndpoint: { playlistId: "RDAMVMx", params: "p%3D" } } } } } },
          ],
        },
      }),
    ).toEqual({ playlistId: "RDAMVMx", params: "p%3D" });
    expect(parseAutomixEndpoint({ playlistPanelRenderer: { contents: [] } })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Route cases
 * ------------------------------------------------------------------ */

describe("feed routes", () => {
  it("rejects every route without a session", async () => {
    const routes = [
      "/api/feed/home",
      "/api/feed/next?videoId=dQw4w9WgXcQ",
      "/api/feed/playlist?browseId=VLRDCLAK_test",
      "/api/feed/playlists",
    ];
    for (const route of routes) {
      const res = await call("GET", route);
      expect(res.status, route).toBe(401);
    }
  });

  it("serves normalized home shelves", async () => {
    const calls = stubUpstream(HOME_FIXTURE);
    const res = await call("GET", "/api/feed/home", harness.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sections: Array<{ title: string; items: unknown[] }> };
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0].items).toHaveLength(2);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/youtubei/v1/browse");
    expect(calls[0].body).toMatchObject({
      browseId: "FEmusic_home",
      context: { client: { clientName: "WEB_REMIX", hl: "en", gl: "US" } },
    });
  });

  it("forwards a custom locale to InnerTube", async () => {
    const calls = stubUpstream(HOME_FIXTURE);
    const res = await call("GET", "/api/feed/home?hl=de&gl=DE", harness.cookie);
    expect(res.status).toBe(200);
    expect(calls[0].body.context).toMatchObject({ client: { hl: "de", gl: "DE" } });
  });

  it("validates hl/gl", async () => {
    stubUpstream(HOME_FIXTURE);
    const res = await call("GET", "/api/feed/home?hl=ENGLISH", harness.cookie);
    expect(res.status).toBe(400);
  });

  it("requires and validates videoId for watch-next", async () => {
    stubUpstream(NEXT_FIXTURE);
    expect((await call("GET", "/api/feed/next", harness.cookie)).status).toBe(400);
    expect(
      (await call("GET", "/api/feed/next?videoId=not%20a%20video", harness.cookie)).status,
    ).toBe(400);
  });

  it("serves watch-next without the seed entry", async () => {
    const calls = stubUpstream(NEXT_FIXTURE);
    const res = await call("GET", "/api/feed/next?videoId=seedVideo01", harness.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ videoId: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].videoId).toBe("dQw4w9WgXcQ");
    expect(calls[0].url).toContain("/youtubei/v1/next");
    expect(calls[0].body).toMatchObject({ videoId: "seedVideo01" });
  });

  it("follows the automix pointer when the first panel holds only the seed", async () => {
    // First response: seed entry + automix pointer, nothing else.
    const seedOnlyPanel = {
      contents: {
        singleColumnMusicWatchNextResultsRenderer: {
          tabbedRenderer: {
            watchNextTabbedResultsRenderer: {
              tabs: [
                {
                  tabRenderer: {
                    content: {
                      musicQueueRenderer: {
                        content: {
                          playlistPanelRenderer: {
                            contents: [
                              {
                                playlistPanelVideoRenderer: {
                                  videoId: "seedVideo01",
                                  title: { runs: [{ text: "Seed Song" }] },
                                },
                              },
                              {
                                automixPreviewVideoRenderer: {
                                  content: {
                                    automixPlaylistVideoRenderer: {
                                      navigationEndpoint: {
                                        watchPlaylistEndpoint: {
                                          playlistId: "RDAMVMseedVideo01",
                                          params: "wAEB8gECeAHq%3D%3D",
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            ],
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    };
    const calls = stubUpstream([seedOnlyPanel, NEXT_FIXTURE]);
    const res = await call("GET", "/api/feed/next?videoId=seedVideo01", harness.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ videoId: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].videoId).toBe("dQw4w9WgXcQ");

    // Second call re-requests with the automix playlistId + params.
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toMatchObject({
      videoId: "seedVideo01",
      playlistId: "RDAMVMseedVideo01",
      params: "wAEB8gECeAHq%3D%3D",
    });
  });

  it("validates browseId and params for playlist detail", async () => {
    stubUpstream(PLAYLIST_FIXTURE);
    expect((await call("GET", "/api/feed/playlist", harness.cookie)).status).toBe(400);
    expect(
      (await call("GET", "/api/feed/playlist?browseId=bad%20id", harness.cookie)).status,
    ).toBe(400);
    expect(
      (
        await call(
          "GET",
          "/api/feed/playlist?browseId=VLRD_ok&params=%3Cscript%3E",
          harness.cookie,
        )
      ).status,
    ).toBe(400);
  });

  it("serves playlist header with thumbnail and tracks", async () => {
    stubUpstream(PLAYLIST_FIXTURE);
    const res = await call(
      "GET",
      "/api/feed/playlist?browseId=VLRDCLAK_test&params=ggMEgALjBA%3D%3D",
      harness.cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      playlist: { title: string; artworkUrl: string; tracks: unknown[] };
    };
    expect(body.playlist.title).toBe("Country Hotlist");
    expect(body.playlist.artworkUrl).toBe("https://yt3/cover.jpg");
    expect(body.playlist.tracks).toHaveLength(2);
  });

  it("maps an unknown playlist to 404", async () => {
    stubUpstream({ contents: {} });
    const res = await call("GET", "/api/feed/playlist?browseId=VLRD_missing", harness.cookie);
    expect(res.status).toBe(404);
  });

  it("maps upstream failure to 502 without leaking details", async () => {
    stubUpstream(null, { status: 503, body: "upstream exploded: secret detail" });
    const res = await call("GET", "/api/feed/home", harness.cookie);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("YouTube Music is unavailable right now.");
    expect(JSON.stringify(body)).not.toContain("secret detail");
  });

  it("maps a non-JSON upstream body to 502", async () => {
    stubUpstream(null, { body: "<html>consent</html>" });
    const res = await call("GET", "/api/feed/home", harness.cookie);
    expect(res.status).toBe(502);
  });
});

describe("GET /api/feed/playlists", () => {
  it("returns the account's playlists with tracks inline", async () => {
    replaceLibrarySnapshot(harness.db, currentUserId(), {
      playlists: [
        {
          name: "Road trip",
          artworkUrl: "https://img/cover.jpg",
          tracks: [
            { id: "vid00000001", title: "Liar", artist: "Camila Cabello", durationSec: 198 },
            { id: "vid00000002", title: "Crown", artist: "Camila Cabello" },
          ],
        },
      ],
      likedSongs: [],
    });

    const res = await call("GET", "/api/feed/playlists", harness.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      playlists: Array<{ name: string; artworkUrl: string | null; tracks: unknown[] }>;
      counts: { playlists: number };
    };
    expect(body.counts.playlists).toBe(1);
    expect(body.playlists[0]).toMatchObject({ name: "Road trip", artworkUrl: "https://img/cover.jpg" });
    expect(body.playlists[0].tracks).toHaveLength(2);
  });

  it("needs a session", async () => {
    const res = await call("GET", "/api/feed/playlists");
    expect(res.status).toBe(401);
  });
});

function currentUserId(): string {
  const row = harness.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
  return row.id;
}
