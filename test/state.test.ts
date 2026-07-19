import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
    await expect(store.withLock("demo--main--web", () => Promise.resolve(undefined))).rejects.toMatchObject({ code: "E_BUSY" });
    release?.();
    await held;
  });

  it("steals a lock whose recorded holder is dead", async () => {
    const root = await tempDir("stale-locks");
    const store = new StateStore(getPaths(root));
    await store.init();
    // 2^22 exceeds macOS/Linux pid_max, so this pid can never be alive.
    await writeFile(path.join(root, "locks", "demo--main--web.lock"), "4194304\n");
    expect(await store.withLock("demo--main--web", () => Promise.resolve("ran"))).toBe("ran");
    // An empty/garbage lockfile (crash before the pid write) is also stealable.
    await writeFile(path.join(root, "locks", "demo--main--web.lock"), "");
    expect(await store.withLock("demo--main--web", () => Promise.resolve("ran again"))).toBe("ran again");
  });

  it("updateEnv mutates under the lock and bestEffort skips when busy", async () => {
    const root = await tempDir("update-env");
    const store = new StateStore(getPaths(root));
    await store.writeEnv(record());
    const updated = await store.updateEnv("demo--main--web", (env) => {
      env.status = "stopped";
    });
    expect(updated?.status).toBe("stopped");
    expect((await store.readEnv("demo--main--web")).status).toBe("stopped");

    let release: (() => void) | undefined;
    const held = store.withLock("demo--main--web", async () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const skipped = await store.updateEnv("demo--main--web", (env) => {
      env.status = "crashed";
    }, { bestEffort: true });
    expect(skipped).toBeUndefined();
    expect((await store.readEnv("demo--main--web")).status).toBe("stopped");
    release?.();
    await held;
  });

  it("tolerates a corrupt env record in listEnvs", async () => {
    const root = await tempDir("corrupt");
    const store = new StateStore(getPaths(root));
    await store.writeEnv(record());
    await mkdir(path.join(root, "envs"), { recursive: true });
    await writeFile(path.join(root, "envs", "broken--env--web.json"), "{truncated");
    expect((await store.listEnvs()).map((item) => item.name)).toEqual(["demo--main--web"]);
  });
});
