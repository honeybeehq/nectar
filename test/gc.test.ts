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
    const cold = { ...expired, status: "cold" as const };
    expect(gcTransition(cold, new Date("2026-07-02T01:00:00.000Z"))).toBeUndefined();
    expect(gcTransition(cold, new Date("2026-07-17T01:00:00.000Z"))).toBe("reap");
  });

  it("expires warm dev registrations on the normal disk clock", () => {
    const warm = record({
      name: "demo--main--dev",
      mode: "dev",
      status: "warm",
      published_at: "2026-07-18T12:00:00.000Z",
      last_touched_at: "2026-07-18T12:00:00.000Z",
      expires_at: "2026-07-18T12:01:00.000Z",
      urls: { local: null, mesh: null },
    });
    expect(gcTransition(warm, new Date("2026-07-18T12:02:00.000Z"))).toBe("expire");
  });

  it("idle-stops dev serves from last_opened_at without letting resolve touches keep them alive", () => {
    const serving = record({
      name: "demo--main--dev",
      mode: "dev",
      last_opened_at: "2026-07-18T11:00:00.000Z",
      // A resolve just touched the record, but must not touch the process clock.
      last_touched_at: "2026-07-18T12:00:00.000Z",
      published_at: "2026-07-18T10:00:00.000Z",
      expires_at: "2026-07-21T12:00:00.000Z",
      urls: { local: null, mesh: null },
    });
    expect(gcTransition(serving, new Date("2026-07-18T12:00:00.000Z"))).toBe("idle-stop");
    expect(gcTransition({ ...serving, pinned: true }, new Date("2026-07-18T12:00:00.000Z"))).toBeUndefined();
    expect(gcTransition({ ...serving, status: "warm" }, new Date("2026-07-18T12:00:00.000Z"))).toBeUndefined();
    expect(
      gcTransition(
        { ...serving, last_opened_at: "2026-07-18T11:30:01.000Z" },
        new Date("2026-07-18T12:00:00.000Z"),
        30 * 60_000,
      ),
    ).toBeUndefined();
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
