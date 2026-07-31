import path from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadRecipe, selectMode } from "../src/recipe.js";
import { tempDir } from "./helpers.js";

describe("nectar.toml recipes", () => {
  it("parses the complete v0 recipe and literal env", async () => {
    const repo = await tempDir("recipe");
    await writeFile(
      path.join(repo, "nectar.toml"),
      `
name = "Acme"
[web]
serve = "pnpm dev"
ready_path = "/health"
ready_timeout = "2m"
env = { VITE_MODE = "review", DOLLAR = "$LITERAL" }
[desktop]
pack = "pnpm dist:testpack"
kind = "electron"
embed_url = "web"
`,
    );
    const recipe = await loadRecipe(repo);
    expect(recipe).toEqual({
      name: "acme",
      source: "nectar.toml",
      web: {
        serve: "pnpm dev",
        readyPath: "/health",
        readyTimeoutMs: 120_000,
        env: { VITE_MODE: "review", DOLLAR: "$LITERAL" },
      },
      desktop: { pack: "pnpm dist:testpack", kind: "electron", embedUrl: "web" },
    });
    expect(selectMode(recipe)).toBe("web");
    expect(selectMode(recipe, "desktop")).toBe("desktop");
  });

  it("rejects non-literal env values in v0", async () => {
    const repo = await tempDir("recipe-invalid");
    await writeFile(path.join(repo, "nectar.toml"), `[web]\nserve="npm run dev"\nenv={PORT=123}\n`);
    await expect(loadRecipe(repo)).rejects.toThrow(/literal string/);
  });

  it("uses package.json dev fallback and lockfile package manager", async () => {
    const repo = await tempDir("recipe-fallback");
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "@scope/Hello App", scripts: { dev: "vite" } }));
    await writeFile(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const recipe = await loadRecipe(repo);
    expect(recipe.name).toBe("hello-app");
    expect(recipe.web?.serve).toBe("pnpm dev");
    expect(recipe.source).toBe("package.json");
  });

  it("parses [ios] with defaults and validates bundle_id", async () => {
    const repo = await tempDir("recipe-ios");
    await writeFile(
      path.join(repo, "nectar.toml"),
      `name = "orders"\n[ios]\npack = "pnpm ios:sim-release"\nbundle_id = "com.digitech.order"\n`,
    );
    const recipe = await loadRecipe(repo);
    expect(recipe.ios).toEqual({
      pack: "pnpm ios:sim-release",
      bundleId: "com.digitech.order",
      device: "iPhone 17",
      runtime: "latest",
      stream: true,
      readyTimeoutMs: 90_000,
    });
    expect(selectMode(recipe)).toBe("ios");

    await writeFile(path.join(repo, "nectar.toml"), `[ios]\npack = "x"\nbundle_id = "bad id!"\n`);
    await expect(loadRecipe(repo)).rejects.toThrow(/bundle_id/);
    await writeFile(path.join(repo, "nectar.toml"), `[ios]\npack = "x"\n`);
    await expect(loadRecipe(repo)).rejects.toThrow(/bundle_id/);
  });

  it("parses [dev], applies the readiness default, and selects it as a mode", async () => {
    const repo = await tempDir("recipe-dev");
    await writeFile(
      path.join(repo, "nectar.toml"),
      `
name = "bench"
[dev]
run = "pnpm dev"
kind = "electron"
warm = "pnpm native:build"
ready_timeout = "75s"
`,
    );
    const recipe = await loadRecipe(repo);
    expect(recipe.dev).toEqual({
      run: "pnpm dev",
      kind: "electron",
      warm: "pnpm native:build",
      readyTimeoutMs: 75_000,
    });
    expect(selectMode(recipe)).toBe("dev");
    expect(selectMode(recipe, "dev")).toBe("dev");

    await writeFile(path.join(repo, "nectar.toml"), `[dev]\nrun = "pnpm dev"\nkind = "electron"\n`);
    expect((await loadRecipe(repo)).dev?.readyTimeoutMs).toBe(60_000);
  });

  it("rejects unsupported dev kinds and typo'd dev keys", async () => {
    const repo = await tempDir("recipe-dev-invalid");
    await writeFile(path.join(repo, "nectar.toml"), `[dev]\nrun = "pnpm dev"\nkind = "native"\n`);
    await expect(loadRecipe(repo)).rejects.toThrow(/\[dev\]\.kind must be 'electron'/);
    await writeFile(path.join(repo, "nectar.toml"), `[dev]\nrun = "pnpm dev"\nkind = "electron"\nready_timout = "5s"\n`);
    await expect(loadRecipe(repo)).rejects.toThrow(/Unknown key 'ready_timout'/);
  });

  it("returns stable contract errors for unsupported modes and missing recipes", async () => {
    const repo = await tempDir("recipe-missing");
    await expect(loadRecipe(repo)).rejects.toMatchObject({ code: "E_NO_RECIPE" });
    expect(() => selectMode({ name: "x", source: "nectar.toml", web: { serve: "x", readyPath: "/", readyTimeoutMs: 1, env: {} } }, "cli"))
      .toThrow(/deferred to v0\.1/);
    expect(() => selectMode({ name: "x", source: "nectar.toml", web: { serve: "x", readyPath: "/", readyTimeoutMs: 1, env: {} } }, "android"))
      .toThrow(/not supported/);
  });

  it("rejects deferred sections and typo'd keys instead of silently ignoring them", async () => {
    const repo = await tempDir("recipe-strict");
    await writeFile(path.join(repo, "nectar.toml"), `name = "x"\n[web]\nserve = "s"\n[secrets]\nAPI = "project/x/api-test"\n`);
    await expect(loadRecipe(repo)).rejects.toMatchObject({ code: "E_NO_RECIPE" });
    await writeFile(path.join(repo, "nectar.toml"), `name = "x"\n[web]\nserve = "s"\nready_timout = "5s"\n`);
    await expect(loadRecipe(repo)).rejects.toThrow(/Unknown key 'ready_timout'/);
  });
});
