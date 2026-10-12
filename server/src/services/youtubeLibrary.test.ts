import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { saveYouTubeTokens } from "./youtubeAccount.js";
import { getYouTubeLibrary, __testing } from "./youtubeLibrary.js";

describe("YouTube TV library continuation paging", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads continuationCommand, nextContinuationData, and reloadContinuationData tokens", () => {
    expect(__testing.readContinuation({
      continuationContents: {
        musicPlaylistShelfContinuation: {
          continuations: [{ nextContinuationData: { continuation: "next-token" } }],
        },
      },
    })).toBe("next-token");
    expect(__testing.readContinuation({
      continuationContents: {
        musicPlaylistShelfContinuation: {
          continuations: [{ reloadContinuationData: { continuation: "reload-token" } }],
        },
      },
    })).toBe("reload-token");
    expect(__testing.readContinuation({
      continuationContents: {
        musicPlaylistShelfContinuation: {
          continuations: [{ continuationCommand: { token: "command-token" } }],
        },
      },
    })).toBe("command-token");
  });

  it("normalizes all liked songs across multiple continuation pages", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-library-test-"));
    const db = openDatabase(":memory:");
    try {
      const config = loadConfig({
        NODE_ENV: "test",
        APP_SECRET: "youtube-library-test-secret-0123456789abcdef",
        DATA_DIR: dataDir,
      });
      db.prepare(
        "INSERT INTO users (id, name, created_at, last_login_at) VALUES (?, ?, ?, ?)",
      ).run("library-user", "Library User", Date.now(), Date.now());
      saveYouTubeTokens(db, config, "library-user", {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expiry_date: new Date(Date.now() + 60 * 60_000).toISOString(),
      });

      const continuations: string[] = [];
      const makePage = (start: number, count: number, next?: string) => ({
        contents: Array.from({ length: count }, (_, offset) => {
          const index = start + offset;
          return {
            tileRenderer: {
              tileMetadataRenderer: { title: { simpleText: `Track ${index}` } },
              navigationEndpoint: { watchEndpoint: { videoId: `video-${index}` } },
            },
          };
        }),
        ...(next ? {
          continuationContents: {
            musicPlaylistShelfContinuation: {
              continuations: [{ nextContinuationData: { continuation: next } }],
            },
          },
        } : {}),
      });
      const pages: Record<string, ReturnType<typeof makePage>> = {
        first: makePage(0, 15, "page-2"),
        "page-2": makePage(15, 15, "page-3"),
        "page-3": makePage(30, 4),
      };
      vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (!String(input).includes("youtubei/v1/browse")) {
          return new Response("not found", { status: 404 });
        }
        const request = JSON.parse(String(init?.body)) as { browseId?: string; continuation?: string };
        if (request.continuation) continuations.push(request.continuation);
        const result = request.browseId === "VLLM"
          ? pages.first
          : request.continuation
            ? pages[request.continuation]
            : {};
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const library = await getYouTubeLibrary(db, config, "library-user");

      expect(library?.likedSongs).toHaveLength(34);
      expect(library?.likedSongs.map((track) => track.id)).toEqual(
        Array.from({ length: 34 }, (_, index) => `video-${index}`),
      );
      expect(continuations).toEqual(["page-2", "page-3"]);
    } finally {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("follows pages beyond the prior 8-page cutoff without looping tokens", async () => {
    const requests: Array<{ browseId?: string; continuation?: string }> = [];
    const browse = async (_token: string, args: { browseId?: string; continuation?: string }) => {
      requests.push(args);
      const pageIndex = args.continuation ? Number(args.continuation.slice(5)) : 1;
      return {
        continuationContents: {
          musicPlaylistShelfContinuation: {
            continuations: [{ nextContinuationData: { continuation: `page-${pageIndex + 1}` } }],
          },
        },
      };
    };

    const pages = await __testing.tvBrowseAll("access", "VLLM", browse, 12);

    expect(pages).toHaveLength(12);
    expect(requests).toHaveLength(12);
    expect(requests[8]).toEqual({ continuation: "page-9" });
  });

  it("stops when YouTube repeats a continuation token", async () => {
    const requests: Array<{ browseId?: string; continuation?: string }> = [];
    const page = {
      continuationContents: {
        musicPlaylistShelfContinuation: {
          continuations: [{ nextContinuationData: { continuation: "same-token" } }],
        },
      },
    };
    const browse = async (_token: string, args: { browseId?: string; continuation?: string }) => {
      requests.push(args);
      return page;
    };

    const pages = await __testing.tvBrowseAll("access", "VLLM", browse);

    expect(pages).toHaveLength(2);
    expect(requests).toHaveLength(2);
  });
});
