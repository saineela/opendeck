import { describe, expect, it } from "vitest";
import { shuffleTracks } from "./shuffleTracks";
import type { Track } from "../datasource/types";

function tracks(count: number): Track[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index}`,
    source: "youtube" as const,
    title: `Track ${index}`,
    artist: "Artist",
  }));
}

describe("shuffleTracks", () => {
  it("returns a permutation of the input", () => {
    const input = tracks(30);
    const output = shuffleTracks(input);
    expect(output).toHaveLength(input.length);
    expect(output.map((t) => t.id).sort()).toEqual(input.map((t) => t.id).sort());
  });

  it("does not mutate the input array", () => {
    const input = tracks(20);
    const before = input.map((t) => t.id);
    const output = shuffleTracks(input);
    expect(input.map((t) => t.id)).toEqual(before);
    expect(output).not.toBe(input);
  });

  it("handles empty and single-element arrays", () => {
    expect(shuffleTracks([])).toEqual([]);
    const single = tracks(1);
    expect(shuffleTracks(single).map((t) => t.id)).toEqual(["t0"]);
  });

  it("actually reorders larger inputs", () => {
    const input = tracks(50);
    const output = shuffleTracks(input).map((t) => t.id);
    expect(output).not.toEqual(input.map((t) => t.id));
  });
});
