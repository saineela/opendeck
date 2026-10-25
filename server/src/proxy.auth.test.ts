import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardProxyRequest } from "./services/proxy.js";
import type { Db } from "./db.js";
import type { ServerConfig } from "./config.js";

/**
 * InnerTube refuses account-scoped calls (library browse, liked songs,
 * history) with a bare `Authorization: Bearer` — it also requires
 * `X-Goog-AuthUser`, mirroring the SAPISID cookie flow. The library broke
 * without it ("You must be signed in to perform this operation"), so this
 * locks the header injection in place.
 */

vi.mock("./services/youtubeAccount.js", () => ({
  getValidAccessToken: vi.fn(async () => "test-access-token"),
}));

// The real loader needs a database; these tests only exercise Bearer injection,
// so keep cookie auth out of the picture (cookie auth has its own suite).
vi.mock("./services/youtubeCookies.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./services/youtubeCookies.js")>();
  return { ...actual, loadYouTubeCookies: vi.fn(() => null) };
});

const { getValidAccessToken } = await import("./services/youtubeAccount.js");

const db = {} as Db;
const config = {} as ServerConfig;

let captured: Array<{ url: string; headers: Record<string, string> }> = [];

function stubGlobalFetch(): void {
  captured = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    captured.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

beforeEach(() => {
  stubGlobalFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("proxy bearer injection", () => {
  it("sends Bearer + X-Goog-AuthUser on InnerTube endpoints when linked", async () => {
    const result = await forwardProxyRequest(
      db,
      config,
      {
        url: "https://music.youtube.com/youtubei/v1/browse?prettyPrint=false",
        method: "POST",
        headers: { "content-type": "application/json" },
        body_base64: Buffer.from("{}").toString("base64"),
      },
      "user-1",
    );

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const headers = captured[0]!.headers;
    expect(headers.authorization).toBe("Bearer test-access-token");
    expect(headers["x-goog-authuser"]).toBe("0");
    expect(getValidAccessToken).toHaveBeenCalledWith(db, config, "user-1");
  });

  it("sends no credentials to non-YouTube hosts even when linked", async () => {
    const result = await forwardProxyRequest(
      db,
      config,
      { url: "https://lrclib.net/api/search?track=x", method: "GET", headers: {} },
      "user-1",
    );

    expect(result.ok).toBe(true);
    const headers = captured[0]!.headers;
    expect(headers.authorization).toBeUndefined();
    expect(headers["x-goog-authuser"]).toBeUndefined();
  });

  it("sends no bearer when the user has no linked account", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValueOnce(null);

    const result = await forwardProxyRequest(
      db,
      config,
      {
        url: "https://www.youtube.com/youtubei/v1/player",
        method: "POST",
        headers: {},
        body_base64: Buffer.from("{}").toString("base64"),
      },
      "user-1",
    );

    expect(result.ok).toBe(true);
    const headers = captured[0]!.headers;
    expect(headers.authorization).toBeUndefined();
    expect(headers["x-goog-authuser"]).toBeUndefined();
  });

  it("keeps the bearer off redirects to other allowlisted hosts", async () => {
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      call += 1;
      captured.push({
        url: typeof input === "string" ? input : input.toString(),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      if (call === 1) {
        return new Response(null, { status: 307, headers: { location: "https://i.ytimg.com/img.jpg" } });
      }
      return new Response("ok", { status: 200 });
    });

    const result = await forwardProxyRequest(
      db,
      config,
      { url: "https://www.youtube.com/youtubei/v1/player", method: "POST", headers: {} },
      "user-1",
    );

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.headers.authorization).toBe("Bearer test-access-token");
    expect(captured[1]!.headers.authorization).toBeUndefined();
  });
});
