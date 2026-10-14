import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runningDaemonPid } from "./daemon.js";
import { PostgresProviders } from "./deps.js";
import { NectarError } from "./errors.js";
import { runGit } from "./git.js";
import type { NectarPaths } from "./paths.js";
import { atomicJson, StateStore } from "./state.js";
import { probeServeRights } from "./tailscale.js";
import type { MachineConfig, PoolCategory, PoolPolicy } from "./types.js";

export const POOL_CATEGORIES: readonly PoolCategory[] = ["web", "static"];
export const POOL_POLICIES: readonly PoolPolicy[] = ["first-healthy", "least-loaded"];
const PLACEMENTS_LOCK = "machine--placements";
const PROVIDER_CACHE_MS = 60_000;
const PROVIDER_WAIT_MS = 3_000;

export type MeshState = "ok" | "denied" | "unknown";
export type DepsProvider = "docker" | "local" | "none" | "unknown";

export interface Pool {
  hosts: string[];
  default_for: PoolCategory[];
  prefer: PoolPolicy;
}

export interface HostReport {
  version: string;
  nectard: { ok: boolean; pid: number | null };
  mesh: MeshState;
  deps: DepsProvider;
  envs: { total: number; serving: number };
  load: { load1: number; cpus: number; per_cpu: number };
}

export interface PoolProbe {
  host: string;
  local: boolean;
  report?: Partial<HostReport>;
  error?: { code: string; message: string };
}

export interface PoolNeed {
  postgres: boolean;
}

export interface PoolChoice {
  host: string | undefined;
  reason: string;
  skipped: Array<{ host: string; why: string }>;
}

export interface Placement {
  host: string;
  env: string;
  at: string;
}

function usage(message: string): NectarError {
  return new NectarError("E_USAGE", message, { hint: "nectar pool ls shows the pool; fix pool in nectar.json or use nectar pool add|rm" });
}

export function poolSettings(config: MachineConfig): Pool | undefined {
  const pool = config.pool as unknown;
  if (pool === undefined || pool === null) return undefined;
  if (typeof pool !== "object" || Array.isArray(pool)) throw usage("pool in nectar.json must be an object");
  const { hosts, default_for: categories, prefer } = pool as Record<string, unknown>;
  if (hosts !== undefined && (!Array.isArray(hosts) || hosts.some((host) => typeof host !== "string" || host.trim() === ""))) {
    throw usage("pool.hosts must be a list of node names");
  }
  if (categories !== undefined && (!Array.isArray(categories) || categories.some((category) => !POOL_CATEGORIES.includes(category as PoolCategory)))) {
    throw usage(`pool.default_for takes ${POOL_CATEGORIES.join(" and ")}; desktop, ios and dev envs always stay on the publishing host`);
  }
  if (prefer !== undefined && !POOL_POLICIES.includes(prefer as PoolPolicy)) throw usage(`pool.prefer must be ${POOL_POLICIES.join(" or ")}`);
  const list = [...new Set(((hosts as string[] | undefined) ?? []).map((host) => host.trim().toLowerCase()))];
  if (list.length === 0) return undefined;
  return {
    hosts: list,
    default_for: (categories as PoolCategory[] | undefined) ?? [...POOL_CATEGORIES],
    prefer: (prefer as PoolPolicy | undefined) ?? "first-healthy",
  };
}

let installVersion: Promise<string> | undefined;

export function nectarVersion(): Promise<string> {
  installVersion ??= (async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8").catch(() => "{}")) as { version?: unknown };
    const base = typeof pkg.version === "string" ? pkg.version : "0.0.0";
    const head = await runGit(["rev-parse", "--short", "HEAD"], root).catch(() => undefined);
    return head?.exitCode === 0 && head.stdout.trim() !== "" ? `${base}+${head.stdout.trim()}` : base;
  })();
  return installVersion;
}

let providerSeen: { at: number; provider: DepsProvider } | undefined;
let providerProbe: Promise<DepsProvider> | undefined;

export async function depsProvider(waitMs = PROVIDER_WAIT_MS): Promise<DepsProvider> {
  if (providerSeen !== undefined && Date.now() - providerSeen.at < PROVIDER_CACHE_MS) return providerSeen.provider;
  providerProbe ??= new PostgresProviders()
    .auto()
    .catch(() => undefined)
    .then((found) => {
      const provider: DepsProvider = found ?? "none";
      providerSeen = { at: Date.now(), provider };
      providerProbe = undefined;
      return provider;
    });
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), waitMs);
  });
  const provider = await Promise.race([providerProbe, waited]);
  clearTimeout(timer);
  return provider ?? providerSeen?.provider ?? "unknown";
}

export async function hostReport(paths: NectarPaths, daemonPid?: number): Promise<HostReport> {
  const [version, pid, rights, deps, records] = await Promise.all([
    nectarVersion(),
    daemonPid ?? runningDaemonPid(paths),
    probeServeRights(),
    depsProvider(),
    new StateStore(paths).listEnvs(),
  ]);
  const cpus = Math.max(os.availableParallelism(), 1);
  const load1 = os.loadavg()[0] ?? 0;
  return {
    version,
    nectard: { ok: pid !== undefined, pid: pid ?? null },
    mesh: rights.state === "allowed" ? "ok" : rights.state,
    deps,
    envs: { total: records.length, serving: records.filter((record) => record.status === "serving").length },
    load: { load1: Math.round(load1 * 100) / 100, cpus, per_cpu: Math.round((load1 / cpus) * 1000) / 1000 },
  };
}

function skipReason(probe: PoolProbe, need: PoolNeed): string | undefined {
  if (probe.error !== undefined) return `unhealthy: ${probe.error.message}`;
  const report = probe.report ?? {};
  if (report.nectard !== undefined && !report.nectard.ok) return "unhealthy: nectard is not running";
  if (report.mesh === "denied") return "mesh denied: not a Tailscale operator, so it cannot give the preview a tailnet URL";
  if (need.postgres && report.deps === "none") return "no [deps] postgres provider";
  return undefined;
}

function depsRank(report: Partial<HostReport> | undefined): number {
  if (report?.deps === "docker") return 0;
  if (report?.deps === "local") return 1;
  return 2;
}

function load(report: Partial<HostReport> | undefined): number {
  return report?.load?.per_cpu ?? Number.POSITIVE_INFINITY;
}

function describeLoad(report: Partial<HostReport> | undefined): string {
  if (report?.load === undefined) return "load unknown";
  return `load ${report.load.per_cpu} per CPU, ${report.envs?.serving ?? "?"} serving envs`;
}

export function choosePoolHost(probes: PoolProbe[], need: PoolNeed, prefer: PoolPolicy): PoolChoice {
  const skipped: PoolChoice["skipped"] = [];
  const usable: Array<{ probe: PoolProbe; index: number }> = [];
  probes.forEach((probe, index) => {
    const why = skipReason(probe, need);
    if (why === undefined) usable.push({ probe, index });
    else skipped.push({ host: probe.host, why });
  });
  const skippedText = skipped.length === 0 ? "" : `; skipped ${skipped.map((entry) => `${entry.host} (${entry.why})`).join(", ")}`;
  usable.sort((left, right) => {
    if (need.postgres) {
      const deps = depsRank(left.probe.report) - depsRank(right.probe.report);
      if (deps !== 0) return deps;
    }
    if (prefer === "least-loaded") {
      const byLoad = load(left.probe.report) - load(right.probe.report);
      if (byLoad !== 0 && !Number.isNaN(byLoad)) return byLoad;
      const byEnvs = (left.probe.report?.envs?.serving ?? Number.MAX_SAFE_INTEGER) - (right.probe.report?.envs?.serving ?? Number.MAX_SAFE_INTEGER);
      if (byEnvs !== 0) return byEnvs;
    }
    return left.index - right.index;
  });
  const chosen = usable[0]?.probe;
  if (chosen === undefined) return { host: undefined, reason: `no usable pool host${skippedText}`, skipped };
  const why: string[] = [];
  if (need.postgres) {
    const provider = chosen.report?.deps;
    why.push(provider === "docker" ? "it runs [deps] postgres in Docker" : provider === "local" ? "it runs [deps] postgres on a local server (no Docker host was usable)" : "its deps provider is unknown");
  }
  why.push(prefer === "least-loaded" ? `it is the least loaded (${describeLoad(chosen.report)})` : "it is the first healthy pool host");
  return { host: chosen.host, reason: `pool: ${chosen.host}, because ${why.join(" and ")}${skippedText}`, skipped };
}

function placementsFile(paths: NectarPaths): string {
  return path.join(paths.root, "placements.json");
}

export async function readPlacements(paths: NectarPaths): Promise<Record<string, Placement>> {
  try {
    const value = JSON.parse(await readFile(placementsFile(paths), "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, Placement] =>
          typeof entry[1] === "object" && entry[1] !== null && typeof (entry[1] as Placement).host === "string" && typeof (entry[1] as Placement).env === "string",
      ),
    );
  } catch {
    return {};
  }
}

export async function updatePlacements(paths: NectarPaths, change: (placements: Record<string, Placement>) => void): Promise<void> {
  const store = new StateStore(paths);
  await store.withLock(PLACEMENTS_LOCK, async () => {
    const placements = await readPlacements(paths);
    change(placements);
    await atomicJson(placementsFile(paths), placements);
  });
}
