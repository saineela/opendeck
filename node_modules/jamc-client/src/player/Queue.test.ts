import { describe, expect, it, vi } from "vitest";
import { Queue } from "./Queue";
import type { Track } from "../datasource/types";

function track(id: string): Track {
  return { id, source: "youtube", title: `Title ${id}`, artist: "Artist" };
}

function ids(tracks: readonly Track[]): string[] {
  return tracks.map((t) => t.id);
}

function makeQueue(): Queue {
  const queue = new Queue();
  queue.set([track("a"), track("b"), track("c"), track("d")]);
  return queue;
}

describe("Queue basics", () => {
  it("starts empty and reports no current track", () => {
    const queue = new Queue();
    expect(queue.current).toBeNull();
    expect(queue.all).toHaveLength(0);
    expect(queue.currentIndex).toBe(-1);
    expect(queue.next()).toBeNull();
    expect(queue.prev()).toBeNull();
  });

  it("clamps the start index into range", () => {
    const queue = new Queue();
    queue.set([track("a"), track("b")], 99);
    expect(queue.current?.id).toBe("b");
    queue.set([track("a"), track("b")], -5);
    expect(queue.current?.id).toBe("a");
  });

  it("an empty set leaves the queue empty", () => {
    const queue = makeQueue();
    queue.set([]);
    expect(queue.current).toBeNull();
    expect(queue.currentIndex).toBe(-1);
  });
});

describe("manual queue", () => {
  it("add() inserts directly after the manual block", () => {
    const queue = makeQueue();
    queue.add(track("e"));
    expect(ids(queue.all)).toEqual(["a", "e", "b", "c", "d"]);
    expect(queue.queuedManually).toBe(1);

    queue.add(track("f"));
    expect(ids(queue.all)).toEqual(["a", "e", "f", "b", "c", "d"]);
    expect(queue.queuedManually).toBe(2);
  });

  it("playNext() inserts immediately after the current track", () => {
    const queue = makeQueue();
    queue.playNext(track("e"));
    expect(ids(queue.all)).toEqual(["a", "e", "b", "c", "d"]);
    queue.add(track("f"));
    // add() goes after the manual block, playNext() right after current.
    expect(ids(queue.all)).toEqual(["a", "e", "f", "b", "c", "d"]);
    queue.playNext(track("g"));
    expect(ids(queue.all)).toEqual(["a", "g", "e", "f", "b", "c", "d"]);
    expect(queue.queuedManually).toBe(3);
  });

  it("add()/playNext() on an empty queue seed it with that track", () => {
    const queue = new Queue();
    queue.add(track("x"));
    expect(ids(queue.all)).toEqual(["x"]);
    expect(queue.current?.id).toBe("x");

    const other = new Queue();
    other.playNext(track("y"));
    expect(other.current?.id).toBe("y");
  });

  it("next() consumes the manual queue first", () => {
    const queue = makeQueue();
    queue.playNext(track("m1"));
    queue.playNext(track("m2"));
    expect(ids(queue.all)).toEqual(["a", "m2", "m1", "b", "c", "d"]);
    expect(queue.next()).toMatchObject({ id: "m2" });
    expect(queue.queuedManually).toBe(1);
    expect(queue.next()).toMatchObject({ id: "m1" });
    expect(queue.queuedManually).toBe(0);
    expect(queue.next()).toMatchObject({ id: "b" });
    expect(queue.queuedManually).toBe(0);
  });

  it("tracks remaining automatic tracks behind the manual block", () => {
    const queue = makeQueue();
    expect(queue.remainingAutomatic).toBe(3); // b, c, d
    queue.playNext(track("m1"));
    expect(queue.remainingAutomatic).toBe(3); // manual is not automatic
    queue.next();
    queue.next();
    expect(queue.current?.id).toBe("b");
    expect(queue.remainingAutomatic).toBe(2);
  });

  it("appendAutomaticTracks() replaces the automatic tail after the manual block", () => {
    // Matches the reference implementation: both append and replace rebuild
    // the queue from the manual block onward.
    const queue = makeQueue();
    queue.playNext(track("m1"));
    queue.appendAutomaticTracks([track("e"), track("f")]);
    expect(ids(queue.all)).toEqual(["a", "m1", "e", "f"]);
    expect(queue.current?.id).toBe("a");
    expect(queue.queuedManually).toBe(1);
    expect(queue.remainingAutomatic).toBe(2);
  });

  it("appendAutomaticTracks() on an empty queue seeds it", () => {
    const queue = new Queue();
    queue.appendAutomaticTracks([track("x"), track("y")]);
    expect(ids(queue.all)).toEqual(["x", "y"]);
    expect(queue.current?.id).toBe("x");
  });

  it("appendAutomaticTracks() ignores an empty batch", () => {
    const queue = makeQueue();
    queue.appendAutomaticTracks([]);
    expect(ids(queue.all)).toEqual(["a", "b", "c", "d"]);
  });

  it("replaceAutomaticUpcoming() keeps current + manual intact", () => {
    const queue = makeQueue();
    queue.playNext(track("m1"));
    queue.replaceAutomaticUpcoming([track("x"), track("y")]);
    expect(ids(queue.all)).toEqual(["a", "m1", "x", "y"]);
    expect(queue.current?.id).toBe("a");
    expect(queue.queuedManually).toBe(1);
  });
});

describe("navigation", () => {
  it("next() advances and wraps", () => {
    const queue = makeQueue();
    expect(queue.next()).toMatchObject({ id: "b" });
    expect(queue.next()).toMatchObject({ id: "c" });
    expect(queue.next()).toMatchObject({ id: "d" });
    expect(queue.next()).toMatchObject({ id: "a" }); // wrapped
  });

  it("next(false) stops at the end", () => {
    const queue = makeQueue();
    queue.select(3);
    expect(queue.next(false)).toBeNull();
    expect(queue.currentIndex).toBe(3);
  });

  it("prev() goes backwards and wraps", () => {
    const queue = makeQueue();
    expect(queue.prev()).toMatchObject({ id: "d" });
    expect(queue.prev()).toMatchObject({ id: "c" });
    queue.select(0);
    expect(queue.prev(false)).toBeNull();
    expect(queue.prev()).toMatchObject({ id: "d" });
  });

  it("prev() clears the manual queue", () => {
    const queue = makeQueue();
    queue.playNext(track("m1"));
    queue.playNext(track("m2"));
    expect(queue.queuedManually).toBe(2);
    queue.next(); // move onto m2 (manual left: 1)
    expect(queue.queuedManually).toBe(1);
    queue.prev(); // back to current — manual block is discarded
    expect(queue.current?.id).toBe("a");
    expect(queue.queuedManually).toBe(0);
  });

  it("select() jumps to a track and keeps the manual block when landing inside it", () => {
    const queue = makeQueue();
    queue.playNext(track("m1"));
    queue.playNext(track("m2"));
    // layout: a m2 m1 b c d, current a, manual 2 (m2 m1)
    expect(queue.select(1)).toMatchObject({ id: "m2" });
    expect(queue.queuedManually).toBe(1); // m1 still manual
    expect(queue.select(4)).toMatchObject({ id: "c" });
    expect(queue.queuedManually).toBe(0); // jumped into automatic
    expect(queue.select(99)).toBeNull();
    expect(queue.select(-1)).toBeNull();
  });
});

describe("removal and reordering", () => {
  it("removeAt() removes tracks and keeps indices sane", () => {
    const queue = makeQueue();
    queue.removeAt(1); // b
    expect(ids(queue.all)).toEqual(["a", "c", "d"]);
    expect(queue.current?.id).toBe("a");

    queue.select(1); // now on c
    queue.removeAt(1); // removing the current track steps back to a
    expect(ids(queue.all)).toEqual(["a", "d"]);
    expect(queue.current?.id).toBe("a");

    queue.removeAt(50); // out of range: no-op
    expect(ids(queue.all)).toEqual(["a", "d"]);
  });

  it("removeAt() of a manual track shrinks the manual block", () => {
    const queue = makeQueue();
    queue.playNext(track("m1"));
    queue.playNext(track("m2"));
    // a m2 m1 b c d
    queue.removeAt(2); // m1 (manual)
    expect(ids(queue.all)).toEqual(["a", "m2", "b", "c", "d"]);
    expect(queue.queuedManually).toBe(1);
    queue.removeAt(2); // b (automatic)
    expect(ids(queue.all)).toEqual(["a", "m2", "c", "d"]);
    expect(queue.queuedManually).toBe(1);
  });

  it("move() reorders within the automatic tail", () => {
    const queue = makeQueue();
    queue.move(1, 3, false); // b in front of d
    expect(ids(queue.all)).toEqual(["a", "c", "b", "d"]);

    const queue2 = makeQueue();
    queue2.move(1, 3, true); // b after d
    expect(ids(queue2.all)).toEqual(["a", "c", "d", "b"]);

    const queue3 = makeQueue();
    queue3.move(3, 1, false); // d in front of b
    expect(ids(queue3.all)).toEqual(["a", "d", "b", "c"]);
  });

  it("move() refuses illegal moves", () => {
    const queue = makeQueue();
    const before = ids(queue.all);
    queue.move(0, 2, false); // cannot move the current track
    queue.move(2, 0, false); // cannot move before/at current
    queue.move(1, 1, false); // same index
    queue.move(1, 99, false); // out of range
    queue.move(9, 2, false); // out of range
    expect(ids(queue.all)).toEqual(before);

    const manual = makeQueue();
    manual.playNext(track("m1"));
    // a m1 b c d — m1 manual, b automatic: crossing classes is refused
    const snapshot = ids(manual.all);
    manual.move(1, 2, false);
    manual.move(2, 1, false);
    expect(ids(manual.all)).toEqual(snapshot);
  });
});

describe("shuffle and restore", () => {
  it("shuffles only the automatic tail, preserving the manual prefix", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const queue = makeQueue();
      queue.playNext(track("m1"));
      queue.playNext(track("m2"));
      // a m2 m1 b c d
      queue.shuffleRemaining(queue.queuedManually);
      const result = ids(queue.all);
      expect(result.slice(0, 3)).toEqual(["a", "m2", "m1"]); // untouched
      expect([...result.slice(3)].sort()).toEqual(["b", "c", "d"]); // permutation
      expect(result.slice(3)).not.toEqual(["b", "c", "d"]); // actually reordered
      expect(queue.current?.id).toBe("a");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("restoreOriginalOrder() returns the pre-shuffle order", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const queue = makeQueue();
      const before = ids(queue.all);
      queue.shuffleRemaining(0);
      expect(ids(queue.all)).not.toEqual(before);
      queue.restoreOriginalOrder(0);
      expect(ids(queue.all)).toEqual(before);
      // Restoring again without a shuffle is a no-op.
      queue.restoreOriginalOrder(0);
      expect(ids(queue.all)).toEqual(before);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("shuffling a single upcoming track changes nothing", () => {
    const queue = new Queue();
    queue.set([track("a"), track("b")]);
    queue.shuffleRemaining(0);
    expect(ids(queue.all)).toEqual(["a", "b"]);
  });
});
