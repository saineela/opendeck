import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, setServerKv, type Db } from "../db.js";
import {
  DEFAULT_IMAGE_CACHE_MAX_BYTES,
  IMAGE_CACHE_MAX_BYTES_KEY,
  MIN_IMAGE_CACHE_MAX_BYTES,
  artworkIdentity,
  clearImageCache,
  enforceImageCacheLimit,
  getImageCacheMaxBytes,
  getImageCacheStats,
  hasCachedImage,
  hashImageUrl,
  listCachedImages,
  readCachedImage,
  setImageCacheMaxBytes,
  storeCachedImage,
} from "./imageCache.js";

/**
 * The image cache invariants: bytes round-trip untouched, the budget is
 * enforced with least-valuable-first eviction (played least, then requested
 * least, then seen least), and the admin reset really empties the table.
 */

let db: Db;

function jpeg(bytes: number): Uint8Array {
  return Uint8Array.from({ length: bytes }, (_unused, index) => index % 251);
}

/** Budget small enough to exercise eviction without megabytes of fixtures. */
function setRawBudget(bytes: number): void {
  setServerKv(db, IMAGE_CACHE_MAX_BYTES_KEY, String(bytes));
}

const A = "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg";
const B = "https://i.ytimg.com/vi/bbbbbbbbbbb/hqdefault.jpg";
const C = "https://i.ytimg.com/vi/ccccccccccc/hqdefault.jpg";

function seedUser(): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, auth_provider, google_sub, name, email, picture, password_hash,
                        totp_secret, totp_enabled, totp_backup_codes, failed_logins, locked_until,
                        role, created_at, last_login_at)
     VALUES (?, 'password', NULL, 'Listener', NULL, NULL, NULL, NULL, 0, '[]', 0, NULL, 'user', ?, ?)`,
  ).run(id, now, now);
  return id;
}

function play(userId: string, artworkUrl: string, playedAt: number): void {
  db.prepare(
    `INSERT INTO play_history (id, user_id, video_id, title, artist, album, artwork_url,
                               duration_seconds, source, api_key_id, played_at)
     VALUES (?, ?, ?, 'Song', 'Artist', NULL, ?, NULL, 'app', NULL, ?)`,
  ).run(crypto.randomUUID(), userId, crypto.randomUUID(), artworkUrl, playedAt);
}

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("artworkIdentity", () => {
  it("collapses every ytimg size variant of one video", () => {
    const a = artworkIdentity("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    const b = artworkIdentity("https://i.ytimg.com/vi/dQw4w9WgXcQ/w540-h540.jpg");
    const other = artworkIdentity("https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg");
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  it("collapses Google channel-art size suffixes", () => {
    const wide = artworkIdentity("https://yt3.googleusercontent.com/AAAA=w544-h544-l90-rj");
    const small = artworkIdentity("https://yt3.googleusercontent.com/AAAA=w120-h120-l90-rj");
    const plain = artworkIdentity("https://yt3.googleusercontent.com/AAAA");
    expect(wide).toBe(small);
    expect(wide).toBe(plain);
  });

  it("keeps unrelated URLs distinct", () => {
    expect(artworkIdentity("https://example.com/a.jpg")).not.toBe(
      artworkIdentity("https://example.com/b.jpg"),
    );
    expect(artworkIdentity("")).toBe("");
  });
});

describe("store / read", () => {
  it("round-trips bytes, content type and size", () => {
    const url = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg";
    const payload = jpeg(64);
    expect(storeCachedImage(db, url, "image/jpeg", payload)).toEqual({ stored: true });

    const cached = readCachedImage(db, url);
    expect(cached).not.toBeNull();
    expect(cached!.contentType).toBe("image/jpeg");
    expect(cached!.bytes).toBe(64);
    expect(Array.from(cached!.data)).toEqual(Array.from(payload));
    expect(cached!.hash).toBe(hashImageUrl(url));
    expect(hasCachedImage(db, url)).toBe(true);
    expect(hasCachedImage(db, "https://i.ytimg.com/vi/zzzzzzzzzzz/hqdefault.jpg")).toBe(false);
  });

  it("reports a miss rather than throwing", () => {
    expect(readCachedImage(db, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")).toBeNull();
  });

  it("refuses oversized pictures instead of evicting the cache for them", () => {
    const url = "https://i.ytimg.com/vi/dQw4w9WgXcQ/huge.jpg";
    const result = storeCachedImage(db, url, "image/jpeg", jpeg(9 * 1024 * 1024));
    expect(result).toEqual({ stored: false, reason: "too_large" });
    expect(hasCachedImage(db, url)).toBe(false);
  });

  it("overwrites an existing entry but keeps its hit count", () => {
    const url = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg";
    storeCachedImage(db, url, "image/jpeg", jpeg(32));
    db.prepare("UPDATE image_cache SET hit_count = 7 WHERE hash = ?").run(hashImageUrl(url));
    storeCachedImage(db, url, "image/webp", jpeg(48));

    const cached = readCachedImage(db, url);
    expect(cached!.contentType).toBe("image/webp");
    expect(cached!.bytes).toBe(48);
    // The throttled read must not have rewritten it within the interval.
    expect(cached!.hitCount).toBe(7);
    expect(getImageCacheStats(db).entryCount).toBe(1);
  });
});

describe("budget", () => {
  it("defaults to 512 MiB and clamps the setter", () => {
    expect(getImageCacheMaxBytes(db)).toBe(DEFAULT_IMAGE_CACHE_MAX_BYTES);
    setImageCacheMaxBytes(db, 1);
    expect(getImageCacheMaxBytes(db)).toBe(MIN_IMAGE_CACHE_MAX_BYTES);
    expect(() => setImageCacheMaxBytes(db, Number.NaN)).toThrow(/positive number/);
  });

  it("reports usage as a fraction of the budget", () => {
    setRawBudget(1000);
    storeCachedImage(db, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", "image/jpeg", jpeg(250));
    const stats = getImageCacheStats(db);
    expect(stats.usedBytes).toBe(250);
    expect(stats.entryCount).toBe(1);
    expect(stats.maxBytes).toBe(1000);
    expect(stats.usageRatio).toBeCloseTo(0.25);
  });
});

describe("eviction", () => {
  it("is a no-op while the cache fits", () => {
    setRawBudget(10_000);
    storeCachedImage(db, A, "image/jpeg", jpeg(1000));
    expect(enforceImageCacheLimit(db)).toEqual({ evicted: 0, freedBytes: 0 });
    expect(getImageCacheStats(db).entryCount).toBe(1);
  });

  it("throws away the least-played artwork first, even when it was seen most recently", () => {
    setRawBudget(10_000);
    storeCachedImage(db, A, "image/jpeg", jpeg(1000));
    storeCachedImage(db, B, "image/jpeg", jpeg(1000));
    storeCachedImage(db, C, "image/jpeg", jpeg(1000));

    // B is the most played; A is the most recently used of the two unplayed.
    const userId = seedUser();
    for (let index = 0; index < 3; index += 1) play(userId, B, Date.now() - index);
    db.prepare("UPDATE image_cache SET last_used = ? WHERE hash = ?").run(9_000_000, hashImageUrl(C));
    db.prepare("UPDATE image_cache SET last_used = ? WHERE hash = ?").run(1_000_000, hashImageUrl(A));
    db.prepare("UPDATE image_cache SET last_used = ? WHERE hash = ?").run(2_000_000, hashImageUrl(B));

    // Budget for two of the three, trimmed to 90% so the third goes too.
    setRawBudget(2000);
    const result = enforceImageCacheLimit(db);

    expect(result.evicted).toBe(2);
    expect(result.freedBytes).toBe(2000);
    // Only the popular one survives, despite being the least recently used.
    expect(hasCachedImage(db, B)).toBe(true);
    expect(hasCachedImage(db, A)).toBe(false);
    expect(hasCachedImage(db, C)).toBe(false);
    expect(getImageCacheStats(db).usedBytes).toBeLessThanOrEqual(2000);
  });

  it("ranks by request count when nobody has played the track", () => {
    setRawBudget(10_000);
    storeCachedImage(db, A, "image/jpeg", jpeg(1000));
    storeCachedImage(db, B, "image/jpeg", jpeg(1000));
    // Make A the busier asset by serving it twice.
    readCachedImage(db, A);
    db.prepare("UPDATE image_cache SET hit_count = 5, last_used = 1 WHERE hash = ?").run(
      hashImageUrl(A),
    );
    db.prepare("UPDATE image_cache SET hit_count = 1, last_used = 9 WHERE hash = ?").run(
      hashImageUrl(B),
    );

    setRawBudget(1500);
    enforceImageCacheLimit(db);

    expect(hasCachedImage(db, A)).toBe(true);
    expect(hasCachedImage(db, B)).toBe(false);
  });

  it("enforces a lowered budget the moment it is set", () => {
    setRawBudget(1_000_000);
    storeCachedImage(db, A, "image/jpeg", jpeg(1000));
    storeCachedImage(db, B, "image/jpeg", jpeg(1000));
    setImageCacheMaxBytes(db, MIN_IMAGE_CACHE_MAX_BYTES);
    expect(getImageCacheStats(db).usedBytes).toBeLessThanOrEqual(
      Math.floor(MIN_IMAGE_CACHE_MAX_BYTES * 0.9),
    );
  });
});

describe("admin operations", () => {
  it("lists the biggest occupants with their play counts", () => {
    setRawBudget(1_000_000);
    storeCachedImage(db, A, "image/jpeg", jpeg(400));
    storeCachedImage(db, B, "image/jpeg", jpeg(200));
    const userId = seedUser();
    play(userId, A, Date.now());

    const images = listCachedImages(db, 10);
    expect(images).toHaveLength(2);
    expect(images[0]!.url).toBe(A);
    expect(images[0]!.bytes).toBe(400);
    expect(images[0]!.playCount).toBe(1);
    expect(images[1]!.playCount).toBe(0);
  });

  it("formats back to empty", () => {
    setRawBudget(1_000_000);
    storeCachedImage(db, A, "image/jpeg", jpeg(400));
    const stats = clearImageCache(db);
    expect(stats).toMatchObject({ usedBytes: 0, entryCount: 0 });
    expect(hasCachedImage(db, A)).toBe(false);
  });
});
