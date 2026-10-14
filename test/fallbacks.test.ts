import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runCommand } from "../src/commands.js";
import { assertRuntimes, type FallbackHost } from "../src/fallbacks.js";
import { loadRecipe } from "../src/recipe.js";
import { NectarService } from "../src/service.js";
import { initGitRepo, tempDir } from "./helpers.js";

const withUv: FallbackHost = { hasCommand: () => true };
const withoutUv: FallbackHost = { hasCommand: (name) => name !== "uv" };
const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function repoWith(files: Record<string, string>): Promise<string> {
  const repo = await tempDir("fallback");
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), contents);
  }
  return repo;
}

const flask = "from flask import Flask\n\napp = Flask(__name__)\n";
const fastapi = "from fastapi import FastAPI\n\napi: FastAPI = FastAPI()\n";

describe("detection order", () => {
  it("lets nectar.toml win over every fallback", async () => {
    const repo = await repoWith({
      "nectar.toml": `[web]\nserve = "make serve"\n`,
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
      "requirements.txt": "flask\n",
      "app.py": flask,
      Gemfile: `gem "rails"\n`,
    });
    const recipe = await loadRecipe(repo, withUv);
    expect(recipe.source).toBe("nectar.toml");
    expect(recipe.web?.serve).toBe("make serve");
    expect(recipe.web?.build).toBeUndefined();
  });

  it("puts a package.json dev script ahead of Python and Rails", async () => {
    const repo = await repoWith({
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
      "requirements.txt": "flask\n",
      "app.py": flask,
      Gemfile: `gem "rails"\n`,
    });
    const recipe = await loadRecipe(repo, withUv);
    expect(recipe.source).toBe("package.json");
    expect(recipe.detected?.stack).toBe("node");
  });

  it("falls through a package.json without a dev script to Python, then Rails", async () => {
    const python = await repoWith({ "package.json": "{}", "requirements.txt": "flask\n", "app.py": flask, Gemfile: `gem "rails"\n` });
    expect((await loadRecipe(python, withUv)).detected?.stack).toBe("flask");
    const rails = await repoWith({ "package.json": "{}", Gemfile: `source "https://rubygems.org"\ngem 'rails', '~> 8.0'\n` });
    expect((await loadRecipe(rails, withUv)).detected?.stack).toBe("rails");
  });

  it("prefers Django over FastAPI over Flask", async () => {
    const all = await repoWith({ "requirements.txt": "django\n", "manage.py": "", "main.py": fastapi, "app.py": flask });
    expect((await loadRecipe(all, withUv)).detected?.stack).toBe("django");
    const asgiAndFlask = await repoWith({ "requirements.txt": "fastapi\n", "main.py": fastapi, "app.py": flask });
    expect((await loadRecipe(asgiAndFlask, withUv)).detected?.stack).toBe("fastapi");
  });

  it("does not claim a Python repo with no known entrypoint, so static mode can take it", async () => {
    const repo = await repoWith({ "requirements.txt": "requests\n", "tool.py": "print('hi')\n" });
    await expect(loadRecipe(repo, withUv)).rejects.toMatchObject({ code: "E_NO_RECIPE" });
    const gemfile = await repoWith({ Gemfile: `gem "sinatra"\n` });
    await expect(loadRecipe(gemfile, withUv)).rejects.toMatchObject({ code: "E_NO_RECIPE" });
  });
});

describe("generated commands", () => {
  it("builds a Django venv with uv and runs runserver without the reloader", async () => {
    const repo = await repoWith({ "requirements.txt": "django\n", "manage.py": "" });
    const recipe = await loadRecipe(repo, withUv);
    expect(recipe.source).toBe("requirements.txt");
    expect(recipe.web).toEqual({
      build: "uv venv --allow-existing .nectar/venv && uv pip install --python .nectar/venv/bin/python -r requirements.txt",
      serve: `exec .nectar/venv/bin/python manage.py runserver --noreload 127.0.0.1:"$PORT"`,
      requires: ["uv"],
      readyPath: "/",
      readyTimeoutMs: 90_000,
      env: {},
    });
  });

  it("serves FastAPI through uvicorn and adds uvicorn when the deps lack it", async () => {
    const repo = await repoWith({
      "pyproject.toml": `[project]\nname = "My API"\ndependencies = ["fastapi>=0.110"]\n`,
      "app/main.py": fastapi,
    });
    const recipe = await loadRecipe(repo, withUv);
    expect(recipe.name).toBe("my-api");
    expect(recipe.source).toBe("pyproject.toml");
    expect(recipe.web?.serve).toBe(`exec .nectar/venv/bin/python -m uvicorn app.main:api --host 127.0.0.1 --port "$PORT"`);
    expect(recipe.web?.build).toBe(
      "uv venv --allow-existing .nectar/venv && uv pip install --python .nectar/venv/bin/python -r pyproject.toml uvicorn",
    );
    const pip = await loadRecipe(repo, withoutUv);
    expect(pip.web?.build).toBe(
      "{ [ -x .nectar/venv/bin/python ] || python3 -m venv .nectar/venv; } && .nectar/venv/bin/python -m pip install --disable-pip-version-check 'fastapi>=0.110' uvicorn",
    );
    expect(pip.web?.requires).toEqual(["python3"]);
  });

  it("uses uv sync for a uv.lock project and pip without uv", async () => {
    const repo = await repoWith({
      "pyproject.toml": `[project]\nname = "x"\ndependencies = ["starlette", "uvicorn"]\n`,
      "uv.lock": "",
      "asgi.py": "from starlette.applications import Starlette\napplication = Starlette()\n",
    });
    const recipe = await loadRecipe(repo, withUv);
    expect(recipe.web?.build).toBe("UV_PROJECT_ENVIRONMENT=.nectar/venv uv sync --frozen --no-dev");
    expect(recipe.web?.serve).toContain("-m uvicorn asgi:application ");
  });

  it("runs Flask through its CLI, with the app factory when no app variable exists", async () => {
    const repo = await repoWith({ "requirements.txt": "flask\n", "app.py": flask });
    const recipe = await loadRecipe(repo, withoutUv);
    expect(recipe.web?.serve).toBe(`exec .nectar/venv/bin/python -m flask --app app:app run --host 127.0.0.1 --port "$PORT"`);
    expect(recipe.web?.build).toBe(
      "{ [ -x .nectar/venv/bin/python ] || python3 -m venv .nectar/venv; } && .nectar/venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt",
    );
    const factory = await repoWith({ "requirements.txt": "flask\n", "server.py": "def create_app():\n    return Flask(__name__)\n" });
    expect((await loadRecipe(factory, withUv)).web?.serve).toContain("--app server run");
  });

  it("bundles Rails gems into the work dir and serves bin/rails on loopback", async () => {
    const repo = await repoWith({ Gemfile: `gem "rails", "~> 8.0"\n`, "bin/rails": "" });
    const recipe = await loadRecipe(repo, withUv);
    expect(recipe.source).toBe("Gemfile");
    expect(recipe.web?.build).toBe("mkdir -p .nectar && BUNDLE_PATH=.nectar/bundle bundle install");
    expect(recipe.web?.serve).toBe(
      `rm -f .nectar/server.pid && BUNDLE_PATH=.nectar/bundle exec bin/rails server -b 127.0.0.1 -p "$PORT" --pid .nectar/server.pid`,
    );
    expect(recipe.web?.requires).toEqual(["ruby", "bundle"]);
    let error: unknown;
    try {
      assertRuntimes(recipe, { hasCommand: (name) => name === "ruby" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "E_PLATFORM", details: { missing: ["bundle"] } });
    expect(() => assertRuntimes(recipe, withUv)).not.toThrow();
  });

  it("detects every Python fixture", async () => {
    expect((await loadRecipe(path.join(fixtures, "flask-app"), withUv)).detected?.stack).toBe("flask");
    expect((await loadRecipe(path.join(fixtures, "fastapi-app"), withUv)).detected?.stack).toBe("fastapi");
    expect((await loadRecipe(path.join(fixtures, "django-app"), withUv)).detected?.stack).toBe("django");
  });
});

describe("publish with fallbacks", () => {
  it("explains the chosen fallback with --dry-run and changes no state", async () => {
    const state = await tempDir("fallback-state");
    const repo = await initGitRepo({ "requirements.txt": "flask\n", "app.py": flask, "index.html": "<h1>static</h1>" });
    const plan = await new NectarService(state).publish({ repo, dryRun: true });
    expect(plan).toMatchObject({ dry_run: true, mode: "web", source: "requirements.txt", stack: "flask" });
    expect(String(plan.serve)).toContain("-m flask --app app:app run");
    expect(String(plan.build)).toContain(".nectar/venv");
    expect(existsSync(path.join(state, "envs"))).toBe(false);

    const staticRepo = await initGitRepo({ "requirements.txt": "requests\n", "index.html": "<h1>static</h1>" });
    expect(await new NectarService(state).publish({ repo: staticRepo, dryRun: true })).toMatchObject({ source: "static", stack: "static" });
  });

  it("fails fast with E_PLATFORM before creating an env when Ruby is missing", async () => {
    const bin = await tempDir("fallback-bin");
    const git = (await runCommand("sh", ["-c", "command -v git"])).stdout.trim();
    await symlink(git, path.join(bin, "git"));
    const state = await tempDir("fallback-state");
    const repo = await initGitRepo({ Gemfile: `gem "rails"\n` });
    vi.stubEnv("PATH", bin);
    try {
      await expect(new NectarService(state).publish({ repo })).rejects.toMatchObject({
        code: "E_PLATFORM",
        details: { missing: ["ruby", "bundle"] },
      });
      const plan = await new NectarService(state).publish({ repo, dryRun: true });
      expect(plan).toMatchObject({ stack: "rails", missing: ["ruby", "bundle"] });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(existsSync(path.join(state, "envs")) ? await readdir(path.join(state, "envs")) : []).toEqual([]);
  });
});
