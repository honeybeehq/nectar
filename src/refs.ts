import { NectarError } from "./errors.js";
import type { Mode } from "./types.js";

export interface NectarRef {
  host: string;
  env: string;
}

const PART = /^[a-z0-9][a-z0-9-]*(?:--[a-z0-9][a-z0-9-]*)+$/;

export function branchSlug(branch: string): string {
  const slug = branch
    .toLowerCase()
    .replaceAll("/", "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) throw new NectarError("E_CHECKOUT", `Branch '${branch}' cannot form an env name`);
  return slug;
}

export function appSlug(app: string): string {
  return branchSlug(app);
}

export function envBaseName(app: string, branch: string): string {
  return `${appSlug(app)}--${branchSlug(branch)}`;
}

export function envName(app: string, branch: string, mode: Mode): string {
  return `${envBaseName(app, branch)}--${mode}`;
}

export function formatRef(host: string, env: string): string {
  const normalizedHost = host.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  if (!normalizedHost || !PART.test(env)) throw new NectarError("E_NOT_FOUND", "Cannot form nectar ref");
  return `nectar://${normalizedHost}/${env}`;
}

export function parseRef(value: string): NectarRef {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NectarError("E_NOT_FOUND", `Invalid nectar ref '${value}'`);
  }
  const path = url.pathname.slice(1);
  if (
    url.protocol !== "nectar:" ||
    !url.hostname ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !PART.test(path) ||
    path.includes("/")
  ) {
    throw new NectarError("E_NOT_FOUND", `Invalid nectar ref '${value}'`);
  }
  return { host: url.hostname.toLowerCase(), env: path };
}

export function isRef(value: string): boolean {
  return value.startsWith("nectar://");
}

export function validateEnvName(value: string): string {
  if (!PART.test(value)) throw new NectarError("E_NOT_FOUND", `Invalid env name '${value}'`);
  return value;
}
