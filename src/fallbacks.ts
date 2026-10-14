import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { NectarError } from "./errors.js";
import { appSlug } from "./refs.js";
import type { Recipe } from "./types.js";

export const VENV = ".nectar/venv";
export const BUNDLE_PATH = ".nectar/bundle";
const PYTHON = `${VENV}/bin/python`;

export const PYTHON_ENTRY_FILES = [
  "app.py",
  "main.py",
  "server.py",
  "api.py",
  "asgi.py",
  "wsgi.py",
  "app/main.py",
  "app/app.py",
  "app/__init__.py",
];

export interface FallbackHost {
  hasCommand(name: string): boolean;
}

export function pathHost(searchPath = process.env.PATH ?? ""): FallbackHost {
  return {
    hasCommand: (name) =>
      searchPath
        .split(path.delimiter)
        .filter(Boolean)
        .some((dir) => existsSync(path.join(dir, name))),
  };
}

export function missingCommands(recipe: Recipe, host: FallbackHost = pathHost()): string[] {
  return (recipe.web?.requires ?? []).filter((name) => !host.hasCommand(name));
}

export function assertRuntimes(recipe: Recipe, host: FallbackHost = pathHost()): void {
  const missing = missingCommands(recipe, host);
  if (missing.length === 0) return;
  const stack = recipe.detected?.stack ?? recipe.source;
  const hint =
    stack === "rails"
      ? "install Ruby and Bundler on this host (`gem install bundler`), publish from a node that has them, or declare [web] serve in nectar.toml"
      : "install it on this host, publish from a node that has it, or declare [web] serve in nectar.toml";
  throw new NectarError("E_PLATFORM", `The ${stack} fallback needs ${missing.join(", ")} on PATH, not found on this host: ${hint}`, {
    missing,
    hint,
  });
}

async function maybeRead(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return undefined;
    throw error;
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function moduleName(file: string): string {
  return file.replace(/\.py$/, "").replace(/\/__init__$/, "").replaceAll("/", ".");
}

interface PythonEntry {
  stack: "django" | "asgi" | "flask";
  serve: string;
  reason: string;
  needsUvicorn: boolean;
}

async function pythonEntry(repo: string, depsText: string): Promise<PythonEntry | undefined> {
  if (existsSync(path.join(repo, "manage.py"))) {
    return {
      stack: "django",
      serve: `exec ${PYTHON} manage.py runserver --noreload 127.0.0.1:"$PORT"`,
      reason: "manage.py at the repo root",
      needsUvicorn: false,
    };
  }
  const sources: Array<{ file: string; text: string }> = [];
  for (const file of PYTHON_ENTRY_FILES) {
    const text = await maybeRead(path.join(repo, file));
    if (text !== undefined) sources.push({ file, text });
  }
  for (const { file, text } of sources) {
    const match = /^(\w+)\s*(?::\s*[\w.]+\s*)?=\s*(?:fastapi\.|starlette\.applications\.)?(FastAPI|Starlette)\(/m.exec(text);
    if (match === null) continue;
    const target = `${moduleName(file)}:${match[1] ?? "app"}`;
    return {
      stack: "asgi",
      serve: `exec ${PYTHON} -m uvicorn ${target} --host 127.0.0.1 --port "$PORT"`,
      reason: `${file} assigns ${match[1] ?? "app"} = ${match[2] ?? "FastAPI"}(...)`,
      needsUvicorn: !/\buvicorn\b/i.test(depsText),
    };
  }
  for (const { file, text } of sources) {
    if (!/\bFlask\(/.test(text)) continue;
    const variable = /^(\w+)\s*(?::\s*[\w.]+\s*)?=\s*(?:flask\.)?Flask\(/m.exec(text)?.[1];
    const target = variable === undefined ? moduleName(file) : `${moduleName(file)}:${variable}`;
    return {
      stack: "flask",
      serve: `exec ${PYTHON} -m flask --app ${target} run --host 127.0.0.1 --port "$PORT"`,
      reason: variable === undefined ? `${file} calls Flask(...)` : `${file} assigns ${variable} = Flask(...)`,
      needsUvicorn: false,
    };
  }
  return undefined;
}

function pyprojectDependencies(text: string): { name?: string; deps: string[] } {
  let value: Record<string, unknown>;
  try {
    value = parse(text);
  } catch (error) {
    throw new NectarError("E_NO_RECIPE", `Invalid pyproject.toml: ${error instanceof Error ? error.message : String(error)}`);
  }
  const project = value.project as { name?: unknown; dependencies?: unknown } | undefined;
  const deps = Array.isArray(project?.dependencies) ? project.dependencies.filter((dep): dep is string => typeof dep === "string") : [];
  return { ...(typeof project?.name === "string" ? { name: project.name } : {}), deps };
}

export async function detectPython(repo: string, fallbackName: string, host: FallbackHost = pathHost()): Promise<Recipe | undefined> {
  const requirements = await maybeRead(path.join(repo, "requirements.txt"));
  const pyprojectText = await maybeRead(path.join(repo, "pyproject.toml"));
  if (requirements === undefined && pyprojectText === undefined) return undefined;
  const pyproject = pyprojectText === undefined ? undefined : pyprojectDependencies(pyprojectText);
  const entry = await pythonEntry(repo, `${requirements ?? ""}\n${pyprojectText ?? ""}`);
  if (entry === undefined) return undefined;

  const useUv = host.hasCommand("uv");
  const lock = useUv && pyproject !== undefined && existsSync(path.join(repo, "uv.lock"));
  const source = lock || requirements === undefined ? "pyproject.toml" : "requirements.txt";
  const extra = entry.needsUvicorn ? ["uvicorn"] : [];
  const steps: string[] = [];
  if (useUv) {
    if (lock) {
      steps.push(`UV_PROJECT_ENVIRONMENT=${VENV} uv sync --frozen --no-dev`);
      if (extra.length > 0) steps.push(`uv pip install --python ${PYTHON} ${extra.join(" ")}`);
    } else {
      steps.push(`uv venv --allow-existing ${VENV}`);
      const input = requirements === undefined ? "-r pyproject.toml" : "-r requirements.txt";
      steps.push(`uv pip install --python ${PYTHON} ${[input, ...extra].join(" ")}`);
    }
  } else {
    steps.push(`{ [ -x ${PYTHON} ] || python3 -m venv ${VENV}; }`);
    const args = requirements === undefined ? (pyproject?.deps ?? []).map(quote) : ["-r requirements.txt"];
    const install = [...args, ...extra];
    if (install.length > 0) steps.push(`${PYTHON} -m pip install --disable-pip-version-check ${install.join(" ")}`);
  }
  const installer = useUv ? (lock ? "uv sync (uv.lock)" : "uv pip") : "python3 -m venv + pip";
  return {
    name: appSlug(pyproject?.name ?? fallbackName),
    source,
    detected: { stack: entry.stack === "asgi" ? "fastapi" : entry.stack, reason: `${source} + ${entry.reason}; deps via ${installer} into ${VENV}` },
    web: {
      serve: entry.serve,
      build: steps.join(" && "),
      requires: [useUv ? "uv" : "python3"],
      readyPath: "/",
      readyTimeoutMs: 90_000,
      env: {},
    },
  };
}

export async function detectRails(repo: string, fallbackName: string): Promise<Recipe | undefined> {
  const gemfile = await maybeRead(path.join(repo, "Gemfile"));
  if (gemfile === undefined || !/^\s*gem\s+["']rails["']/m.test(gemfile)) return undefined;
  const rails = existsSync(path.join(repo, "bin", "rails")) ? "bin/rails" : "bundle exec rails";
  return {
    name: appSlug(fallbackName),
    source: "Gemfile",
    detected: { stack: "rails", reason: `Gemfile declares gem "rails"; gems via bundle install into ${BUNDLE_PATH}` },
    web: {
      serve: `rm -f .nectar/server.pid && BUNDLE_PATH=${BUNDLE_PATH} exec ${rails} server -b 127.0.0.1 -p "$PORT" --pid .nectar/server.pid`,
      build: `mkdir -p .nectar && BUNDLE_PATH=${BUNDLE_PATH} bundle install`,
      requires: ["ruby", "bundle"],
      readyPath: "/",
      readyTimeoutMs: 90_000,
      env: {},
    },
  };
}
