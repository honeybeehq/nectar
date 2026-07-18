import { describe, expect, it } from "vitest";
import { gcTransition, selectPackPrunes } from "../src/gc.js";
import { record } from "./helpers.js";

describe("GC selection", () => {
  it("expires a short-TTL publish but honors an explicit recent touch", () => {
    const published = record({
      published_at: "2026-07-18T12:00:00.000Z",
      last_touched_at: "2026-07-18T12:00:00.000Z",
      expires_at: "2026-07-18T12:01:00.000Z",
    });
    expect(gcTransition(published, new Date("2026-07-18T12:02:00.000Z"))).toBe("expire");
    const touched = { ...published, last_touched_at: "2026-07-18T12:01:30.000Z" };
    expect(gcTransition(touched, new Date("2026-07-18T12:02:00.000Z"))).toBeUndefined();
  });

  it("selects cold and reap transitions from expiry", () => {
    const expired = record({ status: "expired", expires_at: "2026-07-01T00:00:00.000Z", last_touched_at: "2026-06-30T00:00:00.000Z", published_at: "2026-06-30T00:00:00.000Z" });
    expect(gcTransition(expired, new Date("2026-07-02T01:00:00.000Z"))).toBe("cold");
    expect(gcTransition(expired, new Date("2026-07-17T01:00:00.000Z"))).toBe("reap");
  });

  it("prunes unprotected packs LRU, never a serving pack, and leaves one pack", () => {
    const files = [
      { path: "old", size: 80, atimeMs: 1, protected: false },
      { path: "new", size: 80, atimeMs: 3, protected: false },
      { path: "serving", size: 80, atimeMs: 0, protected: true },
    ];
    expect(selectPackPrunes(files, 170).map((file) => file.path)).toEqual(["old"]);
    expect(selectPackPrunes(files, 1).map((file) => file.path)).toEqual(["old", "new"]);
  });
});
