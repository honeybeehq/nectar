import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getPaths } from "../src/paths.js";
import { StateStore } from "../src/state.js";
import { record, tempDir } from "./helpers.js";

describe("file-per-env state", () => {
  it("writes one atomic JSON file per mode-qualified env", async () => {
    const root = await tempDir("state");
    const store = new StateStore(getPaths(root));
    const web = record();
    const desktop = record({ name: "demo--main--desktop", mode: "desktop", urls: { local: null, mesh: null } });
    await Promise.all([store.writeEnv(web), store.writeEnv(desktop)]);
    expect((await store.listEnvs()).map((item) => item.name)).toEqual(["demo--main--desktop", "demo--main--web"]);
    expect(JSON.parse(await readFile(path.join(root, "envs", "demo--main--web.json"), "utf8"))).toEqual(web);
    expect((await readdir(path.join(root, "envs"))).every((name) => name.endsWith(".json"))).toBe(true);
  });

  it("serializes access with a per-env lock", async () => {
    const root = await tempDir("locks");
    const store = new StateStore(getPaths(root));
    let release: (() => void) | undefined;
    const held = store.withLock("demo--main--web", async () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(store.withLock("demo--main--web", () => Promise.resolve(undefined))).rejects.toMatchObject({ code: "E_CHECKOUT" });
    release?.();
    await held;
  });
});
