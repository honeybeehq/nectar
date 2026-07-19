import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { parseDuration } from "./duration.js";
import { NectarError } from "./errors.js";
import { appSlug } from "./refs.js";
import type { DesktopRecipe, IosRecipe, Mode, Recipe, WebRecipe } from "./types.js";

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

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new NectarError("E_NO_RECIPE", `${label} must be a non-empty string`);
  }
  return value;
}

function parseWeb(value: unknown): WebRecipe | undefined {
  if (value === undefined) return undefined;
  const web = table(value, "[web]");
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
      "ready_timeout",
    ),
    env,
  };
}

function parseDesktop(value: unknown): DesktopRecipe | undefined {
  if (value === undefined) return undefined;
  const desktop = table(value, "[desktop]");
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

function parseIos(value: unknown): IosRecipe | undefined {
  if (value === undefined) return undefined;
  const ios = table(value, "[ios]");
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
      "ready_timeout",
    ),
  };
}

export async function loadRecipe(repo: string): Promise<Recipe> {
  const toml = await maybeRead(path.join(repo, "nectar.toml"));
  const fallbackName = appSlug(path.basename(repo));
  if (toml !== undefined) {
    let value: TomlTable;
    try {
      value = parse(toml);
    } catch (error) {
      throw new NectarError("E_NO_RECIPE", `Invalid nectar.toml: ${error instanceof Error ? error.message : String(error)}`);
    }
    const name = value.name === undefined ? fallbackName : appSlug(requiredString(value.name, "name"));
    const web = parseWeb(value.web);
    const desktop = parseDesktop(value.desktop);
    const ios = parseIos(value.ios);
    return {
      name,
      source: "nectar.toml",
      ...(web === undefined ? {} : { web }),
      ...(desktop === undefined ? {} : { desktop }),
      ...(ios === undefined ? {} : { ios }),
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
        web: { serve: pm === "npm" ? "npm run dev" : `${pm} dev`, readyPath: "/", readyTimeoutMs: 90_000, env: {} },
      };
    }
  }
  throw new NectarError("E_NO_RECIPE", "No nectar.toml and no package.json dev-script fallback found");
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
    if (requested !== "web" && requested !== "desktop" && requested !== "ios") {
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
  if (declared.length === 1) return declared[0] ?? "web";
  if (recipe.web !== undefined) return "web";
  throw new NectarError("E_NO_MODE", "Choose a declared mode with --mode web|desktop|ios");
}
