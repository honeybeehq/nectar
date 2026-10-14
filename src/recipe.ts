import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { parseDuration } from "./duration.js";
import { NectarError } from "./errors.js";
import { detectPython, detectRails, type FallbackHost } from "./fallbacks.js";
import { appSlug } from "./refs.js";
import type { DepRecipe, DesktopRecipe, DevRecipe, IosRecipe, Mode, Recipe, ScenarioRecipe, WebRecipe } from "./types.js";

type TomlTable = Record<string, unknown>;

async function maybeRead(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function table(value: unknown, label: string): TomlTable {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NectarError("E_NO_RECIPE", `${label} must be a TOML table`);
  }
  return value as TomlTable;
}

// A typo'd key silently falling back to a default (ready_timout → 90 s) is the
// worst kind of recipe bug; unknown keys fail loudly instead.
function rejectUnknownKeys(value: TomlTable, known: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new NectarError("E_NO_RECIPE", `Unknown key '${key}' in ${label}; expected one of: ${known.join(", ")}`);
    }
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new NectarError("E_NO_RECIPE", `${label} must be a non-empty string`);
  }
  return value;
}

function parseWeb(value: unknown): WebRecipe | undefined {
  if (value === undefined) return undefined;
  const web = table(value, "[web]");
  rejectUnknownKeys(web, ["serve", "ready_path", "ready_timeout", "env"], "[web]");
  const envValue = web.env === undefined ? {} : table(web.env, "[web].env");
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(envValue)) {
    if (typeof item !== "string") {
      throw new NectarError("E_NO_RECIPE", `[web].env.${key} must be a literal string in v0`);
    }
    env[key] = item;
  }
  return {
    serve: requiredString(web.serve, "[web].serve"),
    readyPath: web.ready_path === undefined ? "/" : requiredString(web.ready_path, "[web].ready_path"),
    readyTimeoutMs: parseDuration(
      web.ready_timeout === undefined ? "90s" : requiredString(web.ready_timeout, "[web].ready_timeout"),
      "[web].ready_timeout",
      "E_NO_RECIPE",
    ),
    env,
  };
}

function parseDesktop(value: unknown): DesktopRecipe | undefined {
  if (value === undefined) return undefined;
  const desktop = table(value, "[desktop]");
  rejectUnknownKeys(desktop, ["pack", "kind", "embed_url"], "[desktop]");
  const kind = desktop.kind;
  if (kind !== "electron" && kind !== "native") {
    throw new NectarError("E_NO_RECIPE", "[desktop].kind must be 'electron' or 'native'");
  }
  const embedUrl = desktop.embed_url;
  if (embedUrl !== undefined && typeof embedUrl !== "string") {
    throw new NectarError("E_NO_RECIPE", "[desktop].embed_url must be a string");
  }
  if (kind === "native" && embedUrl !== undefined) {
    throw new NectarError("E_NO_RECIPE", "[desktop].embed_url is supported only for kind='electron'");
  }
  return {
    pack: requiredString(desktop.pack, "[desktop].pack"),
    kind,
    ...(embedUrl === undefined ? {} : { embedUrl }),
  };
}

function parseDev(value: unknown): DevRecipe | undefined {
  if (value === undefined) return undefined;
  const dev = table(value, "[dev]");
  rejectUnknownKeys(dev, ["run", "kind", "warm", "ready_timeout"], "[dev]");
  if (dev.kind !== "electron") {
    throw new NectarError("E_NO_RECIPE", "[dev].kind must be 'electron'");
  }
  const warm = dev.warm;
  if (warm !== undefined && (typeof warm !== "string" || !warm.trim())) {
    throw new NectarError("E_NO_RECIPE", "[dev].warm must be a non-empty string");
  }
  return {
    run: requiredString(dev.run, "[dev].run"),
    kind: "electron",
    ...(warm === undefined ? {} : { warm }),
    readyTimeoutMs: parseDuration(
      dev.ready_timeout === undefined ? "60s" : requiredString(dev.ready_timeout, "[dev].ready_timeout"),
      "[dev].ready_timeout",
      "E_NO_RECIPE",
    ),
  };
}

function parseIos(value: unknown): IosRecipe | undefined {
  if (value === undefined) return undefined;
  const ios = table(value, "[ios]");
  rejectUnknownKeys(ios, ["pack", "bundle_id", "device", "runtime", "stream", "ready_timeout"], "[ios]");
  const bundleId = requiredString(ios.bundle_id, "[ios].bundle_id");
  if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) {
    throw new NectarError("E_NO_RECIPE", "[ios].bundle_id must be a reverse-DNS bundle identifier");
  }
  if (ios.stream !== undefined && typeof ios.stream !== "boolean") {
    throw new NectarError("E_NO_RECIPE", "[ios].stream must be a boolean");
  }
  return {
    pack: requiredString(ios.pack, "[ios].pack"),
    bundleId,
    device: ios.device === undefined ? "iPhone 17" : requiredString(ios.device, "[ios].device"),
    runtime: ios.runtime === undefined ? "latest" : requiredString(ios.runtime, "[ios].runtime"),
    stream: ios.stream === undefined ? true : ios.stream,
    readyTimeoutMs: parseDuration(
      ios.ready_timeout === undefined ? "90s" : requiredString(ios.ready_timeout, "[ios].ready_timeout"),
      "[ios].ready_timeout",
      "E_NO_RECIPE",
    ),
  };
}

const DEP_NAME = /^[a-z][a-z0-9_-]*$/;
const ENV_VAR = /^[A-Z_][A-Z0-9_]*$/;
const SQL_NAME = /^[a-z_][a-z0-9_]*$/;
const IMAGE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_POSTGRES_TAG = "17";

function optionalMatch(value: unknown, fallback: string, pattern: RegExp, label: string): string {
  if (value === undefined) return fallback;
  const text = requiredString(value, label);
  if (!pattern.test(text)) throw new NectarError("E_NO_RECIPE", `${label} '${text}' must match ${pattern.source}`);
  return text;
}

function parseDep(name: string, value: unknown): DepRecipe {
  const label = `[deps.${name}]`;
  const dep = table(value, label);
  if (dep.provision !== undefined || dep.teardown !== undefined) {
    throw new NectarError("E_NO_RECIPE", `${label} provision/teardown commands are not implemented yet; use kind = "postgres:<version>" or "sqlite"`);
  }
  const kind = requiredString(dep.kind, `${label}.kind`);
  if (kind === "sqlite") {
    rejectUnknownKeys(dep, ["kind", "path", "env"], label);
    const file = requiredString(dep.path, `${label}.path`);
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
      throw new NectarError("E_NO_RECIPE", `${label}.path must be a relative path inside the repository`);
    }
    return { kind: "sqlite", path: file, env: optionalMatch(dep.env, "DATABASE_PATH", ENV_VAR, `${label}.env`) };
  }
  if (kind === "postgres" || kind.startsWith("postgres:")) {
    rejectUnknownKeys(dep, ["kind", "env", "database", "user"], label);
    const tag = kind === "postgres" ? DEFAULT_POSTGRES_TAG : kind.slice("postgres:".length);
    if (!IMAGE_TAG.test(tag)) throw new NectarError("E_NO_RECIPE", `${label}.kind has an invalid postgres version '${tag}'`);
    return {
      kind: "postgres",
      image: `postgres:${tag}`,
      env: optionalMatch(dep.env, "DATABASE_URL", ENV_VAR, `${label}.env`),
      database: optionalMatch(dep.database, "app", SQL_NAME, `${label}.database`),
      user: optionalMatch(dep.user, "nectar", SQL_NAME, `${label}.user`),
    };
  }
  throw new NectarError("E_NO_RECIPE", `${label}.kind '${kind}' is not supported yet; use "postgres:<version>" or "sqlite"`);
}

function parseDeps(value: unknown): Record<string, DepRecipe> | undefined {
  if (value === undefined) return undefined;
  const deps = table(value, "[deps]");
  if (deps.compose !== undefined) {
    throw new NectarError("E_NO_RECIPE", '[deps].compose is not implemented yet; declare [deps.<name>] with kind = "postgres:<version>" or "sqlite"');
  }
  const parsed: Record<string, DepRecipe> = {};
  const injected = new Set<string>();
  for (const [name, item] of Object.entries(deps)) {
    if (!DEP_NAME.test(name)) throw new NectarError("E_NO_RECIPE", `[deps.${name}] name must match ${DEP_NAME.source}`);
    const dep = parseDep(name, item);
    if (injected.has(dep.env)) throw new NectarError("E_NO_RECIPE", `Two [deps] entries inject ${dep.env}; give one of them another env`);
    injected.add(dep.env);
    parsed[name] = dep;
  }
  return parsed;
}

function parseScenarios(value: unknown): Record<string, ScenarioRecipe> | undefined {
  if (value === undefined) return undefined;
  const scenarios = table(value, "[scenarios]");
  const parsed: Record<string, ScenarioRecipe> = {};
  for (const [name, item] of Object.entries(scenarios)) {
    const label = `[scenarios.${name}]`;
    if (!DEP_NAME.test(name)) throw new NectarError("E_NO_RECIPE", `${label} name must match ${DEP_NAME.source}`);
    const scenario = table(item, label);
    for (const deferred of ["entry", "login"]) {
      if (scenario[deferred] !== undefined) {
        throw new NectarError("E_NO_RECIPE", `${label}.${deferred} is not implemented yet and would be silently ignored; only seed and default are`);
      }
    }
    rejectUnknownKeys(scenario, ["seed", "default"], label);
    if (scenario.default !== undefined && typeof scenario.default !== "boolean") {
      throw new NectarError("E_NO_RECIPE", `${label}.default must be a boolean`);
    }
    parsed[name] = {
      ...(scenario.seed === undefined ? {} : { seed: requiredString(scenario.seed, `${label}.seed`) }),
      default: scenario.default === true,
    };
  }
  if (Object.values(parsed).filter((scenario) => scenario.default).length > 1) {
    throw new NectarError("E_NO_RECIPE", "At most one [scenarios.<name>] may set default = true");
  }
  return parsed;
}

export function seedScenario(recipe: Recipe): { name: string; seed: string } | undefined {
  const entries = Object.entries(recipe.scenarios ?? {});
  const chosen = entries.find(([, scenario]) => scenario.default) ?? (entries.length === 1 ? entries[0] : undefined);
  if (chosen?.[1].seed === undefined) return undefined;
  return { name: chosen[0], seed: chosen[1].seed };
}

export async function loadRecipe(repo: string, host?: FallbackHost): Promise<Recipe> {
  const toml = await maybeRead(path.join(repo, "nectar.toml"));
  const fallbackName = appSlug(path.basename(repo));
  if (toml !== undefined) {
    let value: TomlTable;
    try {
      value = parse(toml);
    } catch (error) {
      throw new NectarError("E_NO_RECIPE", `Invalid nectar.toml: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A [secrets]/[cli]/[backend] section silently ignored means an app running
    // without its declared secrets or a mode the caller believes exists — fail
    // loudly until v0.1 implements them.
    for (const section of ["secrets", "cli", "backend"]) {
      if (value[section] !== undefined) {
        throw new NectarError("E_NO_RECIPE", `[${section}] is deferred to v0.1 and would be silently ignored; remove it from nectar.toml`);
      }
    }
    rejectUnknownKeys(value, ["name", "web", "desktop", "ios", "dev", "deps", "scenarios"], "nectar.toml");
    const name = value.name === undefined ? fallbackName : appSlug(requiredString(value.name, "name"));
    const web = parseWeb(value.web);
    const desktop = parseDesktop(value.desktop);
    const ios = parseIos(value.ios);
    const dev = parseDev(value.dev);
    const deps = parseDeps(value.deps);
    const scenarios = parseScenarios(value.scenarios);
    return {
      name,
      source: "nectar.toml",
      ...(web === undefined ? {} : { web }),
      ...(desktop === undefined ? {} : { desktop }),
      ...(ios === undefined ? {} : { ios }),
      ...(dev === undefined ? {} : { dev }),
      ...(deps === undefined ? {} : { deps }),
      ...(scenarios === undefined ? {} : { scenarios }),
    };
  }

  const packageText = await maybeRead(path.join(repo, "package.json"));
  if (packageText !== undefined) {
    let pkg: { name?: unknown; scripts?: Record<string, unknown>; packageManager?: unknown };
    try {
      pkg = JSON.parse(packageText) as typeof pkg;
    } catch (error) {
      throw new NectarError("E_NO_RECIPE", `Invalid package.json: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof pkg.scripts?.dev === "string") {
      const pm = detectPackageManager(repo, pkg.packageManager);
      const packageName = typeof pkg.name === "string" ? pkg.name.replace(/^@[^/]+\//, "") : fallbackName;
      return {
        name: appSlug(packageName),
        source: "package.json",
        detected: { stack: "node", reason: `package.json has a dev script; ${pm} chosen from packageManager/lockfile` },
        web: { serve: pm === "npm" ? "npm run dev" : `${pm} dev`, readyPath: "/", readyTimeoutMs: 90_000, env: {} },
      };
    }
  }
  const python = await detectPython(repo, fallbackName, host);
  if (python !== undefined) return python;
  const rails = await detectRails(repo, fallbackName);
  if (rails !== undefined) return rails;
  throw new NectarError(
    "E_NO_RECIPE",
    "No nectar.toml, no package.json dev script, no Python app (Django manage.py, FastAPI/Starlette or Flask entrypoint) and no Rails Gemfile found",
  );
}

function detectPackageManager(repo: string, packageManager: unknown): "pnpm" | "yarn" | "npm" {
  if (typeof packageManager === "string") {
    if (packageManager.startsWith("pnpm@")) return "pnpm";
    if (packageManager.startsWith("yarn@")) return "yarn";
  }
  if (existsSync(path.join(repo, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(repo, "yarn.lock"))) return "yarn";
  return "npm";
}

export function selectMode(recipe: Recipe, requested?: string): Mode {
  if (requested !== undefined) {
    if (requested === "cli" || requested === "backend") {
      throw new NectarError("E_NO_MODE", `Mode '${requested}' is deferred to v0.1`);
    }
    if (requested !== "web" && requested !== "desktop" && requested !== "ios" && requested !== "dev") {
      throw new NectarError("E_NO_MODE", `Mode '${requested}' is not supported`);
    }
    if (recipe[requested] === undefined) {
      throw new NectarError("E_NO_RECIPE", `Recipe does not declare [${requested}]`);
    }
    return requested;
  }
  const declared: Mode[] = [];
  if (recipe.web !== undefined) declared.push("web");
  if (recipe.desktop !== undefined) declared.push("desktop");
  if (recipe.ios !== undefined) declared.push("ios");
  if (recipe.dev !== undefined) declared.push("dev");
  if (declared.length === 1) return declared[0] ?? "web";
  if (recipe.web !== undefined) return "web";
  throw new NectarError("E_NO_MODE", "Choose a declared mode with --mode web|desktop|ios|dev");
}
