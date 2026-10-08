import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../db.js";
import {
  DEFAULT_CACHE_MAX_BYTES,
  cacheGet,
  cacheSet,
  clearCache,
  getCacheStats,
  getCacheMaxBytes,
  setCacheMaxBytes,
} from "./cacheStore.js";

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("cacheGet / cacheSet", () => {
  it("round-trips values per namespace", () => {
    expect(cacheGet(db, "u:1", "missing")).toBeNull();
    expect(cacheSet(db, "u:1", "greeting", "hello")).toEqual({ changed: true });
    expect(cacheGet(db, "u:1", "greeting")).toBe("hello");
    // Namespaces are isolated.
    expect(cacheGet(db, "u:2", "greeting")).toBeNull();
  });

  it("reports whether the stored value actually changed", () => {
    expect(cacheSet(db, "anon", "k", "v1")).toEqual({ changed: true });
    expect(cacheSet(db, "anon", "k", "v1")).toEqual({ changed: false });
    expect(cacheSet(db, "anon", "k", "v2")).toEqual({ changed: true });
    expect(cacheGet(db, "anon", "k")).toBe("v2");
  });

  it("treats reading as usage for LRU purposes", () => {
    cacheSet(db, "anon", "a", "aaa");
    // Touch "a" so its last_used moves past the others.
    db.prepare("UPDATE cache_entries SET last_used = 1000").run();
    expect(cacheGet(db, "anon", "a")).toBe("aaa");
    const row = db
      .prepare("SELECT last_used FROM cache_entries WHERE key = 'a'")
      .get() as { last_used: number };
    expect(row.last_used).toBeGreaterThan(1000);
  });
});

describe("byte budget and eviction", () => {
  it("defaults to 512 MiB", () => {
    expect(getCacheMaxBytes(db)).toBe(DEFAULT_CACHE_MAX_BYTES);
  });

  it("evicts least-recently-used entries when over budget", () => {
    // Budget for exactly two 40-byte-ish entries.
    setCacheMaxBytes(db, 100);
    cacheSet(db, "anon", "a", "x".repeat(40));
    cacheSet(db, "anon", "b", "y".repeat(40));
    // Deterministic LRU ordering regardless of insert timing.
    db.prepare("UPDATE cache_entries SET last_used = 1000 WHERE key = 'a'").run();
    db.prepare("UPDATE cache_entries SET last_used = 2000 WHERE key = 'b'").run();

    cacheSet(db, "anon", "c", "z".repeat(40));

    expect(cacheGet(db, "anon", "a")).toBeNull();
    expect(cacheGet(db, "anon", "b")).toBe("y".repeat(40));
    expect(cacheGet(db, "anon", "c")).toBe("z".repeat(40));
    expect(getCacheStats(db).usedBytes).toBeLessThanOrEqual(100);
  });

  it("refuses entries larger than the whole budget without evicting anything", () => {
    setCacheMaxBytes(db, 50);
    cacheSet(db, "anon", "small", "keep");
    const result = cacheSet(db, "anon", "huge", "x".repeat(500));
    expect(result).toEqual({ changed: false });
    expect(cacheGet(db, "anon", "small")).toBe("keep");
    expect(cacheGet(db, "anon", "huge")).toBeNull();
  });

  it("evicts immediately when the max size is lowered", () => {
    cacheSet(db, "anon", "a", "x".repeat(40));
    cacheSet(db, "anon", "b", "y".repeat(40));
    const stats = setCacheMaxBytes(db, 45);
    expect(stats.maxBytes).toBe(45);
    expect(stats.usedBytes).toBeLessThanOrEqual(45);
    expect(stats.entryCount).toBe(1);
  });

  it("rejects non-positive or invalid max sizes", () => {
    expect(() => setCacheMaxBytes(db, 0)).toThrow();
    expect(() => setCacheMaxBytes(db, -5)).toThrow();
    expect(() => setCacheMaxBytes(db, Number.NaN)).toThrow();
    expect(getCacheMaxBytes(db)).toBe(DEFAULT_CACHE_MAX_BYTES);
  });
});

describe("getCacheStats / clearCache", () => {
  it("summarizes usage", () => {
    cacheSet(db, "u:1", "a", "12345");
    cacheSet(db, "u:2", "b", "123");
    const stats = getCacheStats(db);
    expect(stats.entryCount).toBe(2);
    expect(stats.usedBytes).toBe(8);
    expect(stats.maxBytes).toBe(DEFAULT_CACHE_MAX_BYTES);
  });

  it("clears only the requested namespace", () => {
    cacheSet(db, "u:1", "a", "one");
    cacheSet(db, "u:2", "b", "two");
    const stats = clearCache(db, "u:1");
    expect(stats.entryCount).toBe(1);
    expect(cacheGet(db, "u:1", "a")).toBeNull();
    expect(cacheGet(db, "u:2", "b")).toBe("two");
  });

  it("clears everything without a namespace", () => {
    cacheSet(db, "u:1", "a", "one");
    cacheSet(db, "anon", "b", "two");
    const stats = clearCache(db);
    expect(stats.entryCount).toBe(0);
    expect(stats.usedBytes).toBe(0);
  });
});
