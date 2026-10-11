import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase, type Db } from "./db.js";
import { SESSION_COOKIE, createSession } from "./middleware/session.js";

/**
 * Per-user library API.
 *
 * The property under test above all others: two accounts on one server never
 * see each other's playlists or likes. Every case that matters is a pair —
 * one user writes, the other reads.
 */

interface Harness {
  db: Db;
  base: string;
  close: () => Promise<void>;
  cookieA: string;
  cookieB: string;
}

let harness: Harness;

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "library-test-secret-0123456789abcdef",
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "od-lib-")),
  });
  const db = openDatabase(":memory:");
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO users (id, auth_provider, google_sub, name, email, picture, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  insert.run(userA, "password", null, "Alice", "alice@example.com", now, now);
  insert.run(userB, "password", null, "Bob", "bob@example.com", now, now);

  const server = http.createServer(createApp(config, db));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  harness = {
    db,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      await once(server, "close");
      db.close();
    },
    cookieA: `${SESSION_COOKIE}=${createSession(db, userA)}`,
    cookieB: `${SESSION_COOKIE}=${createSession(db, userB)}`,
  };
});

afterEach(async () => {
  await harness.close();
});

function call(
  method: string,
  pathname: string,
  options: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.cookie) headers.cookie = options.cookie;
  // fetch refuses a body on GET/HEAD, so the auth-probe loop passes {} for
  // every verb and this drops it where it cannot be sent.
  const allowsBody = method !== "GET" && method !== "HEAD";
  if (options.body !== undefined && allowsBody) headers["content-type"] = "application/json";
  return fetch(`${harness.base}${pathname}`, {
    method,
    headers,
    body: options.body === undefined || !allowsBody ? undefined : JSON.stringify(options.body),
  });
}

const SAMPLE_TRACKS = [
  { id: "t1", title: "First", artist: "Alpha", durationSec: 180, artworkUrl: "https://img/1.jpg" },
  { id: "t2", title: "Second", artist: "Beta", album: "Debut" },
  { id: "t3", title: "Third", artist: "Gamma" },
];

describe("library access control", () => {
  it("rejects every route without a session", async () => {
    const routes: Array<[string, string]> = [
      ["GET", "/api/library"],
      ["POST", "/api/library/sync"],
      ["GET", "/api/library/playlists"],
      ["POST", "/api/library/playlists"],
      ["GET", "/api/library/playlists/pl-x"],
      ["PATCH", "/api/library/playlists/pl-x"],
      ["DELETE", "/api/library/playlists/pl-x"],
      ["POST", "/api/library/playlists/pl-x/tracks"],
      ["DELETE", "/api/library/playlists/pl-x/tracks/t1"],
      ["POST", "/api/library/playlists/pl-x/reorder"],
      ["GET", "/api/library/likes"],
      ["PUT", "/api/library/likes/t1"],
      ["DELETE", "/api/library/likes/t1"],
    ];
    for (const [method, pathname] of routes) {
      const res = await call(method, pathname, { body: {} });
      expect(res.status, `${method} ${pathname}`).toBe(401);
    }
  });

  it("rejects a cross-site write (CSRF origin check)", async () => {
    const res = await call("POST", "/api/library/playlists", {
      body: { name: "Smuggled" },
      cookie: harness.cookieA,
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("Cross-site");
  });
});

describe("playlist CRUD", () => {
  it("creates, lists, reads, renames, and deletes", async () => {
    const created = await call("POST", "/api/library/playlists", {
      body: { name: "Road Trip", description: "Windows down" },
      cookie: harness.cookieA,
    });
    expect(created.status).toBe(201);
    const { playlist } = (await created.json()) as { playlist: { id: string; name: string; trackCount: number } };
    expect(playlist).toMatchObject({ name: "Road Trip", trackCount: 0 });
    expect(playlist.id).toMatch(/^pl-/);

    const list = await call("GET", "/api/library/playlists", { cookie: harness.cookieA });
    const listed = (await list.json()) as { playlists: Array<{ id: string; name: string }> };
    expect(listed.playlists).toHaveLength(1);
    expect(listed.playlists[0]!.name).toBe("Road Trip");

    const renamed = await call("PATCH", `/api/library/playlists/${playlist.id}`, {
      body: { name: "Road Trip 2026" },
      cookie: harness.cookieA,
    });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { playlist: { name: string } }).playlist.name).toBe("Road Trip 2026");

    const removed = await call("DELETE", `/api/library/playlists/${playlist.id}`, { cookie: harness.cookieA });
    expect(removed.status).toBe(200);

    const afterDelete = await call("GET", "/api/library/playlists", { cookie: harness.cookieA });
    expect(((await afterDelete.json()) as { playlists: unknown[] }).playlists).toHaveLength(0);
  });

  it("validates names and unknown ids", async () => {
    const empty = await call("POST", "/api/library/playlists", { body: { name: "   " }, cookie: harness.cookieA });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toContain("playlist name");

    const missing = await call("GET", "/api/library/playlists/pl-does-not-exist", { cookie: harness.cookieA });
    expect(missing.status).toBe(404);
  });

  it("manages ordered tracks with dedupe, removal, and reorder", async () => {
    const created = await call("POST", "/api/library/playlists", {
      body: { name: "Mix" },
      cookie: harness.cookieA,
    });
    const { playlist } = (await created.json()) as { playlist: { id: string } };

    const added = await call("POST", `/api/library/playlists/${playlist.id}/tracks`, {
      body: { tracks: SAMPLE_TRACKS },
      cookie: harness.cookieA,
    });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ added: 3, replaced: 0, trackCount: 3 });

    // Re-adding refreshes metadata in place rather than duplicating.
    const readded = await call("POST", `/api/library/playlists/${playlist.id}/tracks`, {
      body: { tracks: [{ id: "t1", title: "First (Remastered)", artist: "Alpha" }] },
      cookie: harness.cookieA,
    });
    expect(await readded.json()).toMatchObject({ added: 0, replaced: 1, trackCount: 3 });

    const detail = await call("GET", `/api/library/playlists/${playlist.id}`, { cookie: harness.cookieA });
    const payload = (await detail.json()) as { tracks: Array<{ id: string; title: string; position: number }> };
    expect(payload.tracks.map((track) => track.id)).toEqual(["t1", "t2", "t3"]);
    expect(payload.tracks[0]!.title).toBe("First (Remastered)");
    expect(payload.tracks.map((track) => track.position)).toEqual([0, 1, 2]);

    // Reorder: the client sends the new head of the list; the rest follows.
    const reordered = await call("POST", `/api/library/playlists/${playlist.id}/reorder`, {
      body: { trackIds: ["t3", "t1"] },
      cookie: harness.cookieA,
    });
    expect(reordered.status).toBe(200);
    const afterReorder = await call("GET", `/api/library/playlists/${playlist.id}`, { cookie: harness.cookieA });
    const ordered = ((await afterReorder.json()) as { tracks: Array<{ id: string }> }).tracks.map((t) => t.id);
    expect(ordered).toEqual(["t3", "t1", "t2"]);

    // Reordering with a foreign id fails without mutating anything.
    const badReorder = await call("POST", `/api/library/playlists/${playlist.id}/reorder`, {
      body: { trackIds: ["nope"] },
      cookie: harness.cookieA,
    });
    expect(badReorder.status).toBe(400);

    const removed = await call("DELETE", `/api/library/playlists/${playlist.id}/tracks/t2`, {
      cookie: harness.cookieA,
    });
    expect(await removed.json()).toEqual({ ok: true });
    const missing = await call("DELETE", `/api/library/playlists/${playlist.id}/tracks/t2`, {
      cookie: harness.cookieA,
    });
    expect(await missing.json()).toEqual({ ok: false });

    const missingTitle = await call("POST", `/api/library/playlists/${playlist.id}/tracks`, {
      body: { tracks: [{ id: "t9" }] },
      cookie: harness.cookieA,
    });
    expect(missingTitle.status).toBe(400);
  });
});

describe("multi-user isolation", () => {
  it("keeps one account's playlists and likes invisible to another", async () => {
    // Alice builds a library.
    const created = await call("POST", "/api/library/playlists", {
      body: { name: "Alice's Mix" },
      cookie: harness.cookieA,
    });
    const { playlist } = (await created.json()) as { playlist: { id: string } };
    await call("POST", `/api/library/playlists/${playlist.id}/tracks`, {
      body: { tracks: SAMPLE_TRACKS },
      cookie: harness.cookieA,
    });
    const liked = await call("PUT", "/api/library/likes/t1", {
      body: SAMPLE_TRACKS[0],
      cookie: harness.cookieA,
    });
    expect(await liked.json()).toMatchObject({ liked: true, total: 1 });

    // Bob's view is empty.
    const bobPlaylists = await call("GET", "/api/library/playlists", { cookie: harness.cookieB });
    expect(((await bobPlaylists.json()) as { playlists: unknown[] }).playlists).toHaveLength(0);

    const bobSnapshot = await call("GET", "/api/library", { cookie: harness.cookieB });
    expect(await bobSnapshot.json()).toMatchObject({ playlists: [], likedSongs: [] });

    // Bob cannot reach Alice's playlist by id, in any direction.
    for (const [method, pathname, body] of [
      ["GET", `/api/library/playlists/${playlist.id}`, undefined],
      ["PATCH", `/api/library/playlists/${playlist.id}`, { name: "Hijacked" }],
      ["DELETE", `/api/library/playlists/${playlist.id}`, undefined],
      ["POST", `/api/library/playlists/${playlist.id}/tracks`, { tracks: [{ id: "x", title: "Intruder" }] }],
      ["POST", `/api/library/playlists/${playlist.id}/reorder`, { trackIds: ["t1"] }],
    ] as Array<[string, string, unknown]>) {
      const res = await call(method, pathname, { body, cookie: harness.cookieB });
      expect(res.status, `${method} ${pathname}`).toBe(404);
    }

    // Bob deleting a like id he knows leaves Alice's intact.
    await call("DELETE", "/api/library/likes/t1", { cookie: harness.cookieB });
    const aliceLikes = await call("GET", "/api/library/likes", { cookie: harness.cookieA });
    expect(((await aliceLikes.json()) as { likedSongs: unknown[] }).likedSongs).toHaveLength(1);

    // ...and Alice's playlist still holds all three tracks.
    const aliceDetail = await call("GET", `/api/library/playlists/${playlist.id}`, { cookie: harness.cookieA });
    expect(((await aliceDetail.json()) as { tracks: unknown[] }).tracks).toHaveLength(3);
  });

  it("syncs each account's snapshot independently", async () => {
    const aliceSnapshot = {
      playlists: [{ id: "pl-alice", name: "Alice", tracks: SAMPLE_TRACKS }],
      likedSongs: [SAMPLE_TRACKS[0]!],
    };
    const bobSnapshot = {
      playlists: [{ id: "pl-bob", name: "Bob", tracks: [SAMPLE_TRACKS[1]!] }],
      likedSongs: [SAMPLE_TRACKS[1]!, SAMPLE_TRACKS[2]!],
    };

    const alicePush = await call("POST", "/api/library/sync", {
      body: { snapshot: aliceSnapshot },
      cookie: harness.cookieA,
    });
    expect(alicePush.status).toBe(200);
    expect(await alicePush.json()).toEqual({ playlists: 1, likedSongs: 1, tracks: 3 });

    const bobPush = await call("POST", "/api/library/sync", {
      body: { snapshot: bobSnapshot },
      cookie: harness.cookieB,
    });
    expect(await bobPush.json()).toEqual({ playlists: 1, likedSongs: 2, tracks: 1 });

    // Bob's push did not touch Alice's rows.
    const aliceNow = await call("GET", "/api/library", { cookie: harness.cookieA });
    expect(await aliceNow.json()).toMatchObject({
      playlists: [{ id: "pl-alice", name: "Alice" }],
      likedSongs: [{ id: "t1" }],
      counts: { playlists: 1, likedSongs: 1 },
    });

    // A second push from Alice replaces hers, including deletions.
    const second = await call("POST", "/api/library/sync", {
      body: { snapshot: { playlists: [], likedSongs: [] } },
      cookie: harness.cookieA,
    });
    expect(await second.json()).toEqual({ playlists: 0, likedSongs: 0, tracks: 0 });
    const emptied = await call("GET", "/api/library", { cookie: harness.cookieA });
    expect(await emptied.json()).toMatchObject({ playlists: [], likedSongs: [] });

    const bobUntouched = await call("GET", "/api/library", { cookie: harness.cookieB });
    expect(await bobUntouched.json()).toMatchObject({
      likedSongs: [{ id: "t2" }, { id: "t3" }],
      counts: { playlists: 1, likedSongs: 2 },
    });
  });

  it("rejects a malformed snapshot without applying a partial write", async () => {
    const before = await call("GET", "/api/library", { cookie: harness.cookieA });
    const beforePayload = (await before.json()) as { playlists: unknown[] };

    const res = await call("POST", "/api/library/sync", {
      body: { snapshot: { playlists: [{ name: "Valid" }, { name: "Bad", tracks: [{ id: "no-title" }] }] } },
      cookie: harness.cookieA,
    });
    expect(res.status).toBe(400);

    const after = await call("GET", "/api/library", { cookie: harness.cookieA });
    expect(((await after.json()) as { playlists: unknown[] }).playlists).toHaveLength(
      beforePayload.playlists.length,
    );
  });
});
