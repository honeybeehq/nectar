import { describe, expect, it } from "vitest";
import { previewCreator, publisherCreator } from "../src/creator.js";
import type { PreviewCreator } from "../src/types.js";
import { record } from "./helpers.js";

describe("preview creator trust", () => {
  it("never authenticates publisher claims", () => {
    expect(publisherCreator({ user: "test", hive_session: "forged-session", node_name: "claimed-node" }))
      .toEqual({ session_id: "forged-session", node: "claimed-node", verified: false });
    expect(publisherCreator({ user: "test" })).toBeNull();
  });

  it("leaves old records unattributed and downgrades a forged stored flag", () => {
    expect(previewCreator(record({ publisher: { user: "test", hive_session: "old-claim" } }))).toBeNull();
    const forged = JSON.parse('{"session_id":"forged","node":"claimed","verified":true}') as PreviewCreator;
    expect(previewCreator(record({ creator: forged }))).toEqual({ session_id: "forged", node: "claimed", verified: false });
  });
});
