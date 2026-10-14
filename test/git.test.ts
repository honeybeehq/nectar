import { describe, expect, it } from "vitest";
import { normalizeRemote } from "../src/git.js";

describe("normalizeRemote", () => {
  it("gives every spelling of one hosted repository the same identity and drops credentials", () => {
    const spellings = [
      "git@github.com:honeybeehq/nectar.git",
      "ssh://git@github.com/honeybeehq/nectar",
      "ssh://git@GitHub.com:22/honeybeehq/nectar.git/",
      "https://github.com/honeybeehq/nectar.git",
      "https://user:secret-token@github.com/honeybeehq/nectar",
    ];
    for (const url of spellings) expect(normalizeRemote(url, "/srv/repo")).toBe("github.com/honeybeehq/nectar");
    expect(normalizeRemote("https://github.com/honeybeehq/other", "/srv/repo")).toBe("github.com/honeybeehq/other");
  });

  it("resolves local remotes against the repository and keeps a .git directory name", () => {
    expect(normalizeRemote("/srv/origin.git", "/srv/repo")).toBe("/srv/origin.git");
    expect(normalizeRemote("file:///srv/origin.git", "/srv/repo")).toBe("/srv/origin.git");
    expect(normalizeRemote("../upstream/.git", "/srv/repo")).toBe("/srv/upstream");
    expect(normalizeRemote("../origin", "/srv/repo")).not.toBe(normalizeRemote("../origin.git", "/srv/repo"));
  });
});
