import { afterEach, describe, expect, it, vi } from "vitest";
import { DataSource } from "../datasource/DataSource";
import type { LibrarySnapshot, Track } from "../datasource/types";
import { LibraryController } from "./LibraryController";

const library: LibrarySnapshot = {
  account: { name: "YouTube Music" },
  albums: [],
  playlists: [],
  likedSongsPlaylist: { id: "LM", title: "Liked Songs", owner: "YouTube Music", kind: "liked-songs" },
  likedSongs: [],
  recentlyPlayed: [],
};

class ReturningUserSource extends DataSource {
  constructor(
    private readonly libraryResult: () => Promise<LibrarySnapshot> = async () => library,
    private readonly cachedLibrary: LibrarySnapshot | null = null,
  ) {
    super();
  }

  async getTrack(): Promise<Track> {
    throw new Error("not used");
  }

  async getStreamUrl(): Promise<string> {
    throw new Error("not used");
  }

  override async restoreSession(): Promise<boolean> {
    return true;
  }

  override async getLibrary(): Promise<LibrarySnapshot> {
    return this.libraryResult();
  }

  override async getCachedLibrary(): Promise<LibrarySnapshot | null> {
    return this.cachedLibrary;
  }
}

describe("LibraryController session restoration", () => {
  afterEach(() => vi.unstubAllGlobals());

  const runWithWindow = async (run: () => Promise<void>) => {
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
    });
    await run();
  };

  it("keeps a returning linked user ready after restoring the session and library", async () => {
    await runWithWindow(async () => {
      const controller = new LibraryController(new ReturningUserSource());

      await controller.initialize();

      expect(controller.getState().status).toBe("ready");
      expect(controller.getState().library).toEqual(library);
    });
  });

  it("does not label a restored account signed out when library sync fails", async () => {
    await runWithWindow(async () => {
      const controller = new LibraryController(new ReturningUserSource(async () => {
        throw new Error("temporary library request failure");
      }, library));

      await controller.initialize();

      expect(controller.getState().status).toBe("error");
      expect(controller.getState().status).not.toBe("signed-out");
      expect(controller.getState().error).toContain("temporary library request failure");
    });
  });
});
