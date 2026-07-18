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
name = "Kontiki"
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
      name: "kontiki",
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

  it("returns stable contract errors for unsupported modes and missing recipes", async () => {
    const repo = await tempDir("recipe-missing");
    await expect(loadRecipe(repo)).rejects.toMatchObject({ code: "E_NO_RECIPE" });
    expect(() => selectMode({ name: "x", source: "nectar.toml", web: { serve: "x", readyPath: "/", readyTimeoutMs: 1, env: {} } }, "cli"))
      .toThrow(/not supported/);
  });
});
