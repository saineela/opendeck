import { describe, expect, it } from "vitest";
import { boundUpstreamRange } from "./routes/media.js";

/**
 * googlevideo answers 403 to open-ended and absent ranges on some signed URLs
 * while serving bounded ones, so the relay must never forward `bytes=0-`.
 */
describe("boundUpstreamRange", () => {
  it("bounds the open-ended range a browser audio element sends first", () => {
    expect(boundUpstreamRange("bytes=0-")).toBe("bytes=0-1048575");
  });

  it("bounds a request that carries no range at all", () => {
    expect(boundUpstreamRange(undefined)).toBe("bytes=0-1048575");
  });

  it("bounds a later open-ended range at its own offset", () => {
    expect(boundUpstreamRange("bytes=2097152-")).toBe("bytes=2097152-3145727");
  });

  it("keeps an explicit bounded range", () => {
    expect(boundUpstreamRange("bytes=0-1")).toBe("bytes=0-1");
    expect(boundUpstreamRange("bytes=500000-500100")).toBe("bytes=500000-500100");
  });

  it("keeps a suffix range", () => {
    expect(boundUpstreamRange("bytes=-500")).toBe("bytes=-500");
  });

  it("passes malformed or multi-range values through untouched", () => {
    expect(boundUpstreamRange("bytes=0-1,4-5")).toBe("bytes=0-1,4-5");
    expect(boundUpstreamRange("items=0-")).toBe("items=0-");
  });
});
