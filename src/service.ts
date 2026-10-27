import crypto from "node:crypto";
import { runningDaemonPid } from "./daemon.js";
import { upstreamOf, type Upstream } from "./proxy.js";
import os from "node:os";
import { availableMemory, previewMemoryAvailable, PREVIEW_MEMORY_BYTES } from "./capacity.js";
import { previewProofState, PROOF_GRACE_MS } from "./proofs.js";
import { ownerState, protectedPreview } from "./owner.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { existsSync } from "node:fs";
import { readFile, appendFile, copyFile, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import {
  archiveCommit,
  currentBranch,
  installDependencies,
  prepareWorktree,
  removeWorktree,
  resolveBranch,
  resolveCommit,
  resolveRepo,
  runGit,
  gitIgnored,
  inCommit,
  uncommitted,
  sameRepository,
  shortCommit,
  sourceIdentity,
  type BranchSlot,
} from "./git.js";
import { allocatePort, portAvailable, portOpen, portOpenOnHost } from "./ports.js";
import {
  currentPublisher,
  pidAlive,
  groupBelongsToEnv,
  ownershipRefusal,
  legacyProcessIdentity,
  groupAlive,
  runCommand,
  runShell,
  scrubbedEnvironment,
  spawnDetached,
  spawnDetachedExecutable,
  stopEnvGroup,
} from "./commands.js";
import { expiresAt, formatRemaining, parseDuration } from "./duration.js";
import { asNectarError, isErrorCode, NectarError } from "./errors.js";
import { appSlug, envName, formatRef, isRef, parseRef, validateEnvName, branchSlug } from "./refs.js";
import { loadRecipe, seedScenario, selectMode } from "./recipe.js";
import {
  composeFile,
  composeProject,
  composeSpec,
  composeUp,
  depEnvironment,
  depsDir,
  DOCKER_HINT,
  newPassword,
  postgresServices,
  PostgresProviders,
  readSecrets,
  redactedDeps,
  removeLabelled,
  assertProjectOwned,
  stopLabelled,
  usesDockerPostgres,
  usesLocalPostgres,
  writePrivateJson,
  type PostgresChoice,
} from "./deps.js";
import {
  clusterMajors,
  clusterOwnershipWarning,
  createDatabaseSql,
  dropDatabaseSql,
  ensureCluster,
  findPgInstalls,
  LOCAL_PG_HINT,
  pgIdentifier,
  stopCluster,
  superuserSql,
  type PgInstall,
} from "./pg-local.js";
import { assertRuntimes, missingCommands } from "./fallbacks.js";
import { getPaths, type NectarPaths } from "./paths.js";
import { StateStore } from "./state.js";
import { logTail, prepareLog, rotateLog } from "./logs.js";
import {
  apiNote,
  loopbackProxy,
  OPERATOR_HINT,
  probeServeRights,
  remoteNectar,
  resolveTailscale,
  rootMount,
  serveEntries,
  servePackStore,
  serveStatus,
  serveDenied,
  serveWeb,
  statusHasFunnel,
  statusHasPort,
  statusHasProxyTarget,
  statusPorts,
  stopServe,
  TAILSCALE_FALLBACKS,
  tailnetStatus,
  type ServeOutcome,
} from "./tailscale.js";
import { createTestpackZip, currentPlatform, extractAndLaunch, extractTestpack, extractVerified, fetchVerified, fileSize, pathExists, readAndValidateManifest, sha256, writeManifest } from "./testpack.js";
import { trashPaths } from "./files.js";
import { givenUp, hasProbeableServe, holdsRuntime, portAnswers, probeLiveness } from "./liveness.js";
import {
  classifyServeEntry,
  commandTools,
  guardSharedPorts,
  inTailnetRange,
  serveEntryOwner,
  type ClassifiedServeEntry,
  type DoctorAction,
  type DoctorCheck,
} from "./doctor.js";
import { installUnit, onPath, readInstalledUnit, unitSpec, unitStatus } from "./daemon-unit.js";
import { pidFile } from "./daemon.js";
import { probeProxy } from "./proxy.js";
import { ensureSharedStatic, staticPrefix } from "./shared-static.js";
import { findStaticSite, stageStaticSite, STATIC_ROOTS, staticFiles, type StaticSite } from "./static-site.js";
import { linksLeaving, MAX_TREE_BYTES, packFiles } from "./archive.js";
import { describeDiscovery, discoveryReport } from "./localapi.js";
import { callRemote, helloRemote, listenerCheck, MAX_ARCHIVE_BYTES, sourceDir, type RemoteOp } from "./remote.js";
import { choosePoolHost, hostReport, poolSettings, POOL_CATEGORIES, POOL_POLICIES, readPlacements, updatePlacements, type PoolProbe } from "./pool.js";
import { findStaleStaging, gcTransition, packCandidates, selectEvidencePrunes, selectPackPrunes, type GcTransition } from "./gc.js";
import {
  bootSim,
  createSimDevice,
  deleteSim,
  installSimApp,
  iosSimPlatform,
  isAppleSiliconMac,
  launchSimApp,
  listDevices,
  listDeviceTypes,
  listRuntimes,
  selectDeviceType,
  selectRuntime,
  serveSimCommand,
  shutdownSim,
} from "./sim.js";
import { ensureAxHelper, findAppPid } from "./ax.js";
import { exposureSub, relayAdd, relaydCreate, relaydDelete, relaydMine, relaydName, relaydRotate, relaydUpdate, relayHealth, relayRm, usesRelayd, type RelaydRoute } from "./relay.js";
import type {
  ExposureTarget,
  DepRecord,
  DesktopRecipe,
  DevRecipe,
  EnvRecord,
  EnvStatus,
  EnvUrls,
  IosRecipe,
  MachineConfig,
  Mode,
  MultiResolveResult,
  PacketFields,
  Publisher,
  Recipe,
  ResolveResult,
  ServeRecord,
  TestpackManifest,
  WebRecipe,
} from "./types.js";

const DEFAULT_TTL = "7d";

// Machine-wide lock name for the allocate→spawn→record window; env names always
// carry a --<mode> suffix, so this can never collide with a real env's lock.
const PORTS_LOCK = "machine--ports";

interface PublishOptions {
  repo?: string;
  mode?: string;
  branch?: string;
  ttl?: string;
  worktree?: string;
  packet?: string;
  verify?: boolean;
  name?: string;
  dryRun?: boolean;
  fresh?: boolean;
  host?: string;
  local?: boolean;
  received?: boolean;
  public?: boolean;
}

interface PublishShape {
  category: string;
  env: string;
  key: string;
  postgres: boolean;
  uncommitted?: string;
}

interface Shipment {
  archive: Buffer;
  payload: Record<string, unknown>;
}

interface PlacementDecision {
  host: string | undefined;
  reason: string;
  key?: string;
}

interface MachineIdentity {
  host: string;
  dnsName?: string;
  online: boolean;
  offline?: string;
  config: MachineConfig;
}

interface PublishedWeb {
  record: EnvRecord;
  warnings: string[];
  meshError: string | null;
}

function meshWarning(outcome: ServeOutcome | undefined, fallback: string, offline: string | undefined): string {
  if (outcome === undefined) return `tailscale unavailable: ${offline ?? "no tailnet DNS name recorded"} — ${fallback}`;
  const quoted = outcome.message.replace(/\s*\n\s*/g, " ") || "no output";
  if (serveDenied(outcome.message)) {
    return `tailscale serve was denied: "${quoted}" — ${fallback}. This user is not a Tailscale operator; run once: ${OPERATOR_HINT} (Nectar never runs sudo)`;
  }
  return `tailscale serve failed: "${quoted}" — ${fallback}`;
}

function movedWarning(previous: number | undefined, tailnetPort: number): string[] {
  if (previous === undefined) return [];
  return [`tailscale serve :${previous} now holds an entry Nectar did not create; left it alone and moved this env to :${tailnetPort}, so its mesh URL changed`];
}

function packetFieldsFor(mode: Mode, ref: string, urls: EnvUrls, publicUrl: string | null): PacketFields {
  return {
    preview_url: mode === "web" || mode === "ios" ? urls.mesh ?? urls.local : null,
    testpack_ref: mode === "desktop" || mode === "ios" ? ref : null,
    dev_ref: mode === "dev" ? ref : null,
    shell_recipe: null,
    public_url: publicUrl,
  };
}

export interface ReviveResult {
  revived: boolean;
  reason: string;
  pid?: number;
  mesh?: boolean;
}

interface GcReport {
  dry_run: boolean;
  transitions: Array<{ env: string; action: GcTransition }>;
  serve_orphans: Array<{ tailnet_port: number; target: string; env: string | null; reason: string; fixed: boolean; direct?: string }>;
  skipped: Array<{ env: string; reason: string }>;
  packs_pruned: Array<{ file: string; size_bytes: number }>;
  staging_pruned: string[];
  evidence_pruned: string[];
  exposures: Array<{ env: string; action: "patched" | "unchanged" | "revoked" | "unreachable" | "skipped"; reason?: string; expires_at?: string }>;
  ran_at: string;
}

interface DeadHolder {
  env: string;
  status: EnvStatus;
  expires_at: string;
  process: boolean;
  ownership_refusal?: string;
  pgid: number;
  serve_entry: number | null;
}

interface NectardState {
  problem?: "missing" | "other-home" | "stale" | "inactive";
  facts?: Record<string, unknown>;
  check?: DoctorCheck;
  unitPath?: string;
}

interface Diagnosis {
  healthy: boolean;
  checks: DoctorCheck[];
  config: MachineConfig;
  online: boolean;
  serveDenied: boolean;
  funnelOn: boolean;
  gcPlan: GcReport;
  gcOverdue: boolean;
  holders: DeadHolder[];
  nectard: NectardState;
  packServerLive: boolean;
  proxyPresent: boolean;
}

function liveExposureUrl(record: EnvRecord | undefined): string | null {
  return record?.exposure === undefined || record.exposure.revoked_at !== undefined ? null : record.exposure.url;
}

const SECRET_FIELDS = ["share_url", "share_note", "password", "credentials"];

function shareNote(password: string): string {
  return `Open the url and sign in as reviewer with password ${password}. Share this only with the person who should see the preview.`;
}

export function defaultExposure(exposures: Record<string, ExposureTarget> | undefined): string {
  const entries = Object.entries(exposures ?? {});
  const marked = entries.filter(([, target]) => target.default === true);
  if (marked.length > 1) throw new NectarError("E_EXPOSE", `More than one exposure target is marked default (${marked.map(([name]) => name).join(", ")})`);
  const chosen = marked[0] ?? (entries.length === 1 ? entries[0] : entries.find(([name]) => name === "site"));
  if (chosen === undefined) throw new NectarError("E_EXPOSE", "No default exposure target in machine config (~/.nectar/nectar.json → exposures, mark one \"default\": true)");
  return chosen[0];
}

const DEAD_STATUSES: ReadonlySet<EnvStatus> = new Set(["expired", "cold", "stopped", "crashed"]);

type SweptOrphan = GcReport["serve_orphans"][number];

function orphanAction(orphan: SweptOrphan): DoctorAction {
  return {
    action: orphan.direct === undefined ? "remove-serve-entry" : "repoint-serve-entry",
    target: `:${orphan.tailnet_port}`,
    reason: orphan.reason,
    status: "planned",
    before: { tailnet_port: orphan.tailnet_port, target: orphan.target, env: orphan.env },
    after: null,
  };
}

function isOrphanAction(action: DoctorAction): boolean {
  return action.action === "remove-serve-entry" || action.action === "repoint-serve-entry";
}

function settleOrphanAction(action: DoctorAction, swept: SweptOrphan[]): void {
  const port = Number(action.target.slice(1));
  const done = swept.find((orphan) => orphan.tailnet_port === port);
  action.status = done?.fixed === true ? "done" : "failed";
  action.after = done?.direct === undefined ? { present: done?.fixed !== true } : { tailnet_port: port, target: done.fixed ? done.direct : done.target };
}

function staticWebRecipe(): WebRecipe {
  const entry = process.env.NECTAR_STATIC_SERVER_ENTRY ?? fileURLToPath(new URL("./static-server.js", import.meta.url));
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  return { serve: `exec ${quote(process.execPath)} ${quote(entry)}`, readyPath: "/", readyTimeoutMs: 15_000, env: {} };
}

function isStaticServe(command: string): boolean {
  return command.includes("static-server.");
}

function staticServeRoot(command: string, worktree: string): string {
  const match = /(?:^|\s)(?:"[^"]*static-server\.(?:js|ts)"|'[^']*static-server\.(?:js|ts)'|[^\s'"]*static-server\.(?:js|ts))(?:\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+)))?/.exec(command);
  return path.resolve(worktree, match?.[1] ?? match?.[2] ?? match?.[3] ?? ".");
}

function ownsLoopbackPort(serve: ServeRecord | undefined, port: number | undefined): boolean {
  return port !== undefined && (serve?.upstream_port === port || serve?.proxy_port === port);
}

function loopbackPorts(records: EnvRecord[]): Set<number> {
  return new Set(
    records
      .flatMap((record) => [record.serve?.upstream_port, record.serve?.proxy_port, record.serve?.tailnet_port, ...depPorts(record)])
      .filter((port): port is number => port !== undefined),
  );
}

function depPorts(record: EnvRecord): number[] {
  return Object.values(record.deps ?? {})
    .map((dep) => dep.port)
    .filter((port): port is number => port !== undefined);
}

function hostAliases(value: string | undefined): Set<string> {
  if (value === undefined) return new Set();
  const normalized = value.trim().toLowerCase().replace(/\.+$/, "");
  if (normalized.length === 0) return new Set();
  const short = normalized.split(".")[0];
  return new Set(short === undefined ? [normalized] : [normalized, short]);
}

const capacitySleeping = new Set<string>();
const capacityLogs = new Map<string, Promise<void>>();
const capacityActivity = new Map<string, (name: string) => { active: boolean; viewedAt?: number; known?: boolean }>();

export class NectarService {
  readonly paths: NectarPaths;
  readonly store: StateStore;

  private activity(name: string): { active: boolean; viewedAt?: number; known?: boolean } {
    return capacityActivity.get(this.paths.root)?.(name) ?? { active: true, known: false };
  }

  setCapacityActivity(activity: (name: string) => { active: boolean; viewedAt?: number; known?: boolean }): void {
    capacityActivity.set(this.paths.root, activity);
  }

  private async memoryAvailable(): Promise<boolean> {
    const budget = Number(process.env.NECTAR_TEST_RUNTIME_MEMORY_BYTES);
    if (Number.isFinite(budget) && budget > 0) {
      const running = (await this.store.listEnvs()).filter((record) => record.mode === "web" && record.static_route === undefined && record.serve !== undefined && !record.serve.cmd.includes("static-server.") && record.serve.pid > 1).length;
      return (running + 1) * PREVIEW_MEMORY_BYTES <= budget;
    }
    return previewMemoryAvailable(await availableMemory());
  }

  private logCapacity(event: Record<string, unknown>): Promise<void> {
    const file = path.join(this.paths.root, "capacity.jsonl");
    const writing = (capacityLogs.get(this.paths.root) ?? Promise.resolve()).then(async () => {
      const config = await this.store.readConfig();
      await rotateLog(file, config.log_max_bytes, this.paths.root);
      await appendFile(file, `${JSON.stringify(event)}\n`);
    }).catch(() => undefined);
    capacityLogs.set(this.paths.root, writing);
    return writing;
  }

  private async recoverCapacity<T>(exclude: string | undefined, action: () => Promise<T>, slept: string[]): Promise<T> {
    for (;;) {
      try {
        return await action();
      } catch (error) {
        if (!(error instanceof NectarError) || !["E_QUOTA", "E_PORTS"].includes(error.code)) throw error;
        const viewed = (record: EnvRecord): number => Math.max(this.activity(record.name).viewedAt ?? 0, record.last_viewed_at === undefined ? 0 : Date.parse(record.last_viewed_at)) || Date.parse(record.published_at);
        const skipped = (record: EnvRecord): string | null => {
          if (record.name === exclude) return "requested_preview";
          if (record.mode !== "web") return "not_web";
          if (record.static_route !== undefined || record.serve?.cmd.includes("static-server.")) return "static";
          if (!holdsRuntime(record.status) || record.serve === undefined || record.serve.pid <= 1) return "not_running";
          if (record.serve.proxy_port === undefined) return "no_proxy";
          if (protectedPreview(record)) return record.pinned === true ? "pinned" : "main_bench";
          const activity = this.activity(record.name);
          if (activity.known === false) return "activity_unknown";
          if (activity.active) return "active_request";
          return null;
        };
        const candidates = (await this.store.listEnvs()).sort((a, b) => viewed(a) - viewed(b) || a.name.localeCompare(b.name)).map((record) => ({
          env: record.name,
          last_viewed_at: new Date(viewed(record)).toISOString(),
          view_source: this.activity(record.name).viewedAt === viewed(record) ? "live" : record.last_viewed_at !== undefined ? "persisted" : "published_fallback",
          persisted_last_viewed_at: record.last_viewed_at ?? null,
          skip_reason: skipped(record),
          decision: "not_needed",
        }));
        let freed = false;
        let reconsider = false;
        try {
          for (const candidate of candidates) {
            if (error.details.capacity_resource === "tailnet") candidate.skip_reason ??= "url_ports_retained";
            if (candidate.skip_reason !== null) { candidate.decision = "skipped"; continue; }
            if (freed) continue;
            try {
              await this.store.withLock(candidate.env, async () => {
                const current = await this.store.readEnv(candidate.env);
                candidate.skip_reason = skipped(current);
                if (candidate.skip_reason !== null) { candidate.decision = "skipped"; return; }
                if (viewed(current) !== Date.parse(candidate.last_viewed_at)) {
                  candidate.skip_reason = "view_changed"; candidate.decision = "skipped"; reconsider = true; return;
                }
                const key = `${this.paths.root}\0${current.name}`;
                capacitySleeping.add(key);
                try { await this.sleepRuntime(current); } finally { capacitySleeping.delete(key); }
                if (current.status === "warm" && current.serve?.pid === 0) { slept.push(current.name); freed = true; candidate.decision = "slept"; }
                else { candidate.skip_reason = "runtime_not_slept"; candidate.decision = "skipped"; }
              });
            } catch (failure) {
              if (!(failure instanceof NectarError) || failure.code !== "E_BUSY") { candidate.skip_reason = "sleep_failed"; candidate.decision = "failed"; throw failure; }
              candidate.skip_reason = failure.details.lock !== undefined ? "lock_held" : "runtime_busy";
              candidate.decision = "skipped";
            }
            if (reconsider) break;
          }
        } finally {
          await this.logCapacity({ event: "capacity_recovery", at: new Date().toISOString(), env: exclude ?? null, code: error.code, capacity_resource: error.details.capacity_resource ?? null, candidates, slept_previews: slept.slice() });
        }
        if (error.details.capacity_resource === "tailnet") throw new NectarError(error.code, `${error.message}; sleeping preserves existing URL routes and cannot release their TCP ports`, { ...error.details, slept_previews: slept });
        if (reconsider) continue;
        if (!freed) throw new NectarError(error.code, `${error.message}; no idle dynamic runtime can be put to sleep. Alternatively, configure nectar pool add <host> and publish without --local or --host for automatic host placement`, { ...error.details, slept_previews: slept });
      }
    }
  }

  private readonly publisher: Publisher | undefined;
  private readonly readOnly: string | undefined;

  constructor(root?: string, options: { publisher?: Publisher; readOnly?: string } = {}) {
    this.paths = getPaths(root);
    this.store = new StateStore(this.paths);
    this.publisher = options.publisher;
    this.readOnly = options.readOnly;
  }

  private touchNote(): { touched?: false; touch_skipped?: string } {
    return this.readOnly === undefined ? {} : { touched: false, touch_skipped: this.readOnly };
  }

  private async identity(): Promise<MachineIdentity> {
    const config = await this.store.readConfig();
    const status = await tailnetStatus();
    const live = status.identity;
    if (live !== undefined) {
      const updated = { ...config, tailnet_host: live.host, tailnet_dns_name: live.dnsName };
      // Rewriting on every call races doctor's pack-server registration writes.
      if (this.readOnly === undefined && (config.tailnet_host !== live.host || config.tailnet_dns_name !== live.dnsName)) {
        await this.store.writeConfig(updated);
      }
      return { host: live.host, dnsName: live.dnsName, online: true, config: updated };
    }
    const fallback = config.tailnet_host ?? (os.hostname().split(".")[0] || "localhost");
    return {
      host: fallback.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      ...(config.tailnet_dns_name === undefined ? {} : { dnsName: config.tailnet_dns_name }),
      online: false,
      offline: status.reason,
      config,
    };
  }

  async publish(options: PublishOptions): Promise<Record<string, unknown>> {
    const slept: string[] = [];
    try {
      const result = await this.publishPlaced(options, slept);
      return { ...result, preview_url: result.preview_url ?? (result.packet_fields as Partial<PacketFields> | undefined)?.preview_url ?? null, slept_previews: [...slept, ...((result.slept_previews as string[] | undefined) ?? [])] };
    } catch (error) {
      if (!(error instanceof NectarError) || !["E_QUOTA", "E_PORTS"].includes(error.code) || options.local === true || options.host !== undefined || options.received === true) throw error;
      return this.placeForCapacity(options, error, slept);
    }
  }

  private async placeForCapacity(options: PublishOptions, error: NectarError, slept: string[], source?: EnvRecord): Promise<Record<string, unknown>> {
    const pool = poolSettings(await this.store.readConfig());
    if (pool === undefined) throw error;
    const shape = await this.publishShape(options);
    if (shape.category !== "web" && shape.category !== "static") throw error;
    const own = await this.ownPoolHosts(pool.hosts);
    let remaining = pool.hosts.filter((host) => !own.has(host));
    const failures: string[] = [];
    while (remaining.length > 0) {
      const probes = await Promise.all(remaining.map((host) => this.probePoolHost(host)));
      const choice = choosePoolHost(probes, { postgres: shape.postgres }, "least-loaded");
      if (choice.host === undefined) { failures.push(choice.reason); break; }
      remaining = remaining.filter((host) => host !== choice.host);
      try {
        const shipment = await this.shipment(source === undefined ? options : { ...options, repo: source.worktree, branch: source.commit });
        if (source !== undefined) shipment.payload.branch = source.branch;
        const result = await this.ship(choice.host, shipment);
        if (typeof result.env === "string") await updatePlacements(this.paths, (placements) => { placements[shape.key] = { host: choice.host!, env: result.env as string, at: new Date().toISOString() }; });
        return { ...result, preview_url: result.preview_url ?? (result.packet_fields as Partial<PacketFields> | undefined)?.preview_url ?? null, slept_previews: [...slept, ...((result.slept_previews as string[] | undefined) ?? [])], placed_on: choice.host, placement_reason: `local capacity exhausted; ${choice.reason}` };
      } catch (failure) {
        if (!(failure instanceof NectarError) || !["E_QUOTA", "E_PORTS"].includes(failure.code)) throw failure;
        failures.push(`${choice.host}: ${failure.message}`);
      }
    }
    throw new NectarError(error.code, `${error.message}; configured pool has no capacity: ${failures.join("; ")}`, { slept_previews: slept });
  }

  private async publishPlaced(options: PublishOptions, slept: string[]): Promise<Record<string, unknown>> {
    // Validate caller input before touching the repo — a bad --ttl is a usage
    // error, not a checkout problem.
    const ttlMs = parseDuration(options.ttl ?? DEFAULT_TTL, "ttl");
    if (options.host !== undefined && options.local === true) throw new NectarError("E_USAGE", "--host and --local exclude each other");
    if (options.host !== undefined && !(await this.isLocalHost(options.host))) return this.publishRemote(options.host, options);
    const placement = options.host === undefined ? await this.place(options) : undefined;
    if (placement === undefined) return this.publishPublic(await this.recoverCapacity(undefined, () => this.publishHere(options, ttlMs), slept), options);
    const placed = { placed_on: placement.host ?? (await this.identity()).host, placement_reason: placement.reason };
    if (placement.host === undefined) return { ...(await this.publishPublic(await this.recoverCapacity(undefined, () => this.publishHere(options, ttlMs), slept), options)), ...placed };
    let shipment: Shipment;
    try {
      shipment = await this.shipment(options);
    } catch (error) {
      if (!(error instanceof NectarError)) throw error;
      const refusal = { placed_on: (await this.identity()).host, placement_reason: `not shipped to ${placement.host}: ${error.message}; published on this host` };
      return { ...(await this.publishPublic(await this.recoverCapacity(undefined, () => this.publishHere(options, ttlMs), slept), options)), ...refusal };
    }
    const result = await this.ship(placement.host, shipment);
    if (options.dryRun !== true && placement.key !== undefined && this.readOnly === undefined && typeof result.env === "string") {
      const key = placement.key;
      const entry = { host: placement.host, env: result.env, at: new Date().toISOString() };
      await updatePlacements(this.paths, (placements) => {
        placements[key] = entry;
      });
    }
    return { ...result, ...placed };
  }

  private async publishPublic(result: Record<string, unknown>, options: PublishOptions): Promise<Record<string, unknown>> {
    if (options.public !== true || options.dryRun === true || typeof result.env !== "string") return result;
    const config = await this.store.readConfig();
    const to = defaultExposure(config.exposures);
    let exposed: Record<string, unknown>;
    try {
      exposed = await this.expose(result.env, { to, gate: "password" });
    } catch (error) {
      const failure = asNectarError(error);
      throw new NectarError(failure.code, `Published ${typeof result.ref === "string" ? result.ref : result.env}, but exposing it publicly failed: ${failure.message}`, {
        ...failure.details,
        env: result.env,
        ...(typeof result.ref === "string" ? { ref: result.ref } : {}),
      });
    }
    const details = Object.fromEntries(Object.entries(exposed).filter(([key]) => !["env", "url", "share_url", "packet_fields", "secret"].includes(key)));
    return {
      ...result,
      ...(typeof result.urls === "object" && result.urls !== null ? { urls: { ...result.urls, public: exposed.url } } : {}),
      url: exposed.url,
      share_url: exposed.share_url,
      public: { target: to, ...details },
      packet_fields: exposed.packet_fields,
      secret: ["share_url", "public.share_note", "public.password", "public.credentials"],
    };
  }

  private async publishHere(options: PublishOptions, ttlMs: number): Promise<Record<string, unknown>> {
    this.assertWritable("publish");
    const site = await this.staticCandidate(options);
    if (site !== undefined) return options.dryRun === true ? this.staticPlan(site, options) : this.publishStatic(site, options, ttlMs);
    const repo = await resolveRepo(options.repo ?? process.cwd());
    const slot = await resolveBranch(repo, options.branch, (this.publisher ?? currentPublisher()).hive_bee);
    const branch = slot.branch;
    const loaded = await loadRecipe(repo);
    const recipe = options.name === undefined ? loaded : { ...loaded, name: appSlug(options.name) };
    const mode = selectMode(recipe, options.mode);
    if (options.dryRun === true) return this.recipePlan(recipe, mode, repo, slot);
    if (mode === "web") assertRuntimes(recipe);
    if (mode === "web") await this.checkPostgres(recipe);
    if (options.fresh === true && mode !== "web") {
      throw new NectarError("E_USAGE", "--fresh recreates [deps] of web envs only");
    }
    if (options.verify === true && mode !== "dev") {
      throw new NectarError("E_USAGE", "--verify is supported only with --mode dev");
    }
    const publishOptions = {
      repo,
      branch,
      slot,
      recipe,
      ttlMs,
      ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
      ...(options.packet === undefined ? {} : { packet: options.packet }),
      ...(options.verify === undefined ? {} : { verify: options.verify }),
    };
    if (mode === "web") {
      const web = await this.publishWeb({ ...publishOptions, fresh: options.fresh === true });
      return this.publishResult(web.record, this.packetFields(web.record), web.warnings, {
        mesh_error: web.meshError,
        deps: redactedDeps(web.record.deps),
      });
    }
    if (mode === "ios") return this.publishIos(publishOptions);
    if (mode === "dev") return this.publishDev(publishOptions);
    return this.publishDesktop(publishOptions);
  }

  private assertWritable(command: string): void {
    if (this.readOnly === undefined) return;
    throw new NectarError("E_DAEMON", `NECTAR_HOME is read-only here and nectar ${command} cannot run on this host without nectard`, { hint: "nectar daemon install" });
  }

  private remoteCaller(): { hive_bee?: string; hive_session?: string } {
    const publisher = this.publisher ?? currentPublisher();
    return {
      ...(publisher.hive_bee === undefined ? {} : { hive_bee: publisher.hive_bee }),
      ...(publisher.hive_session === undefined ? {} : { hive_session: publisher.hive_session }),
    };
  }

  private async remote<T extends object = Record<string, unknown>>(host: string, op: RemoteOp, args: Record<string, unknown>, sshArgs: string[]): Promise<T> {
    try {
      return (await callRemote(host, op, { args, caller: this.remoteCaller() })) as T;
    } catch (error) {
      if (!(error instanceof NectarError) || error.details.transport !== true) throw error;
      const config = await this.store.readConfig().catch(() => undefined);
      if (config?.remote?.ssh_fallback !== true) throw error;
      return this.remoteResult<T>(host, sshArgs);
    }
  }

  private async place(options: PublishOptions): Promise<PlacementDecision | undefined> {
    if (options.received === true || !existsSync(this.paths.config)) return undefined;
    const pool = poolSettings(await this.store.readConfig());
    if (pool === undefined) return undefined;
    if (options.local === true) return { host: undefined, reason: "--local keeps it on this host" };
    let shape: PublishShape;
    try {
      shape = await this.publishShape(options);
    } catch {
      return undefined;
    }
    if (!(pool.default_for as string[]).includes(shape.category)) {
      return { host: undefined, reason: POOL_CATEGORIES.includes(shape.category as never) ? `pool.default_for does not include ${shape.category}, so it stays on this host` : `${shape.category} envs always stay on this host` };
    }
    if ((await this.store.maybeEnv(shape.env)) !== undefined) return { host: undefined, reason: `${shape.env} already lives on this host` };
    if (shape.uncommitted !== undefined) {
      return { host: undefined, reason: `${shape.uncommitted} has uncommitted changes and a pool host gets only the commit, so it stays on this host; commit to let the pool take it` };
    }
    const recorded = (await readPlacements(this.paths))[shape.key];
    const sticky = recorded !== undefined && pool.hosts.includes(recorded.host.toLowerCase()) ? recorded : undefined;
    const stickyProbe = sticky === undefined ? undefined : await this.probePoolHost(sticky.host);
    if (sticky !== undefined && stickyProbe?.local === true) return { host: undefined, reason: `${shape.env} was placed on this host` };
    if (sticky !== undefined && stickyProbe?.error === undefined && stickyProbe?.report?.nectard?.ok !== false) {
      return { host: sticky.host, reason: `sticky: ${sticky.env} already lives on ${sticky.host} (placed ${sticky.at})`, key: shape.key };
    }
    const own = await this.ownPoolHosts(pool.hosts);
    const others = pool.hosts.filter((host) => !own.has(host));
    const probes = await Promise.all(others.map(async (host) => (host === sticky?.host && stickyProbe !== undefined ? stickyProbe : this.probePoolHost(host))));
    const choice = choosePoolHost(probes, { postgres: shape.postgres }, pool.prefer);
    const moved =
      sticky !== undefined
        ? `${sticky.env} lived on ${sticky.host}, which is unhealthy (${stickyProbe?.error?.message ?? "nectard is not running"}); `
        : recorded !== undefined
          ? `${recorded.env} lived on ${recorded.host}, which is no longer in the pool; `
          : "";
    if (choice.host === undefined) return { host: undefined, reason: `${moved}${choice.reason}; published on this host` };
    return { host: choice.host, reason: `${moved}${choice.reason}`, key: shape.key };
  }

  private async publishShape(options: PublishOptions): Promise<PublishShape> {
    const site = await this.staticCandidate(options);
    if (site !== undefined) {
      const env = envName(appSlug(options.name ?? site.name), await this.staticBranch(site, options), "web");
      const repo = await resolveRepo(path.dirname(site.file ?? path.join(site.root, "index.html"))).catch(() => undefined);
      if (repo === undefined) return { category: "static", env, key: `${site.source}\0${env}`, postgres: false };
      const source = `roots:${(await sourceIdentity(repo, "HEAD")).roots.join(",")}`;
      const published = path.relative(await realpath(repo), await realpath(site.file ?? site.root)).split(path.sep).join("/");
      return { category: "static", env, key: `${source}\0${env}`, postgres: false, ...((await uncommitted(repo, published)) ? { uncommitted: published || "the repo" } : {}) };
    }
    const repo = await resolveRepo(options.repo ?? process.cwd());
    const slot = await resolveBranch(repo, options.branch, (this.publisher ?? currentPublisher()).hive_bee);
    const loaded = await loadRecipe(repo);
    const recipe = options.name === undefined ? loaded : { ...loaded, name: appSlug(options.name) };
    const mode = selectMode(recipe, options.mode);
    const env = envName(recipe.name, slot.branch, mode);
    const source = `roots:${(await sourceIdentity(repo, slot.commit ?? slot.branch)).roots.join(",")}`;
    const postgres = mode === "web" && Object.values(recipe.deps ?? {}).some((dep) => dep.kind === "postgres");
    return { category: mode, env, key: `${source}\0${env}`, postgres };
  }

  private async probePoolHost(host: string): Promise<PoolProbe> {
    if (await this.isLocalHost(host)) return { host, local: true, report: await hostReport(this.paths) };
    try {
      return { host, local: false, report: await helloRemote(host) };
    } catch (error) {
      const failure = asNectarError(error);
      return { host, local: false, error: { code: failure.code, message: failure.message } };
    }
  }

  private async forgetPlacement(host: string, env: string): Promise<void> {
    const aliases = hostAliases(host);
    const placements = await readPlacements(this.paths);
    const stale = Object.entries(placements).filter(([, entry]) => entry.env === env && [...hostAliases(entry.host)].some((alias) => aliases.has(alias)));
    if (stale.length === 0) return;
    await updatePlacements(this.paths, (current) => {
      for (const [key] of stale) delete current[key];
    });
  }

  private async ownPoolHosts(hosts: string[]): Promise<Set<string>> {
    const identity = await this.identity();
    const own = new Set<string>();
    for (const host of hosts) if (await this.isLocalHost(host, identity)) own.add(host);
    return own;
  }

  private ownHostNote(own: Set<string>): Record<string, unknown> {
    if (own.size === 0) return {};
    const names = [...own].join(" ");
    return { excluded: [...own], note: `${names} is this host, so placement skips it; nectar pool rm ${names} takes it out of the pool` };
  }

  async poolList(): Promise<Record<string, unknown>> {
    const config = await this.store.readConfig();
    const pool = poolSettings(config);
    const placements = await readPlacements(this.paths);
    return {
      pool: pool ?? null,
      placements: Object.values(placements).sort((a, b) => (a.env < b.env ? -1 : a.env > b.env ? 1 : 0)),
      ...(pool === undefined ? { note: "No pool: every publish without --host stays on this host" } : this.ownHostNote(await this.ownPoolHosts(pool.hosts))),
    };
  }

  async poolChange(change: { add?: string[]; remove?: string[]; prefer?: string; defaultFor?: string[] }): Promise<Record<string, unknown>> {
    this.assertWritable("pool");
    const config = await this.store.readConfig();
    const current = poolSettings(config);
    const hosts = [...(current?.hosts ?? [])];
    const identity = (change.add ?? []).length === 0 ? undefined : await this.identity();
    for (const host of change.add ?? []) {
      const name = host.trim().toLowerCase();
      if (name === "") throw new NectarError("E_USAGE", "A pool host needs a node name");
      if (identity !== undefined && (await this.isLocalHost(name, identity))) {
        throw new NectarError("E_USAGE", `${name} is this host; the pool lists the other nodes that take this host's publishes, so it cannot include ${identity.host} itself`, {
          hint: "nectar pool add with the other nodes only; nectar publish --local keeps a publish here",
        });
      }
      if (![...hostAliases(name)].some((alias) => hosts.some((listed) => hostAliases(listed).has(alias)))) hosts.push(name);
    }
    const removed = new Set<string>();
    const missing: string[] = [];
    for (const host of change.remove ?? []) {
      const aliases = hostAliases(host);
      const matched = hosts.filter((listed) => [...hostAliases(listed)].some((alias) => aliases.has(alias)));
      if (matched.length === 0) missing.push(host.trim().toLowerCase());
      for (const listed of matched) removed.add(listed);
    }
    if (missing.length > 0) throw new NectarError("E_NOT_FOUND", `Not in the pool: ${missing.join(", ")}`);
    if (change.prefer !== undefined && !(POOL_POLICIES as readonly string[]).includes(change.prefer)) {
      throw new NectarError("E_USAGE", `--prefer takes ${POOL_POLICIES.join(" or ")}`);
    }
    if (change.defaultFor !== undefined && (change.defaultFor.length === 0 || change.defaultFor.some((category) => !(POOL_CATEGORIES as readonly string[]).includes(category)))) {
      throw new NectarError("E_USAGE", `--for takes ${POOL_CATEGORIES.join(",")}; desktop, ios and dev envs always stay on the publishing host`);
    }
    const next = {
      ...(config.pool ?? {}),
      hosts: hosts.filter((host) => !removed.has(host)),
      ...(change.prefer === undefined ? {} : { prefer: change.prefer }),
      ...(change.defaultFor === undefined ? {} : { default_for: change.defaultFor }),
    } as NonNullable<MachineConfig["pool"]>;
    poolSettings({ ...config, pool: next });
    await this.store.writeConfig({ ...config, pool: next });
    return this.poolList();
  }

  async poolCheck(): Promise<Record<string, unknown>> {
    const pool = poolSettings(await this.store.readConfig());
    if (pool === undefined) return { pool: null, hosts: [], note: "No pool: every publish without --host stays on this host" };
    const own = await this.ownPoolHosts(pool.hosts);
    const probes = await Promise.all(pool.hosts.filter((host) => !own.has(host)).map((host) => this.probePoolHost(host)));
    const web = choosePoolHost(probes, { postgres: false }, pool.prefer);
    const postgres = choosePoolHost(probes, { postgres: true }, pool.prefer);
    const row = (probe: PoolProbe): Record<string, unknown> => ({
      host: probe.host,
      healthy: probe.error === undefined && probe.report?.nectard?.ok !== false,
      version: probe.report?.version ?? null,
      nectard: probe.error === undefined ? (probe.report?.nectard?.ok ?? true ? "ok" : "down") : "unreachable",
      mesh: probe.report?.mesh ?? null,
      deps: probe.report?.deps ?? null,
      envs: probe.report?.envs?.total ?? null,
      serving: probe.report?.envs?.serving ?? null,
      load: probe.report?.load?.per_cpu ?? null,
      ...(probe.error === undefined ? {} : { error: probe.error }),
    });
    const probed = new Map(probes.map((probe) => [probe.host, probe]));
    return {
      pool,
      ...this.ownHostNote(own),
      hosts: pool.hosts.map((host) => {
        const probe = probed.get(host);
        return probe === undefined ? { host, local: true, excluded: true } : row(probe);
      }),
      next: { web: web.host ?? null, postgres: postgres.host ?? null, reason: web.reason },
    };
  }

  private async publishRemote(host: string, options: PublishOptions): Promise<Record<string, unknown>> {
    return this.ship(host, await this.shipment(options));
  }

  private async ship(host: string, shipment: Shipment): Promise<Record<string, unknown>> {
    return (await callRemote(host, "publish", { args: shipment.payload, caller: this.remoteCaller() }, shipment.archive)) as Record<string, unknown>;
  }

  private async shipment(options: PublishOptions): Promise<Shipment> {
    if (options.worktree !== undefined) throw new NectarError("E_USAGE", "--worktree does not apply with --host; the target checks out its own copy");
    const common = {
      name: options.name,
      ttl: options.ttl,
      packet: options.packet,
      verify: options.verify,
      dry_run: options.dryRun,
      fresh: options.fresh,
      public: options.public,
    };
    const site = await this.staticCandidate(options);
    const target = path.resolve(options.repo ?? process.cwd());
    const repo = await this.shippedRepo(target, site, options.branch);
    let tar: Buffer;
    let args: Record<string, unknown>;
    if (repo === undefined && site !== undefined) {
      if (options.verify === true) throw new NectarError("E_USAGE", "--worktree and --verify do not apply to static sites");
      if (site.file === undefined) tar = await packFiles(site.root, (await staticFiles(site.root)).files);
      else tar = await packFiles(path.dirname(site.file), [{ relative: path.basename(site.file), name: sourceDir(path.basename(site.file)) }]);
      args = {
        kind: "static",
        source: site.source,
        dir: sourceDir(path.basename(site.file === undefined ? site.source : path.dirname(site.file))),
        ...(site.file === undefined ? {} : { entry: sourceDir(path.basename(site.file)) }),
        branch: await this.staticBranch(site, options),
        ...common,
      };
    } else {
      const root = repo ?? (await resolveRepo(target));
      const slot = await resolveBranch(root, options.branch, (this.publisher ?? currentPublisher()).hive_bee);
      const commit = slot.commit ?? (await this.shippedCommit(root, slot.branch, site));
      const source = `roots:${(await sourceIdentity(root, commit)).roots.join(",")}`;
      const within = path.relative(await realpath(root), await realpath(target)).split(path.sep).join("/");
      if (within !== "" && !(await inCommit(root, commit, within))) {
        throw new NectarError("E_USAGE", `${within} is not in the committed tree of ${slot.branch}; --host ships only committed files, so commit it first`);
      }
      const shipped = site === undefined ? "" : path.posix.join(within, path.relative(target, site.file ?? site.root).split(path.sep).join("/")).replace(/^\.$/, "");
      tar = await archiveCommit(root, commit, MAX_TREE_BYTES, shipped);
      const leaving = linksLeaving(tar, shipped);
      if (leaving.length > 0) {
        const scope = shipped === "" ? "the repo" : shipped;
        const named = leaving.slice(0, 3).map((entry) => `'${entry.link}' (-> ${entry.target})`).join(", ");
        throw new NectarError("E_USAGE", `Symlink ${named}${leaving.length > 3 ? ` and ${leaving.length - 3} more` : ""} points outside ${scope}; a publish on another node ships only ${scope}, so the link would dangle there`, {
          refused: "symlink",
          links: leaving.map((entry) => entry.link),
          hint: "commit the file itself in place of the link, or point the link inside what is published",
        });
      }
      args = { kind: "git", source, dir: sourceDir(path.basename(root)), branch: slot.branch, commit, mode: options.mode, ...(within === "" ? {} : { path: within }), ...common };
    }
    const archive = await promisify(zlib.gzip)(tar);
    if (archive.length > MAX_ARCHIVE_BYTES) throw new NectarError("E_USAGE", `The source is ${archive.length} bytes compressed; --host takes at most ${MAX_ARCHIVE_BYTES}`);
    return { archive, payload: Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)) };
  }

  private async shippedCommit(repo: string, branch: string, site: StaticSite | undefined): Promise<string> {
    try {
      return await resolveCommit(repo, branch);
    } catch (error) {
      if (site === undefined) throw error;
      return resolveCommit(repo, "HEAD");
    }
  }

  private async shippedRepo(target: string, site: StaticSite | undefined, branch: string | undefined): Promise<string | undefined> {
    const directory = site?.file === undefined ? target : path.dirname(site.file);
    let repo: string;
    try {
      repo = await resolveRepo(directory);
    } catch {
      return undefined;
    }
    if (site === undefined) return repo;
    const page = path.relative(await realpath(repo), await realpath(site.file ?? path.join(site.root, "index.html"))).split(path.sep).join("/");
    if (await inCommit(repo, await this.shippedCommit(repo, branch ?? "HEAD", site), page)) return repo;
    if (await gitIgnored(repo, page)) return undefined;
    throw new NectarError("E_USAGE", `${page} is not committed; --host ships a repo's committed tree, so commit it first (ignored build output is shipped as files)`);
  }

  private async staticCandidate(options: PublishOptions): Promise<StaticSite | undefined> {
    if (options.mode !== undefined && options.mode !== "static") return undefined;
    const target = path.resolve(options.repo ?? process.cwd());
    const site = await findStaticSite(target);
    if (options.mode === "static") {
      if (site === undefined) {
        throw new NectarError(
          "E_NO_RECIPE",
          `No index.html in ${target} or its ${STATIC_ROOTS.slice(1).join("/")} directory, and it is not an .html file`,
        );
      }
      return site;
    }
    if (site === undefined || site.file !== undefined) return site;
    let repo: string;
    try {
      repo = await resolveRepo(target);
    } catch {
      return site;
    }
    if (existsSync(path.join(repo, "nectar.toml"))) return undefined;
    try {
      await loadRecipe(repo);
      return undefined;
    } catch {
      return site;
    }
  }

  private recipePlan(recipe: Recipe, mode: Mode, repo: string, slot: BranchSlot): Record<string, unknown> {
    const web = mode === "web" ? recipe.web : undefined;
    return {
      dry_run: true,
      repo,
      name: envName(recipe.name, slot.branch, mode),
      branch: slot.branch,
      branch_source: slot.source,
      mode,
      source: recipe.source,
      stack: recipe.detected?.stack ?? recipe.source,
      reason: recipe.detected?.reason ?? "explicit nectar.toml recipe",
      ...(web === undefined
        ? { recipe: recipe[mode] ?? null }
        : {
            build: web.build ?? null,
            serve: web.serve,
            ready_path: web.readyPath,
            requires: web.requires ?? [],
            missing: missingCommands(recipe),
            deps: recipe.deps ?? null,
            seed: seedScenario(recipe) ?? null,
          }),
    };
  }

  private async staticPlan(site: StaticSite, options: PublishOptions): Promise<Record<string, unknown>> {
    const name = appSlug(options.name ?? site.name);
    return {
      dry_run: true,
      repo: site.source,
      name: envName(name, await this.staticBranch(site, options), "web"),
      mode: "web",
      source: "static",
      stack: "static",
      reason: site.file === undefined ? `index.html in ${site.root}` : `single file ${site.file}`,
      build: null,
      serve: "Nectar's shared static server (copy of the files under work/<name>; no per-preview process or ports)",
      ready_path: "/",
      requires: [],
      missing: [],
    };
  }

  private async staticBranch(site: StaticSite, options: PublishOptions): Promise<string> {
    if (options.branch !== undefined) return options.branch;
    try {
      return await currentBranch(await resolveRepo(path.dirname(site.file ?? path.join(site.source, "index.html"))));
    } catch {
      return "static";
    }
  }

  private async publishStatic(site: StaticSite, options: PublishOptions, ttlMs: number): Promise<Record<string, unknown>> {
    if (options.worktree !== undefined || options.verify === true) {
      throw new NectarError("E_USAGE", "--worktree and --verify do not apply to static sites");
    }
    const branch = await this.staticBranch(site, options);
    const recipe: Recipe = {
      name: appSlug(options.name ?? site.name),
      source: "static",
      web: staticWebRecipe(),
    };
    const web = await this.publishWeb({
      repo: site.source,
      branch,
      recipe,
      ttlMs,
      site,
      ...(options.packet === undefined ? {} : { packet: options.packet }),
    });
    return this.publishResult(web.record, this.packetFields(web.record), web.warnings, { source: site.source, mesh_error: web.meshError });
  }

  private async stageStatic(record: EnvRecord, site: StaticSite): Promise<string[]> {
    try {
      const staged = await stageStaticSite(site, record.worktree);
      record.commit = staged.hash;
      delete record.install_hash;
      await this.store.writeEnv(record);
      return staged.skippedLinks === 0 ? [] : [`skipped ${staged.skippedLinks} symlink(s) while copying ${site.root}; static sites serve regular files only`];
    } catch (error) {
      record.status = "crashed";
      await this.store.writeEnv(record);
      throw error;
    }
  }

  private async initialRecord(options: {
    repo: string;
    branch: string;
    slot?: BranchSlot;
    recipe: Recipe;
    mode: Mode;
    ttlMs: number;
    worktree?: string;
    packet?: string;
  }): Promise<{ record: EnvRecord; old?: EnvRecord; identity: MachineIdentity }> {
    const name = envName(options.recipe.name, options.branch, options.mode);
    const old = await this.store.maybeEnv(name);
    if (old !== undefined) await this.assertSameSource(old, options.repo, options.recipe.source === "static", options.branch, options.slot);
    const identity = await this.identity();
    const slot = path.join(this.paths.work, name);
    const owned = old !== undefined && !old.borrowed_worktree && old.worktree === `${slot}.alt` ? old.worktree : slot;
    const record = this.nextRecord(options, name, options.worktree ?? owned, identity, old);
    // Stop the old runtime while its pid/pgid are still on disk — overwriting the
    // record first would orphan the running server if we die before stopping it.
    if (old !== undefined) await this.stopRuntime(old);
    await this.store.writeEnv(record);
    if (options.worktree === undefined) {
      const other = owned === slot ? `${slot}.alt` : slot;
      if (existsSync(other)) await this.discardWorktree(options.repo, other);
      if (options.recipe.source !== "static" && existsSync(owned) && !(await this.checkedOutFrom(owned, options.repo))) {
        await this.discardWorktree(options.repo, owned, old?.repo);
      }
    }
    return { record, ...(old === undefined ? {} : { old }), identity };
  }

  private async assertSameSource(old: EnvRecord, repo: string, isStatic: boolean, branch: string, slot?: BranchSlot): Promise<void> {
    if (isStatic ? path.resolve(old.repo) === path.resolve(repo) : await this.sameGitSource(old, repo, branch, slot?.commit ?? branch)) return;
    throw new NectarError(
      "E_USAGE",
      `Env '${old.name}' is published from ${old.repo}, not ${repo}; pass --name <other> to publish this one beside it, or run nectar rm ${old.name} --force first`,
      { existing_repo: old.repo },
    );
  }

  private async sameGitSource(old: EnvRecord, repo: string, branch: string, ref: string): Promise<boolean> {
    if (await sameRepository(old.repo, repo)) return true;
    if (!old.borrowed_worktree && existsSync(path.join(old.worktree, ".git")) && (await sameRepository(old.worktree, repo))) return true;
    return this.sameUpstream(old, repo, branch, ref);
  }

  private async sameUpstream(old: EnvRecord, repo: string, branch: string, ref: string): Promise<boolean> {
    const gone = !existsSync(old.repo);
    if (old.branch !== branch && !gone) return false;
    const recorded =
      old.roots !== undefined
        ? { origin: old.origin, roots: old.roots }
        : gone
          ? undefined
          : await sourceIdentity(old.repo, "HEAD").catch(() => undefined);
    if (recorded?.origin === undefined || recorded.roots.length === 0) return false;
    const fresh = await sourceIdentity(repo, ref).catch(() => undefined);
    return fresh?.origin === recorded.origin && fresh.roots.some((root) => recorded.roots.includes(root));
  }

  private async checkedOutFrom(worktree: string, repo: string): Promise<boolean> {
    return existsSync(path.join(worktree, ".git")) && sameRepository(worktree, repo);
  }

  private nextRecord(
    options: { repo: string; branch: string; slot?: BranchSlot; recipe: Recipe; mode: Mode; ttlMs: number; worktree?: string; packet?: string },
    name: string,
    destination: string,
    identity: MachineIdentity,
    old: EnvRecord | undefined,
  ): EnvRecord {
    const now = new Date();
    return {
      eid: old?.eid ?? crypto.randomBytes(2).toString("hex"),
      name,
      mode: options.mode,
      app: options.recipe.name,
      repo: options.repo,
      branch: options.branch,
      ...(options.slot === undefined ? {} : { branch_source: options.slot.source }),
      commit: old?.commit ?? "unknown",
      worktree: destination,
      borrowed_worktree: options.worktree !== undefined,
      status: "publishing",
      // Republish keeps the same stable mesh URL, so a live exposure stays valid — the
      // relay route already points at it; carry it across so packet_fields keeps the
      // public_url and gc still knows to tear it down.
      urls: { local: null, mesh: null, public: liveExposureUrl(old) },
      ...(old?.exposure === undefined ? {} : { exposure: old.exposure }),
      ref: formatRef(identity.host, name),
      published_at: now.toISOString(),
      expires_at: expiresAt(now, options.ttlMs),
      last_touched_at: now.toISOString(),
      publisher: this.publisher ?? currentPublisher(),
      ...(options.packet === undefined ? {} : { packet_hint: options.packet }),
      ttl_ms: options.ttlMs,
      ...(old?.static_route === undefined ? {} : { static_route: old.static_route }),
      evidence: old?.evidence ?? [],
      ...(old?.install_hash === undefined ? {} : { install_hash: old.install_hash }),
      ...(old?.pinned === undefined ? {} : { pinned: old.pinned }),
      ...(old?.last_opened_at === undefined ? {} : { last_opened_at: old.last_opened_at }),
      ...(old?.last_viewed_at === undefined ? {} : { last_viewed_at: old.last_viewed_at }),
      ...(old?.deps === undefined ? {} : { deps: old.deps }),
    };
  }

  private async checkout(
    record: EnvRecord,
    old: EnvRecord | undefined,
    borrowed: string | undefined,
    cacheAllowlist: string[],
    pinned?: string,
  ): Promise<EnvRecord> {
    try {
      await this.checkoutInto(record, old, borrowed, cacheAllowlist, pinned);
      await this.store.writeEnv(record);
      return record;
    } catch (error) {
      record.status = "crashed";
      await this.store.writeEnv(record);
      throw error;
    }
  }

  private async checkoutInto(
    record: EnvRecord,
    old: EnvRecord | undefined,
    borrowed: string | undefined,
    cacheAllowlist: string[],
    pinned?: string,
  ): Promise<void> {
    const commit = pinned ?? (await resolveCommit(record.repo, record.branch));
    const identity = await sourceIdentity(record.repo, commit);
    if (identity.origin === undefined) delete record.origin;
    else record.origin = identity.origin;
    record.roots = identity.roots;
    const checkout = await prepareWorktree({
      repo: record.repo,
      branch: record.branch,
      commit,
      destination: record.worktree,
      ...(borrowed === undefined ? {} : { borrowed }),
      preserve: cacheAllowlist,
    });
    record.worktree = checkout.worktree;
    record.borrowed_worktree = checkout.borrowed;
    record.commit = checkout.commit;
    const installHash = await installDependencies(record.worktree, old?.install_hash);
    if (installHash === undefined) delete record.install_hash;
    else record.install_hash = installHash;
  }

  private async legacyIdentity(record: EnvRecord): Promise<{ start_time?: string; reason?: string }> {
    const serve = record.serve;
    if (serve === undefined) return { reason: "no runtime" };
    const { daemonHello } = await import("./control.js");
    const hello = await daemonHello().catch(() => undefined);
    const daemonPid = hello?.nectar_home === this.paths.root ? hello.pid : undefined;
    const timestamps = [record.published_at, record.last_touched_at, serve.started_at].filter((value): value is string => value !== undefined).map(Date.parse);
    return legacyProcessIdentity(serve, record.worktree, Math.min(...timestamps), daemonPid);
  }

  private async adoptLegacy(record: EnvRecord): Promise<void> {
    if (record.serve === undefined || record.serve.start_time !== undefined || !groupAlive(record.serve.pgid)) return;
    const verified = await this.legacyIdentity(record);
    if (verified.start_time === undefined) throw new NectarError("E_BUSY", `Runtime ownership unknown: ${verified.reason}`, { ownership_refusal: true, hint: `nectar rm ${record.name} --detach retires the record without signalling PGID ${record.serve.pgid}` });
    record.serve.start_time = verified.start_time;
    await this.store.writeEnv(record);
  }

  async clearDeadPublishing(): Promise<void> {
    if (this.readOnly !== undefined) return;
    for (const snapshot of await this.store.listEnvs()) {
      if (snapshot.status !== "publishing" || (snapshot.serve !== undefined && (pidAlive(snapshot.serve.pid) || groupAlive(snapshot.serve.pgid)))) continue;
      await this.store.updateEnv(snapshot.name, async (record) => {
        if (record.status !== "publishing" || (record.serve !== undefined && (pidAlive(record.serve.pid) || groupAlive(record.serve.pgid)))) return;
        await this.stopRuntime(record);
        await this.tearDownExposure(record);
        record.status = "stopped";
        record.urls = { local: null, mesh: null, public: null };
        delete record.serve;
        delete record.liveness;
      }, { bestEffort: true });
    }
  }

  private async stopRuntime(record: EnvRecord): Promise<void> {
    if (record.serve !== undefined) {
      await this.adoptLegacy(record);
      await stopEnvGroup(record.serve);
      await this.releaseServeEntry(record.serve);
    }
    if (record.mode === "ios" && record.sim_udid !== undefined) await shutdownSim(record.sim_udid);
  }

  private async releaseRuntime(record: EnvRecord): Promise<void> {
    await this.stopRuntime(record);
    if (record.serve?.tailnet_port !== undefined && (await this.ownEntryAt(record.serve)) === false) record.urls.mesh = null;
  }

  private async ownEntryAt(serve: ServeRecord): Promise<boolean | undefined> {
    const status = await serveStatus();
    if (status === undefined) return undefined;
    return serveEntries(status).some(
      (entry) => entry.tailnetPort === serve.tailnet_port && rootMount(entry) && ownsLoopbackPort(serve, loopbackProxy(entry.target)?.upstreamPort),
    );
  }

  private async cleanupRuntime(record: EnvRecord): Promise<string[]> {
    const cleanupErrors: string[] = [];
    if (record.serve !== undefined) {
      await this.adoptLegacy(record);
      const owned = record.serve;
      const processCleanup = await Promise.resolve(stopEnvGroup(owned)).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (!processCleanup.ok) {
        cleanupErrors.push(`process group ${owned.pgid}: ${String(processCleanup.error)}`);
        return cleanupErrors;
      }
      if (owned.tailnet_port !== undefined) {
        if (await this.foreignServeAt(owned)) {
          cleanupErrors.push(`tailscale serve :${owned.tailnet_port}: points at a target Nectar did not create; left alone`);
        } else {
          const serveCleanup = await Promise.resolve(stopServe(owned.tailnet_port)).then(
            (removed) => ({ ok: removed }),
            () => ({ ok: false }),
          );
          if (!serveCleanup.ok) {
            cleanupErrors.push(`tailscale serve :${owned.tailnet_port}: could not confirm removal`);
          }
        }
      }
    }
    delete record.serve;
    delete record.liveness;
    record.urls = { local: null, mesh: null };
    return cleanupErrors;
  }

  private async rollbackRuntime(record: EnvRecord, error: unknown): Promise<void> {
    const failure = asNectarError(error);
    const cleanupErrors = await this.cleanupRuntime(record);
    record.status = "crashed";
    record.failure = {
      code: failure.code,
      message: failure.message,
      failed_at: new Date().toISOString(),
      log_tail: await logTail(this.paths, record.name),
      ...(cleanupErrors.length === 0 ? {} : { cleanup_errors: cleanupErrors }),
    };
    await this.store.writeEnv(record);
  }

  private async foreignServeAt(serve: ServeRecord, status?: unknown): Promise<boolean> {
    if (serve.tailnet_port === undefined || (serve.upstream_port === undefined && serve.proxy_port === undefined)) return false;
    const entries = serveEntries(status ?? (await serveStatus())).filter((entry) => entry.tailnetPort === serve.tailnet_port);
    return entries.some((entry) => !rootMount(entry) || !ownsLoopbackPort(serve, loopbackProxy(entry.target)?.upstreamPort));
  }

  private async soleEntryAt(tailnetPort: number, target: string): Promise<boolean> {
    const entries = serveEntries(await serveStatus()).filter((entry) => entry.tailnetPort === tailnetPort);
    return entries.length > 0 && entries.every((entry) => rootMount(entry) && entry.target === target);
  }

  private async releaseServeEntry(serve: ServeRecord): Promise<boolean> {
    if (serve.tailnet_port === undefined) return true;
    if (await this.foreignServeAt(serve)) return false;
    return stopServe(serve.tailnet_port);
  }

  private async classifyServe(status: unknown, config: MachineConfig): Promise<ClassifiedServeEntry[]> {
    const records = await this.store.listEnvs();
    const entries = serveEntries(status).filter((entry) => inTailnetRange(entry.tailnetPort, config));
    const classified = await Promise.all(
      entries.map(async (entry) => {
        const upstream = loopbackProxy(entry.target);
        const owner = serveEntryOwner(entry, records);
        const answering =
          upstream === undefined
            ? false
            : upstream.upstreamHost === "localhost"
              ? await portAnswers(upstream.upstreamPort)
              : await portOpenOnHost(upstream.upstreamPort, upstream.upstreamHost);
        const ownerAlive = owner?.serve === undefined ? false : await groupBelongsToEnv(owner.serve);
        const appAnswers =
          !answering && owner?.serve?.upstream_port !== undefined && upstream?.upstreamPort === owner.serve.proxy_port
            ? await portAnswers(owner.serve.upstream_port)
            : false;
        return classifyServeEntry(entry, records, config, { answering, ownerAlive, appAnswers });
      }),
    );
    return guardSharedPorts(classified);
  }

  private async cleanupServeOrphan(orphan: ClassifiedServeEntry): Promise<boolean> {
    if (orphan.class !== "orphan" || !(await this.soleEntryAt(orphan.tailnetPort, orphan.target))) return false;
    if (orphan.env === undefined) return stopServe(orphan.tailnetPort);
    if (orphan.direct !== undefined) return (await serveWeb(orphan.tailnetPort, orphan.direct)).ok;
    const env = orphan.env;
    try {
      return await this.store.withLock(env, async () => {
        const record = await this.store.readEnv(env);
        if (record.serve?.tailnet_port !== orphan.tailnetPort || !ownsLoopbackPort(record.serve, orphan.upstreamPort)) return false;
        if (record.status === "expired" || record.status === "cold" || record.status === "stopped") {
          const released = await this.releaseServeEntry(record.serve);
          if (released) {
            record.urls.mesh = null;
            await this.store.writeEnv(record);
          }
          return released;
        }
        const cleanupErrors = await this.cleanupRuntime(record);
        record.status = "crashed";
        record.failure = {
          code: "E_SERVE_ORPHAN",
          message: `Tailscale Serve :${orphan.tailnetPort} pointed at dead local target ${orphan.target}`,
          failed_at: new Date().toISOString(),
          log_tail: await logTail(this.paths, record.name),
          ...(cleanupErrors.length === 0 ? {} : { cleanup_errors: cleanupErrors }),
        };
        await this.store.writeEnv(record);
        return cleanupErrors.length === 0;
      });
    } catch {
      return false;
    }
  }

  private async releaseSim(record: EnvRecord): Promise<void> {
    if (record.mode !== "ios" || record.sim_udid === undefined) return;
    // Only ever delete devices Nectar created (nectar- prefix guard).
    if ((record.sim_device ?? "").startsWith("nectar-")) {
      await shutdownSim(record.sim_udid);
      await deleteSim(record.sim_udid);
    }
    delete record.sim_udid;
    delete record.sim_device;
  }

  private async publishWeb(options: {
    repo: string;
    branch: string;
    slot?: BranchSlot;
    recipe: Recipe;
    ttlMs: number;
    worktree?: string;
    packet?: string;
    site?: StaticSite;
    fresh?: boolean;
  }): Promise<PublishedWeb> {
    if (options.recipe.web === undefined) throw new NectarError("E_NO_RECIPE", "Recipe does not declare [web]");
    const name = envName(options.recipe.name, options.branch, "web");
    return this.store.withLock(name, async () => {
      const old = await this.store.maybeEnv(name);
      if (old !== undefined && !old.borrowed_worktree && existsSync(old.worktree)) {
        const wasStatic = !existsSync(path.join(old.worktree, ".git"));
        if (wasStatic !== (options.site !== undefined)) {
          throw new NectarError(
            "E_USAGE",
            `Env '${name}' already holds a ${wasStatic ? "static copy" : "git checkout"} of ${old.repo}; run nectar rm ${name} --force first, or pass --name to publish under another name`,
          );
        }
      }
      if (old !== undefined) await this.assertSameSource(old, options.repo, options.site !== undefined, options.branch, options.slot);
      if (
        old !== undefined &&
        (holdsRuntime(old.status) || (old.status === "warm" && old.serve?.proxy_port !== undefined)) &&
        (options.site !== undefined || (!old.borrowed_worktree && options.worktree === undefined))
      ) {
        return this.republishWeb(options, old);
      }
      if (!options.recipe.web?.serve.includes("static-server.") && (options.site !== undefined || (await runningDaemonPid(this.paths)) === undefined) && !(await this.memoryAvailable())) {
        throw new NectarError("E_QUOTA", "Insufficient host memory to start this preview; free host memory or publish on another host with --host <host>");
      }
      const initial = await this.initialRecord({ ...options, mode: "web" });
      const site = options.site;
      let record = initial.record;
      let stageWarnings: string[] = [];
      if (site === undefined) {
        record = await this.checkout(record, initial.old, options.worktree, initial.identity.config.worktree_cache_allowlist, options.slot?.commit);
      } else {
        stageWarnings = await this.stageStatic(record, site);
      }
      try {
        const loaded = site === undefined ? await loadRecipe(record.worktree) : options.recipe;
        const web = loaded.web;
        if (web === undefined) throw new NectarError("E_NO_RECIPE", "Published branch does not declare [web]");
        const depEnv = site === undefined ? await this.provisionDeps(record, loaded, options.fresh === true, stageWarnings) : {};
        if (web.build !== undefined) await this.runBuild(record, web.build, depEnv);
        const published = await this.publishWebRuntime(record, web, initial.identity, initial.old, depEnv, site === undefined);
        return { ...published, warnings: [...published.warnings, ...stageWarnings] };
      } catch (error) {
        await this.rollbackRuntime(record, error);
        throw error;
      }
    });
  }

  private async republishWeb(
    options: { repo: string; branch: string; slot?: BranchSlot; recipe: Recipe; ttlMs: number; packet?: string; site?: StaticSite; fresh?: boolean },
    old: EnvRecord,
  ): Promise<PublishedWeb> {
    const identity = await this.identity();
    const site = options.site;
    if (site === undefined && (await runningDaemonPid(this.paths)) === undefined && !(await this.memoryAvailable())) throw new NectarError("E_QUOTA", "Insufficient host memory to start this preview; free host memory or publish on another host with --host <host>");
    const slot = path.join(this.paths.work, old.name);
    const destination = site !== undefined ? old.worktree : old.worktree === slot ? `${slot}.alt` : slot;
    const record = this.nextRecord({ ...options, mode: "web" }, old.name, destination, identity, old);
    const warnings: string[] = [];
    let web: WebRecipe | undefined;
    let depEnv: Record<string, string> = {};
    try {
      if (site === undefined) {
        await this.discardWorktree(record.repo, destination);
        await this.checkoutInto(record, old, undefined, identity.config.worktree_cache_allowlist, options.slot?.commit);
        const loaded = await loadRecipe(record.worktree);
        web = loaded.web;
        if (web !== undefined) depEnv = await this.provisionDeps(record, loaded, options.fresh === true, warnings);
      } else {
        const staged = await stageStaticSite(site, record.worktree);
        record.commit = staged.hash;
        delete record.install_hash;
        if (staged.skippedLinks > 0) {
          warnings.push(`skipped ${staged.skippedLinks} symlink(s) while copying ${site.root}; static sites serve regular files only`);
        }
        web = options.recipe.web;
      }
      if (web === undefined) throw new NectarError("E_NO_RECIPE", "Published branch does not declare [web]");
      if (web.build !== undefined) await this.runBuild(record, web.build, depEnv);
    } catch (error) {
      if (site === undefined) await this.discardWorktree(record.repo, destination).catch(() => undefined);
      if (old.status === "warm") await this.store.readEnv(old.name).then((previous) => this.stopDeps(previous)).catch(() => undefined);
      const failure = asNectarError(error);
      throw new NectarError(
        failure.code,
        `${failure.message}; ${old.name} ${old.status === "warm" ? "stays asleep on" : "still serves"} the previous publish (${old.commit})`,
        { ...failure.details, ...(old.status === "warm" ? { still_warm: old.commit } : { still_serving: old.commit }) },
      );
    }
    if (old.serve?.proxy_port !== undefined && (await runningDaemonPid(this.paths)) !== undefined) {
      record.serve = { ...old.serve };
      record.urls = { ...old.urls };
      await this.adoptLegacy(old);
      record.serve = { ...old.serve };
      await this.store.writeEnv(record);
      await stopEnvGroup(old.serve);
      record.serve.pid = 0;
      record.serve.pgid = 0;
      delete record.serve.start_time;
      delete record.serve.upstream_port;
    } else {
      await this.stopRuntime(old);
    }
    await this.store.writeEnv(record);
    if (site === undefined && old.worktree !== destination) await this.discardWorktree(record.repo, old.worktree, old.repo);
    try {
      const published = await this.publishWebRuntime(record, web, identity, old, depEnv, site === undefined);
      return { ...published, warnings: [...published.warnings, ...warnings] };
    } catch (error) {
      await this.rollbackRuntime(record, error);
      throw error;
    }
  }

  private async discardWorktree(repo: string, worktree: string, previous?: string): Promise<void> {
    for (const owner of previous === undefined || previous === repo ? [repo] : [repo, previous]) {
      if (existsSync(owner) && (await removeWorktree(owner, worktree)) && !existsSync(worktree)) return;
    }
    await trashPaths([worktree], this.paths.root);
  }

  private async runBuild(record: EnvRecord, build: string, depEnv: Record<string, string>): Promise<void> {
    const result = await runShell(
      build,
      record.worktree,
      scrubbedEnvironment({ ...depEnv, NECTAR_ENV: record.name, NECTAR_ENV_DIR: record.worktree }),
      15 * 60_000,
    );
    if (result.exitCode !== 0) {
      throw new NectarError("E_INSTALL", `Build step failed: ${build}`, {
        log_tail: [...result.stdout.split("\n"), ...result.stderr.split("\n")].filter(Boolean).slice(-40),
      });
    }
  }

  private async checkPostgres(recipe: Recipe): Promise<void> {
    const providers = new PostgresProviders();
    for (const [name, dep] of Object.entries(recipe.deps ?? {})) if (dep.kind === "postgres") await providers.choose(name, dep);
  }

  private async provisionDeps(record: EnvRecord, recipe: Recipe, fresh: boolean, warnings: string[]): Promise<Record<string, string>> {
    const wanted = Object.entries(recipe.deps ?? {});
    const previous = fresh ? {} : (record.deps ?? {});
    const postgres = wanted.flatMap(([name, dep]) => (dep.kind === "postgres" ? [{ name, recipe: dep }] : []));
    const directory = depsDir(this.paths.work, record.name);
    if (wanted.length === 0) {
      if (record.deps === undefined) return {};
      await this.releaseDeps(record);
      await this.persistDeps(record);
      return {};
    }
    const providers = new PostgresProviders();
    const choices = new Map<string, PostgresChoice>();
    for (const { name, recipe: dep } of postgres) {
      const choice = await providers.choose(name, dep, previous[name]);
      if (choice.warning !== undefined) warnings.push(choice.warning);
      choices.set(name, choice);
    }
    const usesDocker = [...choices.values()].some((choice) => choice.provider === "docker");
    if (Object.values(record.deps ?? {}).some(usesDockerPostgres) && (fresh || !usesDocker)) await removeLabelled(record.name, this.paths.root);
    const staleLocal = Object.entries(record.deps ?? {}).filter(([name, dep]) => usesLocalPostgres(dep) && (fresh || choices.get(name)?.provider !== "local"));
    await this.dropLocalDeps(staleLocal, warnings);
    const clusterPorts = new Map<number, number>();
    for (const choice of choices.values()) {
      if (choice.install !== undefined && !clusterPorts.has(choice.install.major)) {
        clusterPorts.set(choice.install.major, await this.withCluster(choice.install, (port) => Promise.resolve(port)));
      }
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    const next: Record<string, DepRecord> = {};
    let created = false;
    for (const [name, dep] of wanted) {
      if (dep.kind !== "sqlite") continue;
      const file = path.join(directory, name, path.basename(dep.path));
      const prior = previous[name];
      if (prior?.kind !== "sqlite" || prior.file !== file || !existsSync(file)) {
        created = true;
        await mkdir(path.dirname(file), { recursive: true });
        await Promise.all(["", "-wal", "-shm", "-journal"].map(async (suffix) => rm(`${file}${suffix}`, { force: true })));
        const source = path.join(record.worktree, dep.path);
        if (existsSync(source)) await copyFile(source, file);
      }
      next[name] = { kind: "sqlite", env: dep.env, file, created_at: prior?.created_at ?? now };
    }
    const secrets = fresh ? {} : await readSecrets(directory);
    const before = record.deps;
    const newDocker: string[] = [];
    const newLocal: Array<[string, DepRecord]> = [];
    await this.store.withLock(PORTS_LOCK, async () => {
      const config = await this.store.readConfig();
      const reserved = loopbackPorts((await this.store.listEnvs()).filter((item) => item.name !== record.name));
      reserved.add(config.pack_server_port);
      for (const port of [record.serve?.upstream_port, record.serve?.proxy_port]) if (port !== undefined) reserved.add(port);
      for (const { name, recipe: dep } of postgres) {
        const prior = previous[name]?.kind === "postgres" ? previous[name] : undefined;
        const install = choices.get(name)?.install;
        const password = secrets[name] ?? newPassword();
        secrets[name] = password;
        if (install !== undefined) {
          const identifier = pgIdentifier(record.name, name);
          next[name] = {
            kind: "postgres",
            env: dep.env,
            image: dep.image,
            provider: "local",
            major: install.major,
            port: clusterPorts.get(install.major) ?? 0,
            database: identifier,
            user: identifier,
            created_at: prior?.created_at ?? now,
          };
          if (prior === undefined) newLocal.push([name, next[name]]);
          continue;
        }
        if (prior === undefined) newDocker.push(name);
        const port =
          prior?.port ??
          (await allocatePort({ start: config.upstream_port_start, end: config.upstream_port_end, reserved }));
        reserved.add(port);
        next[name] = {
          kind: "postgres",
          env: dep.env,
          image: dep.image,
          provider: "docker",
          project: composeProject(record.name),
          port,
          database: dep.database,
          user: dep.user,
          created_at: prior?.created_at ?? now,
        };
      }
      record.deps = next;
      await this.persistDeps(record);
    });
    await writePrivateJson(path.join(directory, "secrets.json"), secrets);
    if (postgres.length > 0) {
      try {
        if (usesDocker) {
          await assertProjectOwned(composeProject(record.name), this.paths.root);
          await this.composeUpDeps(record.name, next, secrets);
        }
        await this.createLocalDeps(next, secrets);
      } catch (error) {
        if (newDocker.length > 0) await removeLabelled(record.name, this.paths.root, newDocker).catch(() => undefined);
        await this.dropLocalDeps(newLocal).catch(() => undefined);
        if (fresh || before === undefined) delete record.deps;
        else record.deps = before;
        await this.persistDeps(record);
        if (Object.keys(postgresServices(record.deps, secrets)).length > 0) {
          await this.composeUpDeps(record.name, record.deps, secrets).catch(() => undefined);
        }
        if (newLocal.length > 0) await this.stopIdleClusters();
        throw error;
      }
    }
    if (staleLocal.length > 0) await this.stopIdleClusters();
    const depEnv = depEnvironment(next, secrets);
    const seed = seedScenario(recipe);
    if ((created || newDocker.length > 0 || newLocal.length > 0) && seed !== undefined) await this.runSeed(record, seed, depEnv);
    return depEnv;
  }

  private async localInstall(major: number | undefined): Promise<PgInstall> {
    const install = (await findPgInstalls()).find((item) => item.major === major);
    if (install !== undefined) return install;
    throw new NectarError("E_PLATFORM", `No local Postgres ${major ?? "?"} binaries are found on this host for Nectar's cluster at ${path.join(this.paths.root, "pg", String(major))}`, {
      hint: LOCAL_PG_HINT,
    });
  }

  private async clusterReferenced(major: number, exclude?: string): Promise<boolean> {
    return (await this.store.listEnvs()).some(
      (record) => record.name !== exclude && Object.values(record.deps ?? {}).some((dep) => usesLocalPostgres(dep) && dep.major === major),
    );
  }

  private async withClusterLock<T>(major: number, action: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        return await this.store.withLock(`machine--pg-${major}`, action);
      } catch (error) {
        if (!(error instanceof NectarError && error.code === "E_BUSY" && error.message.includes(`machine--pg-${major}`)) || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  private async withCluster<T>(install: PgInstall, action: (port: number) => Promise<T>): Promise<T> {
    return this.withClusterLock(install.major, async () => {
      const port = await ensureCluster(this.paths.root, install, {
        referenced: await this.clusterReferenced(install.major),
        lockPorts: async (allocateWith) =>
          this.store.withLock(PORTS_LOCK, async () =>
            allocateWith(async () => {
              const config = await this.store.readConfig();
              const reserved = loopbackPorts(await this.store.listEnvs());
              reserved.add(config.pack_server_port);
              return allocatePort({ start: config.upstream_port_start, end: config.upstream_port_end, reserved });
            }),
          ),
      });
      return action(port);
    });
  }

  private async createLocalDeps(deps: Record<string, DepRecord> | undefined, secrets: Record<string, string>): Promise<void> {
    for (const [name, dep] of Object.entries(deps ?? {})) {
      if (!usesLocalPostgres(dep) || dep.database === undefined) continue;
      const install = await this.localInstall(dep.major);
      const password = secrets[name] ?? "";
      await this.withCluster(install, async (port) => {
        if (port !== dep.port) throw new NectarError("E_DEPS", `The local Postgres ${install.major} cluster moved from port ${dep.port ?? "?"} to ${port}; republish with --fresh`);
        await superuserSql(this.paths.root, install, port, createDatabaseSql(dep.database ?? "", password), [password]);
      });
    }
  }

  private async dropLocalDeps(deps: Array<[string, DepRecord]>, warnings?: string[]): Promise<void> {
    for (const [name, dep] of deps) {
      if (!usesLocalPostgres(dep) || dep.database === undefined) continue;
      const install = await this.localInstall(dep.major).catch((error: unknown) => {
        if (warnings === undefined) throw error;
        warnings.push(`[deps.${name}] could not drop ${dep.database}: no local Postgres ${dep.major ?? "?"} binaries; it stays in ${path.join(this.paths.root, "pg", String(dep.major))}`);
        return undefined;
      });
      if (install === undefined) continue;
      await this.withCluster(install, async (port) => superuserSql(this.paths.root, install, port, dropDatabaseSql(dep.database ?? "")));
    }
  }

  private async stopIdleClusters(exclude?: string): Promise<void> {
    for (const major of await clusterMajors(this.paths.root)) {
      await this.withClusterLock(major, async () => {
        if (await this.clusterReferenced(major, exclude)) return;
        const install = (await findPgInstalls()).find((item) => item.major === major);
        if (install !== undefined) await stopCluster(this.paths.root, install);
      }).catch(() => undefined);
    }
  }

  private async startDeps(record: EnvRecord): Promise<void> {
    const deps = Object.values(record.deps ?? {});
    if (deps.length === 0) return;
    const secrets = await readSecrets(depsDir(this.paths.work, record.name));
    if (deps.some(usesDockerPostgres)) await this.composeUpDeps(record.name, record.deps, secrets);
    await this.createLocalDeps(record.deps, secrets);
  }

  private async composeUpDeps(env: string, deps: Record<string, DepRecord> | undefined, secrets: Record<string, string>): Promise<void> {
    const file = composeFile(this.paths.work, env);
    await writePrivateJson(file, composeSpec(env, this.paths.root, postgresServices(deps, secrets)));
    await composeUp(file, composeProject(env));
  }

  // A republish keeps the previous record on disk while the old serve runs, so only
  // the deps field is patched into it; a fresh publish owns the on-disk record.
  private async persistDeps(record: EnvRecord): Promise<void> {
    const onDisk = await this.store.maybeEnv(record.name);
    if (onDisk === undefined || onDisk.published_at === record.published_at) {
      await this.store.writeEnv(record);
      return;
    }
    if (record.deps === undefined) delete onDisk.deps;
    else onDisk.deps = record.deps;
    await this.store.writeEnv(onDisk);
  }

  private async runSeed(record: EnvRecord, seed: { name: string; seed: string }, depEnv: Record<string, string>): Promise<void> {
    const result = await runShell(
      seed.seed,
      record.worktree,
      scrubbedEnvironment({ ...depEnv, NECTAR_ENV: record.name, NECTAR_ENV_DIR: record.worktree, NECTAR_SCENARIO: seed.name }),
      15 * 60_000,
    );
    if (result.exitCode !== 0) {
      throw new NectarError("E_SEED", `Seed for scenario '${seed.name}' failed: ${seed.seed}`, {
        log_tail: [...result.stdout.split("\n"), ...result.stderr.split("\n")].filter(Boolean).slice(-40),
      });
    }
  }

  private async depEnv(record: EnvRecord): Promise<Record<string, string>> {
    if (record.deps === undefined) return {};
    return depEnvironment(record.deps, await readSecrets(depsDir(this.paths.work, record.name)));
  }

  private async stopDeps(record: EnvRecord): Promise<void> {
    if (Object.values(record.deps ?? {}).some(usesDockerPostgres)) await stopLabelled(record.name, this.paths.root);
  }

  private async releaseDeps(record: EnvRecord): Promise<void> {
    if (record.deps === undefined) return;
    if (Object.values(record.deps).some(usesDockerPostgres)) await removeLabelled(record.name, this.paths.root);
    const local = Object.entries(record.deps).filter(([, dep]) => usesLocalPostgres(dep));
    await this.dropLocalDeps(local);
    await trashPaths([depsDir(this.paths.work, record.name)], this.paths.root);
    delete record.deps;
    if (local.length > 0) await this.stopIdleClusters(record.name);
  }

  // Env locks are per-env, so two bees publishing different envs race the port
  // allocator: both can probe the same free port before either has recorded a
  // claim, and the loser's tailscale entry would proxy the wrong branch. The
  // machine-wide PORTS_LOCK serializes allocate→spawn→record-write; the claim is
  // on disk before the lock is released.
  private async allocateAndSpawn(
    record: EnvRecord,
    identity: MachineIdentity,
    old: EnvRecord | undefined,
    spawnCommand: (upstreamPort: number) => { pid: number; pgid: number; start_time?: string; cmd: string },
  ): Promise<{ upstreamPort: number; tailnetPort: number; foreignPort?: number }> {
    return this.store.withLock(PORTS_LOCK, async () => {
      const live = await this.store.listEnvs();
      const others = live.filter((item) => item.name !== record.name);
      const reservedUpstream = loopbackPorts(others);
      reservedUpstream.add(identity.config.pack_server_port);
      for (const port of depPorts(record)) reservedUpstream.add(port);
      const proxyPort = old?.serve?.proxy_port;
      if (proxyPort !== undefined) reservedUpstream.add(proxyPort);
      const reservedTailnet = new Set(
        others.map((item) => item.serve?.tailnet_port).filter((port): port is number => port !== undefined),
      );
      // Port 443 belongs to the portless proxy, even if a bad machine config includes it.
      reservedTailnet.add(443);
      // Loopback probing says nothing about existing `tailscale serve` entries —
      // consult the serve table so we never clobber one (F5). This env's own old
      // entry stays claimable, or republish would lose its stable URL.
      const status = await serveStatus();
      for (const port of statusPorts(status)) {
        reservedTailnet.add(port);
        reservedUpstream.add(port);
      }
      for (const port of reservedUpstream) reservedTailnet.add(port);
      const foreignPort = old?.serve !== undefined && (await this.foreignServeAt(old.serve, status)) ? old.serve.tailnet_port : undefined;
      if (old?.serve?.tailnet_port !== undefined && foreignPort === undefined) reservedTailnet.delete(old.serve.tailnet_port);
      const upstreamPort = await allocatePort({
        start: identity.config.upstream_port_start,
        end: identity.config.upstream_port_end,
        reserved: reservedUpstream,
        ...(old?.serve?.upstream_port === undefined ? {} : { preferred: old.serve.upstream_port }),
      });
      reservedTailnet.add(upstreamPort);
      const retained = old?.serve?.tailnet_port;
      const ownsRoute = retained !== undefined && foreignPort === undefined && retained >= identity.config.tailnet_port_start && retained <= identity.config.tailnet_port_end && !reservedTailnet.has(retained) && serveEntries(status).some((entry) => entry.tailnetPort === retained);
      const tailnetPort = ownsRoute ? retained : await allocatePort({
        start: identity.config.tailnet_port_start,
        end: identity.config.tailnet_port_end,
        reserved: reservedTailnet,
        ...(retained === undefined ? {} : { preferred: retained }),
      }).catch((error: unknown) => { const failure = asNectarError(error); throw new NectarError(failure.code, failure.message, { ...failure.details, capacity_resource: "tailnet" }); });
      const spawned = spawnCommand(upstreamPort);
      record.serve = {
        cmd: spawned.cmd,
        pid: spawned.pid,
        pgid: spawned.pgid,
        ...(spawned.start_time === undefined ? {} : { start_time: spawned.start_time }),
        upstream_port: upstreamPort,
        tailnet_port: tailnetPort,
        ...(proxyPort === undefined ? {} : { proxy_port: proxyPort }),
      };
      record.urls.local = `http://127.0.0.1:${upstreamPort}`;
      await this.store.writeEnv(record);
      return { upstreamPort, tailnetPort, ...(foreignPort === undefined ? {} : { foreignPort }) };
    });
  }

  private async publishWebRuntime(
    record: EnvRecord,
    recipe: WebRecipe,
    identity: MachineIdentity,
    old: EnvRecord | undefined,
    depEnv: Record<string, string>,
    dynamic: boolean,
  ): Promise<PublishedWeb> {
    if (!dynamic || isStaticServe(recipe.serve) || (await runningDaemonPid(this.paths)) === undefined) return this.startWeb(record, recipe, identity, old, depEnv);
    const { upstreamPort, tailnetPort } = await this.allocateAndSpawn(record, identity, old, () => ({ pid: 0, pgid: 0, cmd: recipe.serve }));
    if (record.serve === undefined) throw new NectarError("E_INTERNAL", "Missing route allocation");
    delete record.serve.upstream_port;
    record.status = "warm";
    const port = record.serve.proxy_port ?? upstreamPort;
    if (port === undefined) throw new NectarError("E_PORTS", "Could not allocate a preview listener; widen custom port ranges or publish with --host <host>");
    record.serve.proxy_port = port;
    record.urls.local = `http://127.0.0.1:${port}`;
    const mesh = identity.online ? await serveWeb(tailnetPort, record.urls.local) : undefined;
    record.urls.mesh = mesh?.ok === true && identity.dnsName !== undefined ? `https://${identity.dnsName}:${tailnetPort}` : null;
    await this.stopDeps(record);
    await this.store.writeEnv(record);
    const deadline = Date.now() + 5_000;
    while ((await probeProxy(port, record.name)) === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if ((await probeProxy(port, record.name)) === undefined) throw new NectarError("E_SERVE_TIMEOUT", "nectard did not open the preview listener");
    return { record, warnings: mesh?.ok === true ? [] : [meshWarning(mesh, `mesh URL unavailable; preview_url fell back to ${record.urls.local}`, identity.offline)], meshError: mesh?.ok === false ? mesh.message : identity.offline ?? null };
  }

  async wakeWeb(name: string): Promise<Upstream> {
    const current = await this.store.readEnv(validateEnvName(name));
    if (capacitySleeping.has(`${this.paths.root}\0${name}`)) throw new NectarError("E_BUSY", "Preview is being put to sleep; retry");
    const remoteUpstream = (url: string): Upstream => {
      const parsed = new URL(url);
      return { host: parsed.hostname, port: Number(parsed.port) || 443, protocol: "https:" };
    };
    if (current.serve?.capacity_remote_url !== undefined) return remoteUpstream(current.serve.capacity_remote_url);
    if ((holdsRuntime(current.status) || current.status === "crashed") && current.serve?.upstream_port !== undefined) return current.serve.upstream_host === undefined ? upstreamOf(current.urls.local === `http://127.0.0.1:${current.serve.proxy_port}` ? null : current.urls.local, current.serve.upstream_port) : { host: current.serve.upstream_host, port: current.serve.upstream_port };
    const slept: string[] = [];
    let upstream: Upstream;
    try {
      upstream = await this.recoverCapacity(name, () => this.wakeHere(name), slept);
    } catch (error) {
      if (!(error instanceof NectarError) || !["E_QUOTA", "E_PORTS"].includes(error.code)) throw error;
      upstream = await this.store.withLock(name, async () => {
        const record = await this.store.readEnv(name);
        if (record.serve?.capacity_remote_url !== undefined) return remoteUpstream(record.serve.capacity_remote_url);
        if (record.status !== "warm" || record.serve === undefined) throw new NectarError("E_BUSY", "Preview changed during capacity recovery; retry");
        const result = await this.placeForCapacity({ repo: record.repo, branch: record.branch, mode: "web", name: record.app, ttl: `${Math.max(1000, Date.parse(record.expires_at) - Date.now())}ms` }, error, slept, record);
        const targetUrl = result.preview_url ?? (result.packet_fields as Partial<PacketFields> | undefined)?.preview_url;
        if (typeof targetUrl !== "string" || !targetUrl.startsWith("https://")) throw new NectarError("E_TAILNET_DOWN", "Remote preview did not return a reachable mesh URL");
        record.serve.capacity_remote_url = targetUrl;
        await this.store.writeEnv(record);
        await this.logCapacity({ event: "wake_placement", env: name, placed_on: result.placed_on, preview_url: targetUrl, slept_previews: slept });
        return remoteUpstream(targetUrl);
      });
    }
    if (slept.length > 0) await this.logCapacity({ event: "wake_capacity", env: name, slept_previews: slept, at: new Date().toISOString() });
    return { ...upstream, slept_previews: slept };
  }

  private async wakeHere(name: string): Promise<Upstream> {
    const current = await this.store.readEnv(validateEnvName(name));
    if ((holdsRuntime(current.status) || current.status === "crashed") && current.serve?.upstream_port !== undefined) return { host: current.serve.upstream_host ?? "127.0.0.1", port: current.serve.upstream_port };
    return this.store.withLock(validateEnvName(name), async () => {
      const record = await this.store.readEnv(name);
      if (record.mode !== "web" || record.serve === undefined) throw new NectarError("E_NOT_FOUND", "Preview unavailable");
      if (record.status === "warm") {
        if (!(await this.memoryAvailable())) throw new NectarError("E_QUOTA", "Insufficient host memory to wake this preview; free host memory or republish with --host <host>");
        const recipe = (await loadRecipe(record.worktree)).web;
        if (recipe === undefined) throw new NectarError("E_NO_RECIPE", "Missing web recipe");
        const old = structuredClone(record);
        try {
          await this.startDeps(record);
          await this.startWeb(record, recipe, await this.identity(), old, await this.depEnv(record));
        } catch (error) {
          if (record.serve !== undefined && record.serve.pid > 1) await stopEnvGroup(record.serve);
          await this.stopDeps(record);
          record.serve = old.serve!;
          record.urls = old.urls;
          record.status = "warm";
          await this.store.writeEnv(record);
          throw error;
        }
      }
      if ((!holdsRuntime(record.status) && record.status !== "crashed") || record.serve.upstream_port === undefined) throw new NectarError("E_NOT_FOUND", "Preview unavailable");
      await this.store.writeEnv(record);
      return { host: record.serve.upstream_host ?? "127.0.0.1", port: record.serve.upstream_port };
    });
  }

  private async sleepRuntime(record: EnvRecord): Promise<void> {
    if (record.mode === "web" && record.serve?.proxy_port !== undefined) {
      if ((await runningDaemonPid(this.paths)) === undefined) return;
      await this.adoptLegacy(record);
      await stopEnvGroup(record.serve);
      if (groupAlive(record.serve.pgid)) throw new NectarError("E_BUSY", "Preview process still running");
      await this.stopDeps(record);
      record.serve.pid = 0;
      record.serve.pgid = 0;
      delete record.serve.start_time;
      delete record.serve.upstream_port;
      record.urls.local = `http://127.0.0.1:${record.serve.proxy_port}`;
    } else {
      await this.stopRuntime(record);
      delete record.serve;
    }
    delete record.liveness;
    record.status = "warm";
    await this.store.writeEnv(record);
  }

  async idleStop(viewedAt: ReadonlyMap<string, number> = new Map()): Promise<void> {
    const config = await this.store.readConfig();
    for (const snapshot of await this.store.listEnvs()) {
      if (protectedPreview(snapshot) || gcTransition(snapshot, new Date(), config.idle_stop_ms) !== "idle-stop") continue;
      await this.store.withLock(snapshot.name, async () => {
        const record = await this.store.readEnv(snapshot.name);
        if (!protectedPreview(record) && Date.now() - (viewedAt.get(record.name) ?? 0) >= config.idle_stop_ms && gcTransition(record, new Date(), config.idle_stop_ms) === "idle-stop") await this.sleepRuntime(record);
      }).catch(() => undefined);
    }
  }

  private async startWeb(
    record: EnvRecord,
    recipe: WebRecipe,
    identity: MachineIdentity,
    old: EnvRecord | undefined,
    depEnv: Record<string, string>,
  ): Promise<PublishedWeb> {
    if (isStaticServe(recipe.serve) && old?.serve === undefined) {
      record.static_root = staticServeRoot(recipe.serve, record.worktree);
      return this.startSharedStatic(record, identity);
    }
    delete record.static_route;
    delete record.static_root;
    const log = await prepareLog(this.paths, record.name, identity.config.log_max_bytes);
    const { upstreamPort, tailnetPort, foreignPort } = await this.allocateAndSpawn(record, identity, old, (port) => {
      const childEnv = scrubbedEnvironment({
        ...recipe.env,
        ...depEnv,
        PORT: String(port),
        NECTAR_ENV: record.name,
        NECTAR_ENV_DIR: record.worktree,
      });
      return { ...spawnDetached(recipe.serve, record.worktree, childEnv, log), cmd: recipe.serve };
    });
    const warnings = [`portless registration is deferred in v0 — local URL degraded to ${record.urls.local}`, ...movedWarning(foreignPort, tailnetPort)];
    await this.store.writeEnv(record);

    const readyUrl = await this.waitReady(upstreamPort, recipe.readyPath, recipe.readyTimeoutMs);
    if (readyUrl === undefined) {
      throw new NectarError("E_SERVE_TIMEOUT", `Serve did not return HTTP 200 at ${recipe.readyPath} within ${recipe.readyTimeoutMs}ms`, {
        log_tail: await logTail(this.paths, record.name),
      });
    }
    if (record.serve !== undefined) record.serve.upstream_host = readyUrl.hostname.replace(/^\[|\]$/g, "");
    record.urls.local = record.serve?.proxy_port === undefined ? readyUrl.origin : `http://127.0.0.1:${record.serve.proxy_port}`;
    warnings[0] = `portless registration is deferred in v0 — local URL degraded to ${record.urls.local}`;
    let mesh: ServeOutcome | undefined;
    if (identity.online && identity.dnsName !== undefined) mesh = await serveWeb(tailnetPort, await this.meshTarget(record));
    if (mesh?.ok === true && identity.dnsName !== undefined) {
      record.urls.mesh = `https://${identity.dnsName}:${tailnetPort}`;
    } else {
      record.urls.mesh = null;
      warnings.push(meshWarning(mesh, `mesh URL unavailable; preview_url fell back to ${record.urls.local}`, identity.offline));
    }
    record.status = "serving";
    delete record.failure;
    delete record.liveness;
    await this.store.writeEnv(record);
    return { record, warnings, meshError: mesh === undefined ? (identity.offline ?? null) : mesh.ok ? null : `${mesh.message} ${apiNote(mesh.api, mesh.unreachable)}` };
  }

  private async startSharedStatic(record: EnvRecord, identity: MachineIdentity): Promise<PublishedWeb> {
    const front = await ensureSharedStatic(this.store, identity.online ? identity.dnsName : undefined);
    if (!identity.online && identity.offline !== undefined) front.error = identity.offline;
    record.static_route ??= crypto.randomBytes(16).toString("hex");
    const prefix = staticPrefix(record.name, record.static_route);
    record.urls.local = `${front.local}${prefix}`;
    record.urls.mesh = front.mesh === null ? null : `${front.mesh}${prefix}`;
    record.status = "serving";
    delete record.serve;
    delete record.failure;
    delete record.liveness;
    await this.store.writeEnv(record);
    return { record, warnings: front.error === null ? [] : [meshWarning(identity.online ? { ok: false, message: front.error, api: "localapi" } : undefined, `mesh URL unavailable; preview_url fell back to ${record.urls.local}`, front.error)], meshError: front.error };
  }

  async restoreSharedStatic(): Promise<void> {
    const records = (await this.store.listEnvs()).filter((record) => record.static_route !== undefined && record.status === "serving" && Date.parse(record.expires_at) > Date.now());
    if (records.length === 0) return;
    const identity = await this.identity();
    const front = await ensureSharedStatic(this.store, identity.online ? identity.dnsName : undefined);
    for (const record of records) {
      const prefix = staticPrefix(record.name, record.static_route!);
      const local = `${front.local}${prefix}`;
      const mesh = front.mesh === null ? null : `${front.mesh}${prefix}`;
      if (record.urls.local === local && record.urls.mesh === mesh) continue;
      await this.store.updateEnv(record.name, (current) => {
        if (current.static_route !== record.static_route || current.status !== "serving") return;
        current.urls.local = local;
        current.urls.mesh = mesh;
      }, { bestEffort: true });
    }
  }

  private async waitReady(port: number, readyPath: string, timeoutMs: number): Promise<URL | undefined> {
    const pathPart = readyPath.startsWith("/") ? readyPath : `/${readyPath}`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const host of ["127.0.0.1", "[::1]"]) {
        const url = new URL(`http://${host}:${port}${pathPart}`);
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
          if (response.status === 200) return url;
        } catch {
          // Process startup races are expected until the timeout.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  }

  private async publishDev(options: {
    repo: string;
    branch: string;
    slot?: BranchSlot;
    recipe: Recipe;
    ttlMs: number;
    worktree?: string;
    packet?: string;
    verify?: boolean;
  }): Promise<Record<string, unknown>> {
    if (options.recipe.dev === undefined) throw new NectarError("E_NO_RECIPE", "Recipe does not declare [dev]");
    const name = envName(options.recipe.name, options.branch, "dev");
    return this.store.withLock(name, async () => {
      const initial = await this.initialRecord({ ...options, mode: "dev" });
      const record = await this.checkout(
        initial.record,
        initial.old,
        options.worktree,
        initial.identity.config.worktree_cache_allowlist,
        options.slot?.commit,
      );
      try {
        const branchRecipe = await loadRecipe(record.worktree);
        const dev = branchRecipe.dev;
        if (dev === undefined) throw new NectarError("E_NO_RECIPE", "Published branch does not declare [dev]");
        record.dev = {
          run: dev.run,
          kind: dev.kind,
          ready_timeout_ms: dev.readyTimeoutMs,
          ...(dev.warm === undefined
            ? {}
            : { warm_hash: crypto.createHash("sha256").update(`${record.commit}\0${dev.warm}`).digest("hex") }),
        };
        if (dev.warm !== undefined) {
          const warmed = await runShell(
            dev.warm,
            record.worktree,
            scrubbedEnvironment({ NECTAR_ENV: record.name, NECTAR_ENV_DIR: record.worktree }),
          );
          if (warmed.exitCode !== 0) {
            throw new NectarError("E_INSTALL", `Dev warm command failed: ${dev.warm}`, {
              log_tail: [...warmed.stdout.split("\n"), ...warmed.stderr.split("\n")].filter(Boolean).slice(-40),
            });
          }
        }
        record.status = "warm";
        delete record.failure;
        await this.store.writeEnv(record);
        if (options.verify === true) {
          await this.startDevRuntime(record, dev);
          await this.stopRuntime(record);
          delete record.serve;
          record.status = "warm";
          await this.store.writeEnv(record);
        }
        return this.publishResult(record, this.packetFields(record), [], {
          status: record.status,
          verified: options.verify === true,
        });
      } catch (error) {
        if (record.serve !== undefined) {
          await this.rollbackRuntime(record, error);
        } else {
          const failure = asNectarError(error);
          record.status = "crashed";
          record.failure = {
            code: failure.code,
            message: failure.message,
            failed_at: new Date().toISOString(),
            log_tail: Array.isArray(failure.details.log_tail)
              ? failure.details.log_tail.filter((line): line is string => typeof line === "string")
              : [],
          };
          await this.store.writeEnv(record);
        }
        throw error;
      }
    });
  }

  private async startDevRuntime(
    record: EnvRecord,
    recipe: DevRecipe,
    target?: string,
  ): Promise<void> {
    const readyFile = path.join(record.worktree, "ready");
    await trashPaths([readyFile], record.worktree);
    const config = await this.store.readConfig();
    const log = await prepareLog(this.paths, record.name, config.log_max_bytes);
    const childEnv = scrubbedEnvironment({
      NECTAR_ENV: record.name,
      NECTAR_ENV_DIR: record.worktree,
      ...(target === undefined ? {} : { NECTAR_OPEN_TARGET: target }),
    });
    const child = spawnDetached(recipe.run, record.worktree, childEnv, log);
    record.serve = { cmd: recipe.run, ...child };
    record.status = "publishing";
    await this.store.writeEnv(record);
    if (!(await this.waitDevReady(readyFile, child.pid, recipe.readyTimeoutMs))) {
      throw new NectarError(
        "E_SERVE_TIMEOUT",
        `Dev instance did not stay alive and write ${readyFile} within ${recipe.readyTimeoutMs}ms`,
        { log_tail: await logTail(this.paths, record.name) },
      );
    }
    record.status = "serving";
    delete record.failure;
    delete record.liveness;
    await this.store.writeEnv(record);
  }

  private async waitDevReady(readyFile: string, pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return false;
      try {
        const info = await stat(readyFile);
        if (info.isFile()) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  private async publishDesktop(options: {
    repo: string;
    branch: string;
    slot?: BranchSlot;
    recipe: Recipe;
    ttlMs: number;
    worktree?: string;
    packet?: string;
  }): Promise<Record<string, unknown>> {
    const desktop = options.recipe.desktop;
    if (desktop === undefined) throw new NectarError("E_NO_RECIPE", "Recipe does not declare [desktop]");
    let embeddedWeb: PublishedWeb | undefined;
    if (desktop.embedUrl === "web") {
      if (options.recipe.web === undefined) throw new NectarError("E_NO_RECIPE", "[desktop].embed_url='web' requires [web]");
      embeddedWeb = await this.publishWeb({
        repo: options.repo,
        branch: options.branch,
        recipe: options.recipe,
        ttlMs: options.ttlMs,
        ...(options.packet === undefined ? {} : { packet: options.packet }),
      });
    }

    const name = envName(options.recipe.name, options.branch, "desktop");
    return this.store.withLock(name, async () => {
      const initial = await this.initialRecord({ ...options, mode: "desktop" });
      const record = await this.checkout(
        initial.record,
        initial.old,
        options.worktree,
        initial.identity.config.worktree_cache_allowlist,
        options.slot?.commit,
      );
      try {
        const branchRecipe = await loadRecipe(record.worktree);
        if (branchRecipe.desktop === undefined) throw new NectarError("E_NO_RECIPE", "Published branch does not declare [desktop]");
        const packResult = await this.buildTestpack(record, branchRecipe.desktop, initial.identity, embeddedWeb?.record);
        const packetFields: PacketFields = {
          preview_url: embeddedWeb === undefined ? null : embeddedWeb.record.urls.mesh ?? embeddedWeb.record.urls.local,
          testpack_ref: record.ref,
          dev_ref: null,
          shell_recipe: null,
          public_url: liveExposureUrl(record),
        };
        return this.publishResult(record, packetFields, embeddedWeb?.warnings ?? [], {
          sha256: packResult.sha256,
          size_bytes: packResult.size,
          ...(embeddedWeb === undefined ? {} : { web_env: embeddedWeb.record.name, mesh_error: embeddedWeb.meshError }),
        });
      } catch (error) {
        record.status = "crashed";
        await this.store.writeEnv(record);
        throw error;
      }
    });
  }

  private async packArtifact(
    record: EnvRecord,
    packCmd: string,
    platform: string,
  ): Promise<{ staging: string; packRoot: string; base: string; packDirectory: string }> {
    const base = `${record.app}--${branchSlug(record.branch)}--${platform}`;
    const packDirectory = path.join(this.paths.packs, record.name);
    const staging = path.join(packDirectory, `.staging-${process.pid}-${crypto.randomBytes(3).toString("hex")}`);
    const packOut = path.join(staging, `${base}.testpack`);
    await mkdir(staging, { recursive: true });
    try {
      const env = scrubbedEnvironment({
        NECTAR_ENV: record.name,
        NECTAR_ENV_DIR: record.worktree,
        NECTAR_PACK_OUT: packOut,
        NECTAR_PACK_PLATFORM: platform,
      });
      const built = await runShell(packCmd, record.worktree, env);
      if (built.exitCode !== 0) {
        record.status = "crashed";
        await this.store.writeEnv(record);
        throw new NectarError("E_INSTALL", `Pack command failed: ${packCmd}`, {
          log_tail: [...built.stdout.split("\n"), ...built.stderr.split("\n")].filter(Boolean).slice(-40),
        });
      }

      let packRoot = packOut;
      if (!(await pathExists(packRoot))) {
        const zipOut = `${packOut}.zip`;
        if (!(await pathExists(zipOut))) {
          record.status = "crashed";
          await this.store.writeEnv(record);
          throw new NectarError("E_NO_RECIPE", `Pack command did not produce $NECTAR_PACK_OUT (${packOut}) or ${zipOut}`);
        }
        packRoot = await extractTestpack(zipOut, path.join(staging, "extracted"));
      }
      return { staging, packRoot, base, packDirectory };
    } catch (error) {
      await trashPaths([staging], this.paths.root).catch(() => undefined);
      throw error;
    }
  }

  private manifestBase(record: EnvRecord, identity: MachineIdentity): Pick<TestpackManifest, "built_at" | "built_by"> {
    const publisher = record.publisher;
    return {
      built_at: new Date().toISOString(),
      built_by: {
        ...(publisher.hive_bee === undefined ? {} : { hive_bee: publisher.hive_bee }),
        ...(publisher.hive_session === undefined ? {} : { hive_session: publisher.hive_session }),
        host: identity.host,
      },
    };
  }

  private async finalizePack(
    record: EnvRecord,
    pack: { staging: string; packRoot: string; base: string; packDirectory: string },
    manifest: TestpackManifest,
    identity: MachineIdentity,
  ): Promise<{ sha256: string; size: number }> {
    await writeManifest(pack.packRoot, manifest);
    const temporaryZip = path.join(pack.staging, `${pack.base}.testpack.zip`);
    await createTestpackZip(pack.packRoot, temporaryZip, `${pack.base}.testpack`);
    const digest = await sha256(temporaryZip);
    const size = await fileSize(temporaryZip);
    const finalZip = path.join(pack.packDirectory, `${pack.base}.testpack.zip`);
    // rename replaces atomically — trashing first would leave a serving env's
    // resolve pointing at a 404 if we die between the two.
    await rename(temporaryZip, finalZip);
    const encodedPath = `${encodeURIComponent(record.name)}/${encodeURIComponent(path.basename(finalZip))}`;
    record.testpack = {
      file: path.basename(finalZip),
      sha256: digest,
      size_bytes: size,
      platform: manifest.platform,
      entry: manifest.entry,
      url: identity.dnsName === undefined ? null : `https://${identity.dnsName}:8440/${encodedPath}`,
      ...(manifest.bundle_id === undefined ? {} : { bundle_id: manifest.bundle_id }),
    };
    await this.store.writeEnv(record);
    return { sha256: digest, size };
  }

  private async buildTestpack(
    record: EnvRecord,
    recipe: DesktopRecipe,
    identity: MachineIdentity,
    embeddedWeb?: EnvRecord,
  ): Promise<{ sha256: string; size: number }> {
    const platform = currentPlatform();
    const pack = await this.packArtifact(record, recipe.pack, platform);
    try {
      const draft = await readAndValidateManifest(pack.packRoot);
      const embedCandidate =
        recipe.embedUrl === "web"
          ? embeddedWeb?.urls.mesh ?? embeddedWeb?.urls.local
          : recipe.embedUrl;
      // Never bake a publisher-loopback URL into a cross-machine artifact — the
      // manifest is immutable, and that webview could only ever load on the
      // publishing machine (F2 covers preview_url, not this).
      const embedUrl =
        typeof embedCandidate === "string" && embedCandidate.startsWith("http://127.0.0.1") ? undefined : embedCandidate;
      const manifest: TestpackManifest = {
        testpack: 1,
        app: record.app,
        branch: record.branch,
        commit: record.commit,
        platform,
        kind: recipe.kind,
        entry: draft.entry,
        ...(embedUrl === undefined || embedUrl === null ? {} : { embed: { mode: "webview", url: embedUrl } }),
        ...this.manifestBase(record, identity),
      };
      const result = await this.finalizePack(record, pack, manifest, identity);
      record.status = "serving";
      await this.store.writeEnv(record);
      return result;
    } finally {
      await trashPaths([pack.staging], this.paths.root).catch(() => undefined);
    }
  }

  private async publishIos(options: {
    repo: string;
    branch: string;
    slot?: BranchSlot;
    recipe: Recipe;
    ttlMs: number;
    worktree?: string;
    packet?: string;
  }): Promise<Record<string, unknown>> {
    if (options.recipe.ios === undefined) throw new NectarError("E_NO_RECIPE", "Recipe does not declare [ios]");
    if (process.env.NECTAR_XCRUN_BIN === undefined && !isAppleSiliconMac()) {
      throw new NectarError("E_PLATFORM", "--mode ios requires an Apple Silicon macOS host with Xcode simulators");
    }
    const name = envName(options.recipe.name, options.branch, "ios");
    return this.store.withLock(name, async () => {
      const records = await this.store.listEnvs();
      const activeSims = records.filter(
        (record) => record.name !== name && record.mode === "ios" && holdsRuntime(record.status) && record.serve !== undefined,
      );
      const config = await this.store.readConfig();
      if (activeSims.length >= config.serving_sim_limit) {
        throw new NectarError("E_QUOTA", "Cannot start another simulator stream on this host; publish on another Mac or stop an iOS preview you no longer need");
      }
      const initial = await this.initialRecord({ ...options, mode: "ios" });
      if (initial.old?.sim_udid !== undefined) {
        initial.record.sim_udid = initial.old.sim_udid;
        initial.record.sim_device = initial.old.sim_device ?? `nectar-${name}`;
        await this.store.writeEnv(initial.record);
      }
      const record = await this.checkout(
        initial.record,
        initial.old,
        options.worktree,
        initial.identity.config.worktree_cache_allowlist,
        options.slot?.commit,
      );
      try {
        const branchRecipe = await loadRecipe(record.worktree);
        const ios = branchRecipe.ios;
        if (ios === undefined) throw new NectarError("E_NO_RECIPE", "Published branch does not declare [ios]");
        const pack = await this.buildSimpack(record, ios, initial.identity);
        try {
          const warnings: string[] = [];
          let axUrl: string | null = null;
          if (ios.stream) {
            // simctl failures fail the publish (F13); serve-sim failures only degrade it (F12).
            const sim = await this.ensureSimDevice(record, ios);
            await installSimApp(sim.udid, pack.entryPath);
            await launchSimApp(sim.udid, ios.bundleId);
            try {
              const stream = await this.startSimStream(record, sim.device, ios.readyTimeoutMs, initial.identity, initial.old);
              warnings.push(...stream.warnings);
              const streamUrl = record.urls.mesh ?? record.urls.local;
              if (streamUrl !== null) axUrl = `${streamUrl}/ax`;
            } catch (error) {
              // F12: keep the simpack, but never leak the stream process, its serve
              // entry, or a booted RAM-heavy simulator that no longer streams.
              const cleanupErrors = await this.cleanupRuntime(record);
              if (record.sim_udid !== undefined) await shutdownSim(record.sim_udid).catch(() => undefined);
              warnings.push(
                `stream unavailable — publish degraded to simpack-only: ${error instanceof Error ? error.message : String(error)}${cleanupErrors.length === 0 ? "" : ` (cleanup: ${cleanupErrors.join("; ")})`}`,
              );
            }
          } else {
            warnings.push("[ios].stream is false — simpack-only publish");
          }
          record.status = "serving";
          await this.store.writeEnv(record);
          return this.publishResult(record, this.packetFields(record), warnings, {
            sha256: pack.sha256,
            size_bytes: pack.size,
            ...(record.sim_udid === undefined ? {} : { sim_udid: record.sim_udid }),
            ax_url: axUrl,
          });
        } finally {
          await trashPaths([pack.staging], this.paths.root).catch(() => undefined);
        }
      } catch (error) {
        // F13: a crashed publish must not leak the nectar-created device.
        await this.releaseSim(record).catch(() => undefined);
        await this.rollbackRuntime(record, error);
        throw error;
      }
    });
  }

  private async buildSimpack(
    record: EnvRecord,
    recipe: IosRecipe,
    identity: MachineIdentity,
  ): Promise<{ sha256: string; size: number; entryPath: string; staging: string }> {
    const platform = iosSimPlatform();
    const pack = await this.packArtifact(record, recipe.pack, platform);
    try {
      const draft = await readAndValidateManifest(pack.packRoot);
      const manifest: TestpackManifest = {
        testpack: 1,
        app: record.app,
        branch: record.branch,
        commit: record.commit,
        platform,
        kind: "ios-sim",
        entry: draft.entry,
        bundle_id: recipe.bundleId,
        ...this.manifestBase(record, identity),
      };
      const result = await this.finalizePack(record, pack, manifest, identity);
      // The staging tree stays alive on success — simctl installs entryPath from it;
      // the publishIos caller trashes it when done.
      return { ...result, entryPath: path.join(pack.packRoot, draft.entry), staging: pack.staging };
    } catch (error) {
      await trashPaths([pack.staging], this.paths.root).catch(() => undefined);
      throw error;
    }
  }

  private async ensureSimDevice(record: EnvRecord, recipe: IosRecipe): Promise<{ udid: string; device: string }> {
    const deviceName = record.sim_device ?? `nectar-${record.name}`;
    if (record.sim_udid !== undefined) {
      const devices = await listDevices();
      if (devices.some((device) => device.udid === record.sim_udid && device.available)) {
        await bootSim(record.sim_udid);
        return { udid: record.sim_udid, device: deviceName };
      }
      delete record.sim_udid;
    }
    const runtime = selectRuntime(await listRuntimes(), recipe.runtime);
    const deviceType = selectDeviceType(await listDeviceTypes(), recipe.device);
    const udid = await createSimDevice(deviceName, deviceType.identifier, runtime.identifier);
    record.sim_udid = udid;
    record.sim_device = deviceName;
    await this.store.writeEnv(record);
    await bootSim(udid);
    return { udid, device: deviceName };
  }

  private async startSimStream(
    record: EnvRecord,
    deviceName: string,
    readyTimeoutMs: number,
    identity: MachineIdentity,
    old: EnvRecord | undefined,
  ): Promise<{ warnings: string[] }> {
    const log = await prepareLog(this.paths, record.name, identity.config.log_max_bytes);
    const childEnv = scrubbedEnvironment({ NECTAR_ENV: record.name, NECTAR_ENV_DIR: record.worktree });
    const { upstreamPort, tailnetPort, foreignPort } = await this.allocateAndSpawn(record, identity, old, (port) => {
      const command = serveSimCommand(deviceName, port);
      return { ...spawnDetached(command, record.worktree, childEnv, log), cmd: command };
    });
    const warnings = movedWarning(foreignPort, tailnetPort);
    await this.store.writeEnv(record);
    const readyUrl = await this.waitReady(upstreamPort, "/", readyTimeoutMs);
    if (readyUrl === undefined) {
      throw new NectarError("E_SERVE_TIMEOUT", `serve-sim did not become ready within ${readyTimeoutMs}ms`, {
        log_tail: await logTail(this.paths, record.name),
      });
    }
    record.urls.local = readyUrl.origin;
    let mesh: ServeOutcome | undefined;
    if (identity.online && identity.dnsName !== undefined) mesh = await serveWeb(tailnetPort, readyUrl.origin);
    if (mesh?.ok === true && identity.dnsName !== undefined) {
      record.urls.mesh = `https://${identity.dnsName}:${tailnetPort}`;
    } else {
      record.urls.mesh = null;
      warnings.push(meshWarning(mesh, `stream URL fell back to ${record.urls.local}`, identity.offline));
    }
    await this.store.writeEnv(record);
    return { warnings };
  }

  private packetFields(record: EnvRecord): PacketFields {
    return packetFieldsFor(record.mode, record.ref, record.urls, liveExposureUrl(record));
  }

  private publishResult(
    record: EnvRecord,
    packetFields: PacketFields,
    warnings: string[],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      eid: record.eid,
      env: record.name,
      mode: record.mode,
      branch: record.branch,
      ...(record.branch_source === undefined ? {} : { branch_source: record.branch_source }),
      commit: record.commit,
      ref: record.ref,
      urls: record.urls,
      packet_fields: packetFields,
      preview_url: packetFields.preview_url,
      evidence: record.evidence,
      expires_at: record.expires_at,
      warnings,
      ...extra,
    };
  }

  private async refreshLiveness(record: EnvRecord): Promise<EnvRecord> {
    if (!hasProbeableServe(record)) return record;
    const serve = record.serve;
    const liveness = await probeLiveness(serve);
    if (givenUp(record)) {
      record.liveness = liveness;
      return record;
    }
    const previous = { status: record.status, reason: record.liveness?.reason };
    record.status = liveness.state;
    record.liveness = liveness;
    if (this.readOnly !== undefined || (previous.status === liveness.state && previous.reason === liveness.reason)) return record;
    await this.store.updateEnv(
      record.name,
      (current) => {
        if (!hasProbeableServe(current) || current.serve.pid !== serve.pid || givenUp(current)) return;
        current.status = liveness.state;
        current.liveness = liveness;
      },
      { bestEffort: true },
    );
    return record;
  }

  async revive(name: string, options: { expectPid: number; kill: boolean }): Promise<ReviveResult> {
    return this.store.withLock(validateEnvName(name), async () => {
      const record = await this.store.readEnv(name);
      if (record.mode !== "web" || !hasProbeableServe(record) || record.serve.pid !== options.expectPid) {
        return { revived: false, reason: "record_changed" };
      }
      await this.adoptLegacy(record);
      const serve = record.serve;
      if (serve.upstream_port === undefined) return { revived: false, reason: "no_upstream_port" };
      const identity = await this.identity();
      if (groupAlive(serve.pgid) && ownershipRefusal(serve) !== undefined) await stopEnvGroup(serve);
      if (options.kill) await stopEnvGroup(serve);
      const isStatic = serve.cmd.includes("static-server.js");
      const recipe = isStatic
        ? staticWebRecipe()
        : await loadRecipe(record.worktree)
            .then((loaded) => loaded.web)
            .catch(() => undefined);
      const cmd = isStatic && recipe !== undefined ? recipe.serve : serve.cmd;
      const readyPath = recipe?.readyPath ?? "/";
      const readyTimeoutMs = recipe?.readyTimeoutMs ?? 60_000;
      const fail = async (code: string, message: string): Promise<ReviveResult> => {
        record.status = "crashed";
        record.failure = { code, message, failed_at: new Date().toISOString(), log_tail: await logTail(this.paths, record.name) };
        await this.store.writeEnv(record);
        return { revived: false, reason: code };
      };
      if (!(await portAvailable(serve.upstream_port))) {
        await this.abandon(record, "E_PORTS", `Upstream port ${serve.upstream_port} is held by a process Nectar did not start`);
        await this.store.writeEnv(record);
        return { revived: false, reason: "E_PORTS" };
      }
      if (Object.values(record.deps ?? {}).some((dep) => dep.kind === "postgres")) {
        try {
          await this.startDeps(record);
        } catch (error) {
          return fail(asNectarError(error).code, asNectarError(error).message);
        }
      }
      const log = await prepareLog(this.paths, record.name, identity.config.log_max_bytes);
      const childEnv = scrubbedEnvironment({
        ...recipe?.env,
        ...(await this.depEnv(record)),
        PORT: String(serve.upstream_port),
        NECTAR_ENV: record.name,
        NECTAR_ENV_DIR: record.worktree,
      });
      let spawned: ReturnType<typeof spawnDetached>;
      try {
        spawned = spawnDetached(cmd, record.worktree, childEnv, log);
      } catch (error) {
        return fail("E_CHECKOUT", asNectarError(error).message);
      }
      record.serve = { ...serve, cmd, ...spawned, started_at: new Date().toISOString() };
      await this.store.writeEnv(record);
      const readyUrl = await this.waitReady(serve.upstream_port, readyPath, readyTimeoutMs);
      if (readyUrl === undefined) {
        await stopEnvGroup(spawned);
        return fail("E_SERVE_TIMEOUT", `Serve did not return HTTP 200 at ${readyPath} within ${readyTimeoutMs}ms`);
      }
      if (record.serve !== undefined) record.serve.upstream_host = readyUrl.hostname.replace(/^\[|\]$/g, "");
      record.urls.local = serve.proxy_port === undefined ? readyUrl.origin : `http://127.0.0.1:${serve.proxy_port}`;
      const mesh = await this.assertMesh(record, identity);
      record.status = "serving";
      delete record.failure;
      delete record.liveness;
      await this.store.writeEnv(record);
      return { revived: true, reason: "spawned", pid: spawned.pid, mesh };
    });
  }

  async reassertMesh(name: string): Promise<boolean> {
    const identity = await this.identity();
    let asserted = false;
    await this.store.updateEnv(
      name,
      async (record) => {
        if (record.mode === "web" && (holdsRuntime(record.status) || record.status === "warm")) asserted = await this.assertMesh(record, identity);
      },
      { bestEffort: true },
    );
    return asserted;
  }

  private async assertMesh(record: EnvRecord, identity: MachineIdentity): Promise<boolean> {
    const tailnetPort = record.serve?.tailnet_port;
    if (tailnetPort === undefined || record.urls.local === null || !identity.online || identity.dnsName === undefined) {
      return false;
    }
    if (record.serve !== undefined && (await this.foreignServeAt(record.serve))) {
      record.urls.mesh = null;
      return false;
    }
    if (!(await serveWeb(tailnetPort, await this.meshTarget(record))).ok) return false;
    record.urls.mesh = `https://${identity.dnsName}:${tailnetPort}`;
    return true;
  }

  private async meshTarget(record: EnvRecord): Promise<string> {
    const serve = record.serve;
    const host = serve?.upstream_host === "::1" ? "[::1]" : serve?.upstream_host ?? "127.0.0.1";
    const direct = serve?.proxy_port !== undefined && serve.upstream_port !== undefined
      ? `http://${host}:${serve.upstream_port}`
      : record.urls.local ?? `http://${host}:${serve?.upstream_port}`;
    const proxyPort = serve?.proxy_port;
    if (proxyPort === undefined) return direct;
    const upstream = await probeProxy(proxyPort, record.name);
    return upstream !== undefined ? `http://127.0.0.1:${proxyPort}` : direct;
  }

  async assignProxyPort(name: string): Promise<number | undefined> {
    return this.store.withLock(PORTS_LOCK, async () => {
      const config = await this.store.readConfig();
      const reserved = loopbackPorts(await this.store.listEnvs());
      reserved.add(config.pack_server_port);
      const port = await allocatePort({ start: config.upstream_port_start, end: config.upstream_port_end, reserved });
      const updated = await this.store.updateEnv(
        name,
        (record) => {
          if (record.serve !== undefined && record.serve.proxy_port === undefined) record.serve.proxy_port = port;
        },
        { bestEffort: true },
      );
      return updated?.serve?.proxy_port;
    });
  }

  async releaseProxyPort(name: string, port: number): Promise<void> {
    await this.store.updateEnv(
      name,
      (record) => {
        if (record.serve?.proxy_port === port) delete record.serve.proxy_port;
      },
      { bestEffort: true },
    );
  }

  async unfront(name: string): Promise<boolean> {
    let restored = false;
    await this.store.updateEnv(
      name,
      async (record) => {
        const serve = record.serve;
        const tailnetPort = serve?.tailnet_port;
        if (record.mode !== "web" || record.urls.mesh === null || record.urls.local === null || serve === undefined || tailnetPort === undefined) return;
        if (await this.foreignServeAt(serve)) return;
        if (serve.upstream_port === undefined) return;
        const host = serve.upstream_host === "::1" ? "[::1]" : serve.upstream_host ?? "127.0.0.1";
        restored = (await serveWeb(tailnetPort, `http://${host}:${serve.upstream_port}`)).ok;
      },
      { bestEffort: true },
    );
    return restored;
  }

  async touchView(name: string): Promise<string | undefined> {
    const now = new Date();
    await this.store.updateEnv(name, (record) => { record.last_opened_at = now.toISOString(); record.last_viewed_at = now.toISOString(); }, { bestEffort: true });
    return (await this.touchRecord(name, now))?.expires_at;
  }

  async giveUp(name: string, expectPid: number, code: string, message: string): Promise<boolean> {
    const updated = await this.store.updateEnv(name, async (record) => {
      if (record.serve?.pid === expectPid) await this.abandon(record, code, message);
    });
    return updated?.failure?.code === code;
  }

  private async abandon(record: EnvRecord, code: string, message: string): Promise<void> {
    if (record.serve !== undefined) await this.releaseServeEntry(record.serve);
    record.status = "crashed";
    record.urls.mesh = null;
    record.failure = { code, message, failed_at: new Date().toISOString(), log_tail: await logTail(this.paths, record.name) };
  }

  async list(options: { mode?: string; status?: string; host?: string } = {}): Promise<Record<string, unknown>> {
    if (options.host !== undefined && !(await this.isLocalHost(options.host))) {
      const filters = { mode: options.mode, status: options.status };
      const flags = [...(options.mode === undefined ? [] : ["--mode", options.mode]), ...(options.status === undefined ? [] : ["--status", options.status])];
      return this.remote(options.host, "ls", Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)), ["ls", ...flags, "--json"]);
    }
    await this.clearDeadPublishing();
    const refreshed = await Promise.all((await this.store.listEnvs()).map(async (record) => this.refreshLiveness(record)));
    const envs = refreshed
      .filter((record) => options.mode === undefined || record.mode === options.mode)
      .filter((record) => options.status === undefined || record.status === options.status)
      .map((record) => ({
        name: record.name,
        mode: record.mode,
        status: record.status,
        mesh_url: record.urls.mesh,
        expires_at: record.expires_at,
        expires_in: formatRemaining(record.expires_at),
        publisher_bee: record.publisher.hive_bee ?? null,
        liveness: record.liveness ?? null,
        failure: record.failure?.code ?? null,
      }));
    return { envs };
  }

  async show(input: string): Promise<Record<string, unknown>> {
    if (isRef(input)) {
      const parsed = parseRef(input);
      if (!(await this.isLocalHost(parsed.host))) return this.remote(parsed.host, "show", { target: parsed.env }, ["show", parsed.env, "--json"]);
      input = parsed.env;
    }
    const record = await this.refreshLiveness(await this.store.readEnv(validateEnvName(input)));
    await this.touchOnView(record);
    return {
      env: record,
      name: record.name,
      mode: record.mode,
      status: record.status,
      ref: record.ref,
      urls: record.urls,
      serve: record.serve ?? null,
      pid: record.serve?.pid ?? null,
      pgid: record.serve?.pgid ?? null,
      ports: { upstream: record.serve?.upstream_port ?? null, tailnet: record.serve?.tailnet_port ?? null },
      liveness: record.liveness ?? null,
      deps: redactedDeps(record.deps),
      expires_at: record.expires_at,
      expires_in: formatRemaining(record.expires_at),
      failure: record.failure ?? null,
      ...this.touchNote(),
      ...(record.status === "crashed" || record.status === "unhealthy" ? { log_tail: await logTail(this.paths, record.name) } : {}),
    };
  }

  private async isLocalHost(host: string, knownIdentity?: MachineIdentity): Promise<boolean> {
    const identity = knownIdentity ?? (await this.identity());
    const requested = hostAliases(host);
    const local = [identity.host, identity.dnsName, os.hostname()].flatMap((value) => [...hostAliases(value)]);
    return local.some((alias) => requested.has(alias));
  }

  private isQualified(name: string): boolean {
    return name.endsWith("--web") || name.endsWith("--desktop") || name.endsWith("--ios") || name.endsWith("--dev") || name.endsWith("--cli") || name.endsWith("--backend");
  }

  private async commitState(record: EnvRecord): Promise<{ currentCommit: string | null; stale: boolean }> {
    if (record.mode !== "dev") return { currentCommit: record.commit, stale: false };
    try {
      const currentCommit = await shortCommit(record.worktree);
      return { currentCommit, stale: currentCommit !== record.commit };
    } catch {
      return { currentCommit: null, stale: true };
    }
  }

  // Touch re-arms the env's own TTL (SPEC §4.4), not the default; a busy lock
  // means a publish is mid-flight — skip, the env is active anyway.
  private async touchOnView(record: EnvRecord): Promise<void> {
    if (this.readOnly !== undefined || record.status === "expired" || record.status === "cold") return;
    const touched = await this.touchRecord(record.name, new Date());
    if (touched !== undefined) {
      record.last_touched_at = touched.last_touched_at;
      record.expires_at = touched.expires_at;
    }
  }

  private async touchRecord(name: string, now: Date): Promise<EnvRecord | undefined> {
    let touched = false;
    const updated = await this.store.updateEnv(
      name,
      (current) => {
        if (current.status === "expired" || current.status === "cold") return;
        current.last_touched_at = now.toISOString();
        current.expires_at = expiresAt(now, current.ttl_ms ?? parseDuration(DEFAULT_TTL));
        touched = true;
      },
      { bestEffort: true },
    );
    return touched ? updated : undefined;
  }

  private async localResolve(name: string, host: string, isSelf: boolean, touch = true): Promise<ResolveResult | MultiResolveResult> {
    const records = this.isQualified(name)
      ? [await this.store.readEnv(validateEnvName(name))]
      : (await this.store.listEnvs()).filter((record) => record.name.startsWith(`${validateEnvName(name)}--`));
    if (records.length === 0) throw new NectarError("E_NOT_FOUND", `Environment '${name}' was not found on this machine`);
    const resolutions: ResolveResult[] = [];
    for (const original of records) {
      const record = await this.refreshLiveness(original);
      if (touch) await this.touchOnView(record);
      const streamUrl = isSelf ? record.urls.local ?? record.urls.mesh : record.urls.mesh ?? record.urls.local;
      const commitState = await this.commitState(record);
      const packetFields = this.packetFields(record);
      const dead = packetFields.preview_url !== null && DEAD_STATUSES.has(record.status);
      resolutions.push({
        env: record.name,
        ref: record.ref,
        mode: record.mode,
        commit: record.commit,
        current_commit: commitState.currentCommit,
        stale: commitState.stale,
        is_self: isSelf,
        urls: record.urls,
        testpack_url: record.testpack?.url ?? null,
        sha256: record.testpack?.sha256 ?? null,
        size_bytes: record.testpack?.size_bytes ?? null,
        platform: record.testpack?.platform ?? null,
        entry: record.testpack?.entry ?? null,
        bundle_id: record.testpack?.bundle_id ?? null,
        ax_url: record.mode === "ios" && record.status === "serving" && streamUrl !== null ? `${streamUrl}/ax` : null,
        host,
        status: record.status,
        liveness: record.liveness ?? null,
        packet_fields: dead ? { ...packetFields, preview_url: null } : packetFields,
        ...(dead ? { preview_url_reason: `env is ${record.status}, so nothing serves its URLs; republish it to get a live preview_url` } : {}),
        expires_at: record.expires_at,
        expires_in: formatRemaining(record.expires_at),
        ...(touch ? this.touchNote() : {}),
        ...(record.status === "crashed" || record.status === "unhealthy" ? { log_tail: await logTail(this.paths, record.name) } : {}),
      });
    }
    return this.isQualified(name) ? (resolutions[0] as ResolveResult) : { env: name, host, is_self: isSelf, resolutions };
  }

  async resolve(input: string): Promise<ResolveResult | MultiResolveResult> {
    const identity = await this.identity();
    if (!isRef(input)) return this.localResolve(validateEnvName(input), identity.host, true);
    const parsed = parseRef(input);
    if (await this.isLocalHost(parsed.host, identity)) return this.localResolve(parsed.env, parsed.host, true);
    const remote = await this.remote<ResolveResult | MultiResolveResult>(parsed.host, "resolve", { target: parsed.env }, ["resolve", parsed.env, "--json"]);
    const remoteResolution = (resolution: ResolveResult): ResolveResult => {
      const ref = resolution.ref ?? `nectar://${parsed.host}/${resolution.env}`;
      return {
        ...resolution,
        ref,
        is_self: false,
        packet_fields: resolution.packet_fields ?? packetFieldsFor(resolution.mode, ref, resolution.urls, resolution.urls.public ?? null),
        expires_at: resolution.expires_at ?? null,
        expires_in: resolution.expires_in ?? null,
      };
    };
    if ("resolutions" in remote) return { ...remote, is_self: false, resolutions: remote.resolutions.map(remoteResolution) };
    return remoteResolution(remote);
  }

  private async remoteResult<T extends object = Record<string, unknown>>(host: string, args: string[]): Promise<T> {
    let response;
    try {
      response = await remoteNectar(host, args);
    } catch (error) {
      throw new NectarError("E_NOT_FOUND", `Host '${host}' unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.exitCode !== 0) {
      throw new NectarError("E_NOT_FOUND", `Host '${host}' unreachable or Nectar command failed: ${response.stderr.trim() || response.stdout.trim()}`);
    }
    let envelope: { ok?: boolean; result?: Record<string, unknown>; error?: { code?: string; message?: string } };
    try {
      envelope = JSON.parse(response.stdout) as typeof envelope;
    } catch {
      throw new NectarError("E_NOT_FOUND", `Host '${host}' returned an invalid Nectar envelope`);
    }
    if (!envelope.ok || envelope.result === undefined) {
      // Keep the remote's semantic code when it has one — flattening E_QUOTA or
      // E_PLATFORM into "not found" sends the caller down the wrong remediation.
      const code = isErrorCode(envelope.error?.code) ? envelope.error.code : "E_NOT_FOUND";
      throw new NectarError(code, envelope.error?.message ?? `Host '${host}' could not resolve the environment`);
    }
    return envelope.result as T;
  }

  async open(
    input: string,
    options: { noAx?: boolean; target?: string; keep?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const resolved = await this.resolve(input);
    if ("resolutions" in resolved) {
      throw new NectarError("E_NO_MODE", `Environment '${resolved.env}' has multiple modes; use a mode-qualified ref`);
    }
    if (resolved.mode === "dev") return this.openDev(resolved, options);
    if (resolved.mode === "web") {
      if (resolved.is_self && options.keep === true) await this.store.updateEnv(resolved.env, (record) => { record.pinned = true; });
      const url = resolved.is_self ? resolved.urls.local ?? resolved.urls.mesh : resolved.urls.mesh ?? resolved.urls.local;
      if (url === null) throw new NectarError("E_NOT_FOUND", `Web environment '${resolved.env}' has no reachable URL`);
      await this.launch(url);
      return { env: resolved.env, mode: resolved.mode, opened: url };
    }
    if (resolved.mode === "ios") return this.openIos(resolved);
    if (
      resolved.testpack_url === null ||
      resolved.sha256 === null ||
      resolved.platform === null ||
      resolved.entry === null
    ) {
      throw new NectarError("E_NOT_FOUND", `Desktop environment '${resolved.env}' has no complete testpack metadata`);
    }
    if (currentPlatform() !== resolved.platform) {
      throw new NectarError("E_PLATFORM", `Testpack is ${resolved.platform}; this machine is ${currentPlatform()}`);
    }
    const fetched = await this.fetchTestpack(resolved);
    const entry = await extractAndLaunch({
      zip: fetched.zip,
      sha: resolved.sha256,
      expectedPlatform: resolved.platform,
      expectedEntry: resolved.entry,
      paths: this.paths,
    });
    const ax = options.noAx === true ? {} : await this.startDesktopAx(entry);
    return {
      env: resolved.env,
      mode: resolved.mode,
      opened: entry,
      cache_hit: fetched.cacheHit,
      sha256: resolved.sha256,
      ...ax,
    };
  }

  private async openDev(
    resolved: ResolveResult,
    options: { target?: string; keep?: boolean },
  ): Promise<Record<string, unknown>> {
    if (!resolved.is_self) {
      return this.remoteResult(resolved.host, [
        "open",
        resolved.env,
        "--json",
        ...(options.target === undefined ? [] : ["--target", options.target]),
        ...(options.keep === true ? ["--keep"] : []),
      ]);
    }
    const name = validateEnvName(resolved.env);
    return this.store.withLock(name, async () => {
      const record = await this.store.readEnv(name);
      if (record.mode !== "dev") throw new NectarError("E_NO_MODE", `Environment '${name}' is not a dev environment`);
      if (record.status === "expired" || record.status === "cold") {
        throw new NectarError(
          "E_NOT_FOUND",
          `Dev environment '${name}' is ${record.status}; republish it or use a sibling --desktop testpack`,
        );
      }
      if (record.dev === undefined) {
        throw new NectarError("E_NOT_FOUND", `Dev environment '${name}' has no registered launch command; republish it`);
      }
      if (hasProbeableServe(record)) {
        const liveness = await probeLiveness(record.serve);
        record.status = liveness.state === "serving" ? "serving" : "crashed";
        record.liveness = liveness;
      }
      if (record.status === "serving" && record.serve === undefined) record.status = "crashed";
      if (record.status !== "serving" && record.serve !== undefined) {
        await this.stopRuntime(record);
        delete record.serve;
      }
      const openedAt = new Date().toISOString();
      const targetMessage =
        options.target === undefined
          ? undefined
          : {
              target: options.target,
              opened_at: openedAt,
              nonce: crypto.randomUUID(),
            };
      if (targetMessage !== undefined) await this.writeOpenTarget(record, targetMessage);
      record.last_opened_at = openedAt;
      if (options.keep === true) record.pinned = true;
      await this.store.writeEnv(record);

      let launched = false;
      if (record.status !== "serving") {
        if (record.status !== "warm" && record.status !== "crashed" && record.status !== "stopped") {
          throw new NectarError("E_BUSY", `Dev environment '${name}' is ${record.status}; retry shortly`);
        }
        const recipe: DevRecipe = {
          run: record.dev.run,
          kind: record.dev.kind,
          readyTimeoutMs: record.dev.ready_timeout_ms,
        };
        try {
          await this.startDevRuntime(record, recipe, options.target);
        } catch (error) {
          await this.rollbackRuntime(record, error);
          throw error;
        }
        launched = true;
        // The boot-time env var handles startup; rewriting the mailbox after
        // readiness also reaches consumers whose watcher attached during boot.
        if (targetMessage !== undefined) await this.writeOpenTarget(record, targetMessage);
      }
      if (record.serve === undefined) {
        throw new NectarError("E_INTERNAL", `Dev environment '${name}' reached serving without a process handle`);
      }
      return {
        env: record.name,
        mode: record.mode,
        status: record.status,
        launched,
        focused: !launched,
        handle: { pid: record.serve.pid, pgid: record.serve.pgid },
        target: options.target ?? null,
        pinned: record.pinned === true,
        last_opened_at: record.last_opened_at,
      };
    });
  }

  private async writeOpenTarget(
    record: EnvRecord,
    message: { target: string; opened_at: string; nonce: string },
  ): Promise<void> {
    const targetFile = path.join(record.worktree, "open-target.json");
    const temporary = `${targetFile}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(message)}\n`, { mode: 0o600 });
    await rename(temporary, targetFile);
  }

  private async launch(target: string): Promise<void> {
    const launcher = process.env.NECTAR_LAUNCH_BIN ?? "open";
    const result = await runCommand(launcher, [target]);
    if (result.exitCode !== 0) throw new NectarError("E_INTERNAL", result.stderr.trim() || `Could not open ${target}`);
  }

  private async fetchTestpack(resolved: ResolveResult): Promise<{ zip: string; cacheHit: boolean }> {
    if (resolved.testpack_url === null || resolved.sha256 === null) {
      throw new NectarError("E_NOT_FOUND", `Environment '${resolved.env}' has no complete testpack metadata`);
    }
    const local = await this.store.maybeEnv(resolved.env);
    const localSource =
      local?.testpack?.sha256 === resolved.sha256
        ? path.join(this.paths.packs, local.name, local.testpack.file)
        : undefined;
    return fetchVerified({
      url: resolved.testpack_url,
      expectedSha256: resolved.sha256,
      paths: this.paths,
      ...(localSource === undefined ? {} : { localSource }),
    });
  }

  private async openIos(resolved: ResolveResult): Promise<Record<string, unknown>> {
    const streamUrl = resolved.is_self ? resolved.urls.local ?? resolved.urls.mesh : resolved.urls.mesh ?? resolved.urls.local;
    const simCapable = (process.platform === "darwin" || process.env.NECTAR_XCRUN_BIN !== undefined) && process.env.NECTAR_IOS_OPEN !== "stream";
    const openStream = async (): Promise<Record<string, unknown>> => {
      if (streamUrl === null) {
        throw new NectarError("E_NOT_FOUND", `iOS environment '${resolved.env}' has no stream URL and no launchable simpack on this host`);
      }
      await this.launch(streamUrl);
      return { env: resolved.env, mode: resolved.mode, opened: streamUrl, surface: "stream", ax_url: resolved.ax_url };
    };
    if (!simCapable) return openStream();
    if (
      resolved.testpack_url === null ||
      resolved.sha256 === null ||
      resolved.entry === null ||
      resolved.platform === null ||
      resolved.bundle_id === null
    ) {
      return openStream();
    }
    if (resolved.platform !== iosSimPlatform()) {
      if (streamUrl !== null) return openStream();
      throw new NectarError("E_PLATFORM", `Simpack is ${resolved.platform}; this host is ${iosSimPlatform()}`);
    }
    const fetched = await this.fetchTestpack(resolved);
    const { entry } = await extractVerified({
      zip: fetched.zip,
      sha: resolved.sha256,
      expectedPlatform: resolved.platform,
      expectedEntry: resolved.entry,
      paths: this.paths,
    });
    try {
      const udid = await this.ensureScratchSim();
      await installSimApp(udid, entry);
      await launchSimApp(udid, resolved.bundle_id);
      return {
        env: resolved.env,
        mode: resolved.mode,
        opened: entry,
        surface: "simulator",
        sim_udid: udid,
        cache_hit: fetched.cacheHit,
        sha256: resolved.sha256,
        ax_url: resolved.ax_url,
      };
    } catch (error) {
      if (error instanceof NectarError && error.code === "E_SIM") {
        const hint = streamUrl === null ? "" : `; the stream needs no local runtime: ${streamUrl}`;
        throw new NectarError("E_PLATFORM", `${error.message}${hint}`, error.details);
      }
      throw error;
    }
  }

  private async ensureScratchSim(): Promise<string> {
    const devices = await listDevices();
    const existing = devices.find((device) => device.name === "nectar-open" && device.available);
    let udid = existing?.udid;
    if (udid === undefined) {
      const runtime = selectRuntime(await listRuntimes(), "latest");
      const deviceType = selectDeviceType(await listDeviceTypes(), "iPhone 17");
      udid = await createSimDevice("nectar-open", deviceType.identifier, runtime.identifier);
    }
    await bootSim(udid);
    return udid;
  }

  private async startDesktopAx(entry: string): Promise<Record<string, unknown>> {
    if (process.platform !== "darwin" && process.env.NECTAR_AX_HELPER === undefined) return {};
    try {
      const pid = await findAppPid(entry);
      if (pid === undefined) return { ax_warning: "could not find a running app process for the AX bridge" };
      const helper = await ensureAxHelper(this.paths);
      const config = await this.store.readConfig();
      const reserved = loopbackPorts(await this.store.listEnvs());
      reserved.add(config.pack_server_port);
      const port = await allocatePort({ start: config.upstream_port_start, end: config.upstream_port_end, reserved });
      const log = await prepareLog(this.paths, "ax-bridge", config.log_max_bytes);
      const bridgeEntry = process.env.NECTAR_AX_BRIDGE_ENTRY ?? fileURLToPath(new URL("./ax-bridge.js", import.meta.url));
      const child = spawnDetachedExecutable(
        process.execPath,
        [bridgeEntry, String(pid), String(port), helper],
        this.paths.root,
        scrubbedEnvironment(),
        log,
      );
      const deadline = Date.now() + 3_000;
      while (!(await portOpen(port)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!(await portOpen(port))) {
        await stopEnvGroup(child);
        return { ax_warning: "AX bridge did not start; see ax-bridge log" };
      }
      return { ax_url: `http://127.0.0.1:${port}/ax`, ax_pid: child.pid };
    } catch (error) {
      return { ax_warning: `AX bridge unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async touch(input: string, ttl?: string): Promise<Record<string, unknown>> {
    const ttlMs = ttl === undefined ? undefined : parseDuration(ttl, "ttl");
    if (isRef(input)) {
      const parsed = parseRef(input);
      if (!(await this.isLocalHost(parsed.host))) {
        return this.remote(parsed.host, "touch", ttl === undefined ? { target: parsed.env } : { target: parsed.env, ttl }, ["touch", parsed.env, ...(ttl === undefined ? [] : ["--ttl", ttl]), "--json"]);
      }
      input = parsed.env;
    }
    this.assertWritable("touch");
    const names = this.isQualified(input)
      ? [validateEnvName(input)]
      : (await this.store.listEnvs()).filter((record) => record.name.startsWith(`${validateEnvName(input)}--`)).map((record) => record.name);
    if (names.length === 0) throw new NectarError("E_NOT_FOUND", `Environment '${input}' was not found`);
    const now = new Date();
    const expiries: Record<string, string> = {};
    for (const name of names) {
      const updated = await this.store.updateEnv(name, (record) => {
        // An explicit --ttl re-arms with the requested TTL from here on.
        if (ttlMs !== undefined) record.ttl_ms = ttlMs;
        record.last_touched_at = now.toISOString();
        record.expires_at = expiresAt(now, record.ttl_ms ?? parseDuration(DEFAULT_TTL));
      });
      if (updated !== undefined) expiries[name] = updated.expires_at;
    }
    const unique = [...new Set(Object.values(expiries))];
    return { envs: names, touched_at: now.toISOString(), expires_at: unique.length === 1 ? unique[0] : expiries };
  }

  async stop(name: string): Promise<Record<string, unknown>> {
    if (isRef(name)) {
      const parsed = parseRef(name);
      if (!(await this.isLocalHost(parsed.host))) return this.remote(parsed.host, "stop", { env: parsed.env }, ["stop", parsed.env, "--json"]);
      name = parsed.env;
    }
    this.assertWritable("stop");
    const record = await this.store.withLock(validateEnvName(name), async () => {
      const current = await this.store.readEnv(name);
      await this.releaseRuntime(current);
      await this.stopDeps(current);
      // A stopped env's public URL would 502; take it down with the serve.
      await this.tearDownExposure(current).catch(() => undefined);
      if (current.mode === "dev") {
        delete current.serve;
        if (current.status !== "expired" && current.status !== "cold") current.status = "warm";
      }
      // Only running-ish states collapse to stopped; expired/cold stay where gc
      // put them so ls/resolve keep telling the truth.
      if (
        current.mode !== "dev" &&
        (holdsRuntime(current.status) || current.status === "warm" || current.status === "publishing" || current.status === "crashed")
      ) {
        current.status = "stopped";
      }
      delete current.liveness;
      await this.store.writeEnv(current);
      return current;
    });
    return { env: record.name, status: record.status };
  }

  async remove(name: string, force = false, detach = false): Promise<Record<string, unknown>> {
    if (isRef(name)) {
      const parsed = parseRef(name);
      if (!(await this.isLocalHost(parsed.host))) {
        const removed = await this.remote(parsed.host, "rm", { env: parsed.env, force, detach }, ["rm", parsed.env, ...(force ? ["--force"] : []), ...(detach ? ["--detach"] : []), "--json"]);
        if (this.readOnly === undefined) await this.forgetPlacement(parsed.host, parsed.env);
        return removed;
      }
      name = parsed.env;
    }
    this.assertWritable("rm");
    return this.store.withLock(validateEnvName(name), async () => {
      const record = await this.store.readEnv(name);
      if (detach) {
        await this.tearDownExposure(record);
        if (record.serve !== undefined && !(await this.releaseServeEntry(record.serve))) throw new NectarError("E_BUSY", "Route ownership unknown; detach refused");
        const auditDir = path.join(this.paths.root, "detached");
        await mkdir(auditDir, { recursive: true });
        const auditPath = path.join(auditDir, `${record.name}-${crypto.randomUUID()}.json`);
        await writeFile(auditPath, JSON.stringify({ status: "stale", detached_at: new Date().toISOString(), record }, null, 2), { mode: 0o600, flag: "wx" });
        await this.store.deleteEnvFile(record.name);
        return { env: record.name, detached: true, pid: record.serve?.pid ?? null, pgid: record.serve?.pgid ?? null, audit_path: auditPath, hint: "Processes were left untouched; verify the reported PGID before stopping it manually" };
      }
      if (holdsRuntime(record.status) && !force) {
        throw new NectarError("E_USAGE", `Environment '${name}' is ${record.status}; pass --force to stop and remove it`);
      }
      await this.stopRuntime(record);
      await this.releaseSim(record);
      await this.releaseDeps(record);
      const targets = [
        path.join(this.paths.packs, record.name),
        path.join(this.paths.evidence, record.name),
        path.join(this.paths.logs, record.name),
        this.store.envFile(record.name),
      ];
      if (!record.borrowed_worktree) targets.push(record.worktree);
      await this.tearDownExposure(record).catch(() => undefined);
      await trashPaths(targets, this.paths.root);
      await runGit(["worktree", "prune"], record.repo).catch(() => undefined);
      await this.releaseInbox(record);
      return { env: record.name, removed: true, forced: force, borrowed_worktree_preserved: record.borrowed_worktree };
    });
  }

  private async releaseInbox(record: EnvRecord): Promise<void> {
    const inbox = path.join(this.paths.root, "inbox");
    const key = path.relative(inbox, record.repo).split(path.sep)[0] ?? "";
    if (!/^[0-9a-f]{16}$/.test(key)) return;
    const slot = path.join(inbox, key);
    const others = (await this.store.listEnvs()).some((other) => other.name !== record.name && path.relative(slot, other.repo).split(path.sep)[0] !== "..");
    if (!others) await rm(slot, { recursive: true, force: true });
  }

  // Remove a live public route (nctr.site relay, D21). The relay's own hourly prune is
  // the backstop; this is the proactive half so a stopped/expired env stops answering
  // publicly at once. Best-effort: the relay being unreachable must not block gc/stop.
  private async tearDownExposure(record: EnvRecord): Promise<void> {
    if (record.exposure === undefined) return;
    const config = await this.store.readConfig();
    const target = config.exposures?.[record.exposure.target];
    if (target !== undefined && record.exposure.revoked_at === undefined) {
      if (record.exposure.control === "relayd") await relaydDelete(target, record.exposure.sub);
      else if (!usesRelayd(target)) await relayRm(target, record.exposure.sub);
    }
    delete record.exposure;
    record.urls.public = null;
  }

  async expose(
    input: string,
    options: { to?: string; gate?: "password" | "none"; password?: string; public?: boolean; ttl?: string; exposeInteractive?: boolean; rotate?: boolean },
  ): Promise<Record<string, unknown>> {
    if (isRef(input)) {
      const parsed = parseRef(input);
      if (!(await this.isLocalHost(parsed.host))) {
        const flags = [
          "expose", parsed.env, "--json",
          ...(options.to === undefined ? [] : ["--to", options.to]),
          ...(options.gate === undefined ? [] : ["--gate", options.gate]),
          ...(options.password === undefined ? [] : ["--password", options.password]),
          ...(options.public === true ? ["--public"] : []),
          ...(options.ttl === undefined ? [] : ["--ttl", options.ttl]),
          ...(options.exposeInteractive === true ? ["--expose-interactive"] : []),
          ...(options.rotate === true ? ["--rotate"] : []),
        ];
        return this.remoteResult(parsed.host, flags);
      }
      input = parsed.env;
    }
    const name = validateEnvName(input);
    return this.store.withLock(name, async () => {
      const config = await this.store.readConfig();
      const to = options.to ?? defaultExposure(config.exposures);
      const target = config.exposures?.[to];
      if (target === undefined) {
        throw new NectarError("E_EXPOSE", `No exposure target '${to}' in machine config (~/.nectar/nectar.json → exposures)`);
      }
      if (target.kind !== "relay") throw new NectarError("E_EXPOSE", `Exposure kind '${target.kind}' is not implemented in v0.2`);
      const record = await this.refreshLiveness(await this.store.readEnv(name));
      if (record.status !== "serving" && !(record.mode === "web" && record.status === "warm" && record.serve?.proxy_port !== undefined)) {
        throw new NectarError("E_EXPOSE", `Environment '${name}' is ${record.status}; only a serving env can be exposed`);
      }
      // The relay proxies to the tailnet serve URL — that is the only address it can
      // reach the publisher at. No mesh URL (tailscale down) ⇒ nothing to expose.
      const upstream = record.urls.mesh;
      if (upstream === null) throw new NectarError("E_EXPOSE", `Environment '${name}' has no mesh URL; exposure needs tailscale up`);
      // Streamed simulators are interactive control surfaces (SPEC §9.1): refuse to put
      // one on the public internet without an explicit opt-in.
      if (record.mode === "ios" && options.exposeInteractive !== true) {
        throw new NectarError("E_EXPOSE", `'${name}' is an interactive iOS stream; pass --expose-interactive to expose a device someone can drive`);
      }
      const gate = options.gate ?? target.gate ?? "password";
      const isPublic = gate === "none";
      if (isPublic && options.public !== true) {
        throw new NectarError("E_EXPOSE", "--gate none exposes with no auth; pass --public to confirm");
      }
      if (usesRelayd(target)) return this.exposeViaRelayd(record, to, target, upstream, gate, options);
      if (options.rotate === true) throw new NectarError("E_USAGE", "--rotate needs a relay with control: \"relayd\"");
      const password = gate === "password" ? options.password ?? crypto.randomBytes(9).toString("base64url") : undefined;
      const expiresEpoch = options.ttl
        ? Math.floor((Date.now() + parseDuration(options.ttl, "ttl")) / 1000)
        : Math.floor(new Date(record.expires_at).getTime() / 1000);
      const sub = record.exposure?.sub ?? exposureSub(record, isPublic);
      const added = await relayAdd({ target, sub, upstream, expiresEpoch, gate, ...(password === undefined ? {} : { password }) });
      record.exposure = {
        target: to,
        kind: target.kind,
        sub,
        url: added.url,
        gate,
        expires_at: new Date(expiresEpoch * 1_000).toISOString(),
      };
      record.urls.public = added.url;
      await this.store.writeEnv(record);
      return {
        env: record.name,
        url: added.url,
        share_url: added.url,
        gate,
        ...(password === undefined ? {} : { password, credentials: { user: "reviewer", password }, share_note: shareNote(password) }),
        expires_at: record.exposure.expires_at,
        secret: SECRET_FIELDS,
        packet_fields: this.packetFields(record),
      };
    });
  }

  private async exposeViaRelayd(
    record: EnvRecord,
    to: string,
    target: ExposureTarget,
    upstream: string,
    gate: "password" | "none",
    options: { password?: string; ttl?: string; rotate?: boolean },
  ): Promise<Record<string, unknown>> {
    const fixed = options.ttl !== undefined;
    const expiresEpoch = fixed
      ? Math.floor((Date.now() + parseDuration(options.ttl ?? "", "ttl")) / 1000)
      : Math.floor(new Date(record.expires_at).getTime() / 1000);
    const current = record.exposure;
    let route: RelaydRoute | "gone" = "gone";
    let reused = false;
    if (current !== undefined && current.revoked_at === undefined && current.target === to && current.control === "relayd") {
      if (options.password !== undefined) throw new NectarError("E_USAGE", `'${record.name}' is already exposed at ${current.url}; pass --rotate for a new password, or unexpose it first`);
      route = await relaydUpdate(target, current.sub, { expiresEpoch, gate });
      if (route !== "gone" && options.rotate === true && route.password === undefined) route = await relaydRotate(target, current.sub);
      reused = route !== "gone";
    } else if (current !== undefined) {
      await this.tearDownExposure(record).catch(() => undefined);
    }
    if (route === "gone") {
      route = await relaydCreate(target, { name: relaydName(record), upstream, expiresEpoch, gate, ...(options.password === undefined ? {} : { password: options.password }) });
    }
    const password = route.password ?? (reused || gate === "none" ? undefined : options.password);
    record.exposure = {
      target: to,
      kind: target.kind,
      sub: route.sub,
      url: route.url,
      gate: route.gate,
      expires_at: route.expires_at,
      control: "relayd",
      ...(fixed ? { fixed_ttl: true } : {}),
      cap_at: route.cap_at,
    };
    record.urls.public = route.url;
    await this.store.writeEnv(record);
    return {
      env: record.name,
      url: route.url,
      share_url: route.url,
      gate: route.gate,
      ...(password === undefined ? {} : { password, credentials: { user: "reviewer", password }, share_note: shareNote(password) }),
      ...(reused ? { reused: true, ...(password === undefined && route.gate === "password" ? { password_unchanged: true } : {}) } : {}),
      expires_at: route.expires_at,
      cap_at: route.cap_at,
      secret: SECRET_FIELDS,
      packet_fields: this.packetFields(record),
    };
  }

  private async syncExposures(config: MachineConfig): Promise<GcReport["exposures"]> {
    const synced: GcReport["exposures"] = [];
    const byTarget = new Map<string, EnvRecord[]>();
    for (const record of await this.store.listEnvs()) {
      const exposure = record.exposure;
      if (exposure?.control !== "relayd" || exposure.revoked_at !== undefined) continue;
      byTarget.set(exposure.target, [...(byTarget.get(exposure.target) ?? []), record]);
    }
    for (const [name, records] of byTarget) {
      const target = config.exposures?.[name];
      if (target === undefined || !usesRelayd(target)) continue;
      let listing: Awaited<ReturnType<typeof relaydMine>>;
      try {
        listing = await relaydMine(target);
      } catch (error) {
        const reason = asNectarError(error).message;
        synced.push(...records.map((record) => ({ env: record.name, action: "unreachable" as const, reason })));
        continue;
      }
      for (const snapshot of records) {
        try {
          await this.store.withLock(snapshot.name, async () => {
            const record = await this.store.readEnv(snapshot.name);
            const exposure = record.exposure;
            if (exposure?.control !== "relayd" || exposure.revoked_at !== undefined || exposure.target !== name) return;
            const revokedBy = listing.revoked.get(exposure.sub) ?? (listing.live.has(exposure.sub) ? undefined : "gone");
            const markRevoked = async (reason: string): Promise<void> => {
              exposure.revoked_at = new Date().toISOString();
              exposure.revoked_reason = reason;
              record.urls.public = null;
              await this.store.writeEnv(record);
              synced.push({ env: record.name, action: "revoked", reason });
            };
            if (revokedBy !== undefined) {
              await markRevoked(revokedBy);
              return;
            }
            const live = listing.live.get(exposure.sub);
            const want = Math.min(Math.floor(new Date(record.expires_at).getTime() / 1000), Math.floor(new Date(live?.cap_at ?? record.expires_at).getTime() / 1000));
            const have = Math.floor(new Date(live?.expires_at ?? exposure.expires_at).getTime() / 1000);
            if (exposure.fixed_ttl === true || Math.abs(want - have) < 60 || want * 1000 <= Date.now()) {
              synced.push({ env: record.name, action: "unchanged", expires_at: live?.expires_at ?? exposure.expires_at });
              return;
            }
            const updated = await relaydUpdate(target, exposure.sub, { expiresEpoch: want });
            if (updated === "gone") {
              await markRevoked("gone");
              return;
            }
            exposure.expires_at = updated.expires_at;
            exposure.cap_at = updated.cap_at;
            await this.store.writeEnv(record);
            synced.push({ env: record.name, action: "patched", expires_at: updated.expires_at });
          });
        } catch (error) {
          synced.push({ env: snapshot.name, action: "skipped", reason: asNectarError(error).message });
        }
      }
    }
    return synced;
  }

  async unexpose(input: string): Promise<Record<string, unknown>> {
    if (isRef(input)) {
      const parsed = parseRef(input);
      if (!(await this.isLocalHost(parsed.host))) return this.remoteResult(parsed.host, ["unexpose", parsed.env, "--json"]);
      input = parsed.env;
    }
    const name = validateEnvName(input);
    return this.store.withLock(name, async () => {
      const record = await this.store.readEnv(name);
      if (record.exposure === undefined) return { env: record.name, unexposed: false };
      if (record.exposure.revoked_at !== undefined) {
        const was = record.exposure.url;
        delete record.exposure;
        record.urls.public = null;
        await this.store.writeEnv(record);
        return { env: record.name, unexposed: true, was, already_revoked: true };
      }
      const url = record.exposure.url;
      await this.tearDownExposure(record);
      await this.store.writeEnv(record);
      return { env: record.name, unexposed: true, was: url };
    });
  }

  async gc(options: { dryRun?: boolean; viewedAt?: ReadonlyMap<string, number> } = {}): Promise<GcReport> {
    const now = new Date();
    const config = await this.store.readConfig();
    const orphanReport = await this.sweepServeOrphans(config, options.dryRun === true);
    const report: Array<{ env: string; action: GcTransition }> = [];
    const skipped: Array<{ env: string; reason: string }> = [];
    const owners = new Map<string, Promise<Awaited<ReturnType<typeof ownerState>>>>();
    const daemonRunning = (await runningDaemonPid(this.paths)) !== undefined;
    for (const snapshot of await this.store.listEnvs()) {
      if (protectedPreview(snapshot)) continue;
      const proof = await previewProofState(snapshot);
      if (proof.state === "unknown" || proof.state === "waiting") {
        if (!options.dryRun && proof.state === "waiting" && snapshot.proof_terminal_since !== undefined) {
          await this.store.withLock(snapshot.name, async () => {
            const record = await this.store.readEnv(snapshot.name);
            delete record.proof_terminal_since;
            await this.store.writeEnv(record);
          }).catch(() => undefined);
        }
        skipped.push({ env: snapshot.name, reason: proof.state === "waiting" ? "proof waiting for Tormod; left alone" : `proof lookup unresolved: ${proof.reason}; left alone` });
        continue;
      }
      let owner: Awaited<ReturnType<typeof ownerState>> | undefined;
      if (snapshot.status === "serving" && proof.state === "unlinked") {
        const key = JSON.stringify([snapshot.publisher.node_name, snapshot.publisher.hive_bee, snapshot.publisher.hive_session]);
        let lookup = owners.get(key);
        if (lookup === undefined) {
          lookup = ownerState(snapshot);
          owners.set(key, lookup);
        }
        owner = await lookup;
        if (owner === "unknown") {
          skipped.push({ env: snapshot.name, reason: "owner unresolved; left alone" });
          continue;
        }
      }
      const transition = (record: EnvRecord): GcTransition | undefined => {
        if (protectedPreview(record)) return undefined;
        if (proof.state === "terminal") return record.proof_terminal_since !== undefined && now.getTime() - Date.parse(record.proof_terminal_since) >= PROOF_GRACE_MS ? "reap" : undefined;
        if (record.status === "serving" && owner === "inactive") {
          return record.owner_inactive_since !== undefined && now.getTime() - Date.parse(record.owner_inactive_since) >= 60 * 60_000 ? "reap" : undefined;
        }
        const action = gcTransition(record, now, config.idle_stop_ms);
        if (action === "idle-stop" && now.getTime() - (options.viewedAt?.get(record.name) ?? 0) < config.idle_stop_ms) return undefined;
        return action === "idle-stop" && record.mode === "web" && !daemonRunning ? undefined : action;
      };
      const action = transition(snapshot);
      if (!options.dryRun && ((proof.state === "terminal" && snapshot.proof_terminal_since === undefined) || (proof.state === "unlinked" && snapshot.proof_terminal_since !== undefined) || (owner === "inactive" && snapshot.owner_inactive_since === undefined) || (owner === "active" && snapshot.owner_inactive_since !== undefined))) {
        try {
          await this.store.withLock(snapshot.name, async () => {
            const record = await this.store.readEnv(snapshot.name);
            if (record.publisher.hive_bee !== snapshot.publisher.hive_bee || record.publisher.hive_session !== snapshot.publisher.hive_session || record.published_at !== snapshot.published_at) return;
            if (proof.state === "terminal") record.proof_terminal_since ??= now.toISOString();
            else delete record.proof_terminal_since;
            if (owner === "inactive") record.owner_inactive_since ??= now.toISOString();
            else delete record.owner_inactive_since;
            await this.store.writeEnv(record);
          });
        } catch (error) {
          const failure = asNectarError(error);
          skipped.push({ env: snapshot.name, reason: failure.code === "E_BUSY" ? "busy" : failure.message });
          continue;
        }
      }
      if (action === undefined) continue;
      if (options.dryRun) {
        report.push({ env: snapshot.name, action });
        continue;
      }
      // One busy or poisoned env must never abort the sweep — gc is hourly and
      // contractually safe to run alongside publishes (SPEC §7).
      try {
        await this.store.withLock(snapshot.name, async () => {
          const record = await this.store.readEnv(snapshot.name);
          if (record.published_at !== snapshot.published_at || record.publisher.hive_bee !== snapshot.publisher.hive_bee || record.publisher.hive_session !== snapshot.publisher.hive_session) return;
          const confirmed = await previewProofState(record);
          if (confirmed.state !== proof.state) {
            if (confirmed.state === "waiting" || confirmed.state === "unlinked") {
              delete record.proof_terminal_since;
              await this.store.writeEnv(record);
            }
            skipped.push({ env: record.name, reason: "proof state changed or unresolved; left alone" });
            return;
          }
          const currentAction = transition(record);
          if (currentAction === undefined) return;
          await this.adoptLegacy(record);
          if (currentAction === "reap" && record.serve !== undefined && groupAlive(record.serve.pgid) && !(await groupBelongsToEnv(record.serve))) {
            throw new NectarError("E_BUSY", `Runtime ownership unknown: ${ownershipRefusal(record.serve)}`);
          }
          if (currentAction === "idle-stop") {
            await this.sleepRuntime(record);
          } else if (currentAction === "expire") {
            await this.releaseRuntime(record);
            await this.stopDeps(record);
            if (record.mode === "dev") delete record.serve;
            await this.tearDownExposure(record).catch(() => undefined);
            delete record.liveness;
            record.status = "expired";
            await this.store.writeEnv(record);
          } else if (currentAction === "cold") {
            await this.releaseRuntime(record);
            if (record.mode === "dev") delete record.serve;
            await this.tearDownExposure(record).catch(() => undefined);
            await this.releaseSim(record);
            await this.releaseDeps(record);
            if (!record.borrowed_worktree) await trashPaths([record.worktree], this.paths.root);
            delete record.liveness;
            record.status = "cold";
            await this.store.writeEnv(record);
            await runGit(["worktree", "prune"], record.repo).catch(() => undefined);
          } else {
            // Reap removes everything the env ever owned, exactly like `rm`.
            await this.stopRuntime(record);
            if (record.serve !== undefined && groupAlive(record.serve.pgid)) throw new NectarError("E_BUSY", "Runtime still alive; environment retained");
            await this.tearDownExposure(record).catch(() => undefined);
            await this.releaseSim(record);
            await this.releaseDeps(record);
            const targets = [
              path.join(this.paths.packs, record.name),
              path.join(this.paths.evidence, record.name),
              path.join(this.paths.logs, record.name),
              this.store.envFile(record.name),
            ];
            if (!record.borrowed_worktree) targets.push(record.worktree);
            await trashPaths(targets, this.paths.root);
            await runGit(["worktree", "prune"], record.repo).catch(() => undefined);
            await this.releaseInbox(record);
          }
          report.push({ env: record.name, action: currentAction });
        });
      } catch (error) {
        const nectarError = asNectarError(error);
        skipped.push({ env: snapshot.name, reason: nectarError.code === "E_BUSY" && nectarError.details.ownership_refusal !== true && !nectarError.message.startsWith("Runtime ownership unknown:") ? "busy" : nectarError.message });
      }
    }
    if (!options.dryRun && report.length > 0) {
      for (const freed of await this.sweepServeOrphans(config, false)) {
        const seen = orphanReport.findIndex((orphan) => orphan.tailnet_port === freed.tailnet_port);
        if (seen === -1) orphanReport.push(freed);
        else orphanReport[seen] = freed;
      }
    }
    const current = await this.store.listEnvs();
    const protectedPacks = new Set(
      current
        .filter((record) => record.status === "serving" && record.testpack !== undefined)
        .map((record) => path.join(this.paths.packs, record.name, record.testpack?.file ?? "")),
    );
    const candidates = await packCandidates(this.paths.packs, protectedPacks);
    const packPrunes = selectPackPrunes(candidates, config.pack_quota_bytes);
    const staleStaging = await findStaleStaging(this.paths.packs, now.getTime() - 60 * 60_000);
    const evidencePrunes = await selectEvidencePrunes(this.paths.evidence, config.evidence_quota_bytes);
    const exposures = options.dryRun === true ? [] : await this.syncExposures(config);
    if (!options.dryRun) {
      await trashPaths([...packPrunes.map((file) => file.path), ...staleStaging, ...evidencePrunes], this.paths.root);
      // Re-read before stamping — doctor --fix may have registered the pack
      // server while the sweep ran, and this snapshot would clobber it.
      const fresh = await this.store.readConfig();
      await this.store.writeConfig({ ...fresh, last_gc_at: now.toISOString() });
    }
    return {
      dry_run: options.dryRun ?? false,
      transitions: report,
      serve_orphans: orphanReport,
      skipped,
      packs_pruned: packPrunes.map((file) => ({ file: path.relative(this.paths.root, file.path), size_bytes: file.size })),
      staging_pruned: staleStaging.map((file) => path.relative(this.paths.root, file)),
      evidence_pruned: evidencePrunes.map((file) => path.relative(this.paths.root, file)),
      exposures,
      ran_at: now.toISOString(),
    };
  }

  private async sweepServeOrphans(config: MachineConfig, dryRun: boolean): Promise<GcReport["serve_orphans"]> {
    const orphans = (await this.classifyServe(await serveStatus(), config)).filter((entry) => entry.class === "orphan");
    const swept = [] as GcReport["serve_orphans"];
    for (const orphan of orphans) {
      swept.push({
        tailnet_port: orphan.tailnetPort,
        target: orphan.target,
        env: orphan.env ?? null,
        reason: orphan.reason,
        fixed: dryRun ? false : await this.cleanupServeOrphan(orphan),
        ...(orphan.direct === undefined ? {} : { direct: orphan.direct }),
      });
    }
    return swept;
  }

  private async packServerAlive(config: MachineConfig): Promise<boolean> {
    return (
      config.pack_server_pid !== undefined &&
      config.pack_server_pgid !== undefined &&
      pidAlive(config.pack_server_pid) &&
      (await portOpen(config.pack_server_port))
    );
  }

  private async ensurePackServer(config: MachineConfig): Promise<{ config: MachineConfig; started: boolean }> {
    if (await this.packServerAlive(config)) return { config, started: false };
    let port = config.pack_server_port;
    if (!(await portAvailable(port))) {
      const reserved = loopbackPorts(await this.store.listEnvs());
      port = await allocatePort({ start: config.upstream_port_start, end: config.upstream_port_end, reserved });
    }
    const log = await prepareLog(this.paths, "pack-store", config.log_max_bytes);
    const entry = process.env.NECTAR_PACK_SERVER_ENTRY ?? fileURLToPath(new URL("./pack-server.js", import.meta.url));
    const child = spawnDetachedExecutable(
      process.execPath,
      [entry, this.paths.packs, String(port)],
      this.paths.root,
      scrubbedEnvironment(),
      log,
    );
    const deadline = Date.now() + 2_000;
    while (!(await portOpen(port)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!(await portOpen(port))) {
      await stopEnvGroup(child);
      throw new NectarError("E_INTERNAL", `Read-only pack server did not start on 127.0.0.1:${port}`, {
        log_tail: await logTail(this.paths, "pack-store"),
      });
    }
    const updated: MachineConfig = {
      ...config,
      pack_server_port: port,
      pack_server_pid: child.pid,
      pack_server_pgid: child.pgid,
      ...(child.start_time === undefined ? {} : { pack_server_start_time: child.start_time }),
    };
    await this.store.writeConfig(updated);
    return { config: updated, started: true };
  }

  async doctor(options: { fix?: boolean; dryRun?: boolean; noDaemon?: boolean; save?: boolean } = {}): Promise<Record<string, unknown>> {
    if (options.dryRun === true && options.fix !== true) {
      throw new NectarError("E_USAGE", "--dry-run plans repairs; pass it together with --fix");
    }
    if (options.save === true && (options.noDaemon !== true || options.dryRun === true)) {
      throw new NectarError("E_USAGE", "--save remembers --no-daemon; pass it with --no-daemon and without --dry-run");
    }
    await this.store.init();
    if (options.save === true) await this.store.writeConfig({ ...(await this.store.readConfig()), daemon: "disabled" });
    const noDaemon = options.noDaemon === true;
    const before = await this.diagnose(noDaemon);
    if (options.fix !== true) return { healthy: before.healthy, checks: before.checks };
    const actions = this.planRepairs(before);
    if (options.dryRun === true) return { dry_run: true, healthy: before.healthy, checks: before.checks, actions };
    await this.runRepairs(actions);
    const after = await this.diagnose(noDaemon);
    const unhealthyBefore = new Set(before.checks.filter((check) => check.status !== "pass").map((check) => check.name));
    const checks = after.checks.map((check) =>
      check.status === "pass" && unhealthyBefore.has(check.name) ? { ...check, fixed: true } : check,
    );
    return { dry_run: false, healthy: after.healthy, checks, actions };
  }

  private async serveRightsCheck(online: boolean): Promise<DoctorCheck> {
    if (process.platform !== "linux") {
      return { name: "tailscale-serve", status: "pass", message: `Serve rights are not probed on ${process.platform}; the Tailscale app grants them to the logged-in user` };
    }
    if (!online) return { name: "tailscale-serve", status: "warn", message: "Tailscale is not up, so serve rights were not probed" };
    const rights = await probeServeRights();
    if (rights.state === "allowed") return { name: "tailscale-serve", status: "pass", message: "This user may change the tailscale serve config" };
    if (rights.state === "unknown") {
      return { name: "tailscale-serve", status: "warn", message: `Could not probe serve rights: ${rights.message}` };
    }
    return {
      name: "tailscale-serve",
      status: "fail",
      message: `tailscaled refuses serve changes from ${os.userInfo().username} ("${rights.message}"); publishes will be local-only with no mesh URL`,
      hint: `Make this user a Tailscale operator once: ${OPERATOR_HINT}. Nectar never runs sudo, and doctor --fix leaves this alone`,
    };
  }

  async setRemoteListen(listen: boolean): Promise<void> {
    const config = await this.store.readConfig();
    config.remote = { ...config.remote, listen };
    await this.store.writeConfig(config);
  }

  async enableDaemon(): Promise<void> {
    const config = await this.store.readConfig();
    if (config.daemon === undefined) return;
    delete config.daemon;
    await this.store.writeConfig(config);
  }

  private async diagnose(noDaemon = false): Promise<Diagnosis> {
    const config = await this.store.readConfig();
    const tailnet = await tailnetStatus();
    const identity = tailnet.identity;
    const status = await serveStatus();
    const checks: DoctorCheck[] = [];
    const portlessBin = process.env.NECTAR_PORTLESS_BIN ?? "portless";
    let portlessPresent = false;
    let portlessProxy = false;
    try {
      const version = await runCommand(portlessBin, ["--version"], { timeoutMs: 2_000 });
      portlessPresent = version.exitCode === 0;
      if (portlessPresent) {
        // Current Portless exposes proxy liveness through a human-readable
        // `service status` command. Older releases used `status --json`, so retain
        // that probe as a fallback for machines that have not upgraded yet.
        const serviceStatus = await runCommand(portlessBin, ["service", "status"], { timeoutMs: 2_000 });
        const serviceOutput = `${serviceStatus.stdout}\n${serviceStatus.stderr}`;
        portlessProxy = serviceStatus.exitCode === 0 && /Proxy on \d+:\s*responding\b/i.test(serviceOutput);
        if (!portlessProxy) {
          const legacyStatus = await runCommand(portlessBin, ["status", "--json"], { timeoutMs: 2_000 });
          portlessProxy = legacyStatus.exitCode === 0;
        }
      }
    } catch {
      // Missing portless is the expected v0 degraded-local case.
    }
    checks.push({
      name: "portless",
      status: portlessPresent && portlessProxy ? "pass" : "warn",
      message: !portlessPresent
        ? `Portless is not on this PATH (looked for '${portlessBin}'); v0 web publishes intentionally degrade local URLs to loopback`
        : portlessProxy
          ? "Portless and its proxy are up (name adoption remains deferred in v0)"
          : "Portless is installed but its proxy status could not be confirmed; local URLs degrade to loopback",
      ...(portlessPresent
        ? {}
        : {
            hint: "If Portless is installed, put its directory on PATH or set NECTAR_PORTLESS_BIN, then re-run `nectar daemon install` from that shell. Nectar never starts, stops or configures Portless.",
          }),
    });
    const tailscale = resolveTailscale();
    const discovery = discoveryReport();
    checks.push({
      name: "tailscale",
      status: identity === undefined ? "fail" : "pass",
      message:
        identity !== undefined
          ? `Tailscale is up as ${identity.dnsName} via ${tailnet.api === "localapi" ? `the LocalAPI at ${tailnet.endpoint} (${describeDiscovery(discovery)})` : `${tailscale.path} (${tailscale.source})`}`
          : tailscale.source === "none" && tailnet.api === "cli"
            ? `No Tailscale LocalAPI and no tailscale CLI found in NECTAR_TAILSCALE_BIN, PATH, ${TAILSCALE_FALLBACKS.join(", ")} (${tailnet.reason}); publishes will be local-only`
            : `Tailscale is not usable: ${tailnet.reason}; publishes will be local-only`,
      api: tailnet.api,
      localapi: tailnet.endpoint ?? null,
      discovery,
      binary: tailscale.source === "none" ? null : tailscale.path,
      binary_source: tailscale.source,
    });
    const serveRights = await this.serveRightsCheck(identity !== undefined);
    checks.push(serveRights);
    const on443 = serveEntries(status).filter((entry) => entry.tailnetPort === 443);
    checks.push(
      statusHasPort(status, 443)
        ? {
            name: "serve-443",
            status: "warn",
            message: `Tailscale serve has a 443 entry${on443.length === 0 ? "" : ` (${on443.map((entry) => `${entry.mount ?? "/"} -> ${entry.target}`).join(", ")})`}; Nectar never uses 443 (mesh URLs use ${config.tailnet_port_start}-${config.tailnet_port_end}, the pack store 8440), so it is reported and left alone`,
            hint: "Expected where portless or another service publishes on 443. Otherwise find whose it is and remove it by hand with `tailscale serve --https=443 off`",
            details: on443.map((entry) => ({ mount: entry.mount ?? "/", target: entry.target })),
          }
        : { name: "serve-443", status: "pass", message: "No Tailscale serve entry on 443" },
    );
    const funnelOn = statusHasFunnel(status);
    checks.push({
      name: "funnel",
      status: funnelOn ? "fail" : "pass",
      message: funnelOn
        ? "A Tailscale Funnel entry exists; Nectar never invokes Funnel and will not alter unrelated public exposure"
        : "Tailscale Funnel is off in the Serve configuration",
    });
    const serve = await this.classifyServe(status, config);
    const describe = (entry: ClassifiedServeEntry): string => `:${entry.tailnetPort} -> ${entry.target}`;
    const detail = (entry: ClassifiedServeEntry): Record<string, unknown> => ({
      tailnet_port: entry.tailnetPort,
      target: entry.target,
      env: entry.env ?? null,
      reason: entry.reason,
    });
    const orphans = serve.filter((entry) => entry.class === "orphan");
    checks.push({
      name: "serve-orphans",
      status: orphans.length === 0 ? "pass" : "fail",
      message:
        orphans.length === 0
          ? "No Nectar Serve entries point at dead local ports"
          : `${orphans.length} Nectar Serve ${orphans.length === 1 ? "entry points" : "entries point"} at dead local ports: ${orphans.map(describe).join(", ")}`,
      ...(orphans.length === 0 ? {} : { hint: "nectar doctor --fix removes them", details: orphans.map(detail) }),
    });
    for (const [name, kind, label] of [
      ["serve-foreign", "foreign", "point at targets Nectar did not create"],
      ["serve-ambiguous", "ambiguous", "cannot be proven to be Nectar's"],
    ] as const) {
      const found = serve.filter((entry) => entry.class === kind);
      checks.push({
        name,
        status: found.length === 0 ? "pass" : "warn",
        message:
          found.length === 0
            ? `No Serve entries in Nectar's tailnet range ${label}`
            : `${found.length} Serve ${found.length === 1 ? "entry" : "entries"} in Nectar's tailnet range ${label}; reported and left alone: ${found.map(describe).join(", ")}`,
        ...(found.length === 0
          ? {}
          : { hint: "Remove by hand with `tailscale serve --https=<port> off` once you know whose it is", details: found.map(detail) }),
      });
    }
    const auxiliary: Array<{ runtime: string; reason: string; hint: string }> = [];
    const shared = await readFile(path.join(this.paths.root, "shared-static.json"), "utf8").then((text) => JSON.parse(text) as { pid: number; pgid: number; start_time?: string }).catch(() => undefined);
    const auxiliaryRecords = [
      ...(shared === undefined ? [] : [{ runtime: "shared static", ...shared }]),
      ...(config.pack_server_pid === undefined ? [] : [{ runtime: "pack server", pid: config.pack_server_pid, pgid: config.pack_server_pgid ?? 0, ...(config.pack_server_start_time === undefined ? {} : { start_time: config.pack_server_start_time }) }]),
    ];
    for (const runtime of auxiliaryRecords) {
      if (!pidAlive(runtime.pid)) continue;
      const reason = ownershipRefusal(runtime);
      if (reason !== undefined) auxiliary.push({ runtime: runtime.runtime, reason, hint: `Verify PID ${runtime.pid} and PGID ${runtime.pgid} with ps -o pid,pgid,lstart -p ${runtime.pid}; after confirming ownership, stop the runtime manually, then retry` });
    }
    checks.push({ name: "auxiliary-ownership", status: auxiliary.length === 0 ? "pass" : "warn", message: auxiliary.length === 0 ? "Auxiliary process identities match" : "Auxiliary runtime ownership unknown; left alone", details: auxiliary });
    const clusterWarnings = (await Promise.all((await clusterMajors(this.paths.root)).map(async (major) => {
      const warning = await clusterOwnershipWarning(this.paths.root, major);
      return warning === undefined ? [] : [{ major, ...warning }];
    }))).flat();
    checks.push({ name: "dependency-ownership", status: clusterWarnings.length === 0 ? "pass" : "warn", message: clusterWarnings.length === 0 ? "Local dependency process identities match" : "Local Postgres ownership unknown; left alone", details: clusterWarnings });
    const unknown = (await Promise.all((await this.store.listEnvs()).map(async (record) => {
      const serve = record.serve;
      if (serve === undefined || serve.pid === 0 || (!groupAlive(serve.pgid) && serve.start_time !== undefined)) return [];
      if (serve.start_time === undefined) {
        const verified = await this.legacyIdentity(record);
        const action = verified.start_time === undefined ? "detach" : "adoptable";
        return [{ env: record.name, pid: serve.pid, pgid: serve.pgid, action, reason: verified.reason ?? "legacy runtime verified", hint: action === "adoptable" ? `nectar stop ${record.name} verifies again, adopts and stops the runtime` : `nectar rm ${record.name} --detach leaves PGID ${serve.pgid} untouched` }];
      }
      const reason = ownershipRefusal(serve);
      return reason === undefined ? [] : [{ env: record.name, pid: serve.pid, pgid: serve.pgid, action: "detach", reason, hint: `nectar rm ${record.name} --detach leaves PGID ${serve.pgid} untouched` }];
    }))).flat();
    checks.push({ name: "process-ownership", status: unknown.length === 0 ? "pass" : "warn", message: unknown.length === 0 ? "All recorded process identities match" : "Runtime ownership unknown; left alone", details: unknown });
    const gcPlan = await this.gc({ dryRun: true });
    const holders = await this.deadHolders(status);
    const pending = gcPlan.transitions.filter((item) => item.action !== "idle-stop");
    checks.push({
      name: "env-resources",
      status: holders.length === 0 && pending.length === 0 ? "pass" : "warn",
      message:
        holders.length === 0 && pending.length === 0
          ? "No dead or expired env records hold processes or Serve entries"
          : [
              pending.length === 0 ? undefined : `gc would ${pending.map((item) => `${item.action} ${item.env}`).join(", ")}`,
              holders.length === 0
                ? undefined
                : `${holders.length} dead or expired ${holders.length === 1 ? "env holds" : "envs hold"} resources: ${holders
                    .map((holder) => `${holder.env} (${[holder.process ? "process" : undefined, holder.serve_entry === null ? undefined : `serve :${holder.serve_entry}`].filter(Boolean).join(", ")})`)
                    .join(", ")}`,
            ]
              .filter(Boolean)
              .join("; "),
      ...(holders.length === 0 && pending.length === 0 ? {} : { hint: "nectar doctor --fix runs gc and releases them", details: [...pending, ...holders] }),
    });
    const gcAge = config.last_gc_at === undefined ? Number.POSITIVE_INFINITY : Date.now() - new Date(config.last_gc_at).getTime();
    const gcOverdue = gcAge > 24 * 60 * 60 * 1_000;
    checks.push({
      name: "gc-recency",
      status: gcOverdue ? "warn" : "pass",
      message: config.last_gc_at === undefined ? "GC has never run on this machine" : `Last GC: ${config.last_gc_at}`,
      ...(gcOverdue ? { hint: "nectar doctor --fix runs gc now; nectard runs it hourly" } : {}),
    });
    const nectard = await this.nectardState(noDaemon ? "--no-daemon" : config.daemon === "disabled" ? `daemon: "disabled" in ${this.paths.config}` : undefined);
    if (nectard.check !== undefined) checks.push(nectard.check);
    checks.push(await listenerCheck(this.paths, config));
    checks.push(await this.pathToolsCheck(nectard.unitPath));
    const packServerLive = await this.packServerAlive(config);
    const proxyPresent = statusHasProxyTarget(status, 8440, `http://127.0.0.1:${config.pack_server_port}`);
    const packs = await packCandidates(this.paths.packs, new Set());
    const packBytes = packs.reduce((sum, file) => sum + file.size, 0);
    const packDownStatus = packs.length === 0 ? "warn" : "fail";
    const packScope = "it serves desktop/ios testpacks only; web previews do not use it";
    const packRemedy =
      identity === undefined
        ? "; nectar doctor --fix starts it once Tailscale is up"
        : packs.length === 0
          ? `; no packs stored yet, so nothing needs it (${packScope}). Run nectar doctor --fix to start it`
          : `; ${packs.length} stored pack(s) are unreachable (${packScope}). Run nectar doctor --fix`;
    checks.push({
      name: "pack-loopback",
      status: packServerLive ? "pass" : packDownStatus,
      message: packServerLive
        ? `Read-only pack server PID ${config.pack_server_pid} is live on 127.0.0.1:${config.pack_server_port}`
        : `Read-only pack server is not running${packRemedy}`,
    });
    checks.push({
      name: "pack-store-8440",
      status: packServerLive && proxyPresent ? "pass" : packDownStatus,
      message:
        packServerLive && proxyPresent
          ? `Tailnet HTTPS :8440 proxies to the read-only loopback server on ${config.pack_server_port}`
          : `${packServerLive ? "Tailnet HTTPS :8440 does not proxy to the pack server" : "Tailnet HTTPS :8440 has no live pack server behind it"}${packRemedy}`,
    });
    const upstreamFree = await this.hasFreePort(config.upstream_port_start, config.upstream_port_end);
    const tailnetFree = await this.hasFreePort(config.tailnet_port_start, config.tailnet_port_end);
    checks.push({
      name: "port-ranges",
      status: upstreamFree && tailnetFree && !(config.tailnet_port_start <= 443 && config.tailnet_port_end >= 443) ? "pass" : "fail",
      message:
        config.tailnet_port_start <= 443 && config.tailnet_port_end >= 443
          ? "Tailnet port range includes forbidden port 443"
          : upstreamFree && tailnetFree
            ? "Upstream and tailnet port ranges have capacity"
            : "A configured port range is exhausted",
    });
    checks.push({
      name: "pack-quota",
      status: packBytes <= config.pack_quota_bytes ? "pass" : "warn",
      message: `${packBytes} of ${config.pack_quota_bytes} pack bytes used`,
    });
    if (process.platform === "darwin" || process.env.NECTAR_XCRUN_BIN !== undefined) {
      try {
        const runtimes = (await listRuntimes()).filter((runtime) => runtime.available);
        checks.push({
          name: "ios-toolchain",
          status: runtimes.length > 0 ? "pass" : "warn",
          message:
            runtimes.length > 0
              ? `simctl is available with ${runtimes.length} iOS runtime(s): ${runtimes.map((runtime) => runtime.version).join(", ")}`
              : "simctl works but no iOS runtime is installed; run `xcodebuild -downloadPlatform iOS` before --mode ios",
        });
      } catch (error) {
        checks.push({
          name: "ios-toolchain",
          status: "warn",
          message: `simctl unavailable (${error instanceof Error ? error.message : String(error)}); --mode ios will fail on this host`,
        });
      }
    }
    const envs = await this.store.listEnvs();
    const depsUsers = (provider: (dep: DepRecord) => boolean): string[] =>
      envs.filter((record) => Object.values(record.deps ?? {}).some(provider)).map((record) => record.name);
    const dockerUsers = depsUsers(usesDockerPostgres);
    const localUsers = depsUsers(usesLocalPostgres);
    const providers = new PostgresProviders();
    const docker = await providers.dockerProbe();
    checks.push({
      name: "docker",
      status: docker.ok ? "pass" : dockerUsers.length > 0 ? "fail" : "warn",
      message: docker.ok
        ? `${docker.message}; [deps] postgres can run here`
        : `${docker.message}; ${dockerUsers.length > 0 ? `envs with Docker [deps] postgres cannot start: ${dockerUsers.join(", ")}` : "[deps] postgres needs the local provider here"}`,
      binary: docker.binary,
      ...(docker.ok ? {} : { hint: DOCKER_HINT }),
    });
    const installs = await providers.localInstalls();
    const auto = await providers.auto();
    const missingMajors = [
      ...new Set(
        envs.flatMap((record) =>
          Object.values(record.deps ?? {})
            .filter(usesLocalPostgres)
            .map((dep) => dep.major)
            .filter((major) => !installs.some((install) => install.major === major)),
        ),
      ),
    ];
    checks.push({
      name: "postgres-provider",
      status: missingMajors.length > 0 ? "fail" : auto === undefined ? "warn" : "pass",
      message: [
        auto === undefined
          ? "[deps] postgres has no provider here: no reachable Docker and no local Postgres binaries; publishing it fails with E_PLATFORM"
          : `[deps] postgres without a provider key uses ${auto === "docker" ? "Docker" : `the local Postgres ${installs[0]?.version ?? ""} cluster`} here`,
        installs.length > 0 ? `local Postgres: ${installs.map((install) => `${install.major} (${install.bindir})`).join(", ")}` : "no local Postgres binaries",
        localUsers.length > 0 ? `envs on the local provider: ${localUsers.join(", ")}` : undefined,
        missingMajors.length > 0 ? `missing local Postgres majors those envs need: ${missingMajors.join(", ")}` : undefined,
      ]
        .filter((part) => part !== undefined)
        .join("; "),
      provider: auto ?? null,
      details: installs,
      ...(auto === undefined || missingMajors.length > 0 ? { hint: `${DOCKER_HINT}. ${LOCAL_PG_HINT}` } : {}),
    });
    checks.push({
      name: "tailnet-acl",
      status: "warn",
      message: `Verify tailnet ACLs restrict ports 8440 and ${config.tailnet_port_start}-${config.tailnet_port_end} to operator-owned devices`,
    });
    for (const [name, target] of Object.entries(config.exposures ?? {})) {
      if (target.kind !== "relay") continue;
      const health = await relayHealth(target);
      checks.push({
        name: `exposure-${name}`,
        status: health.ok ? "pass" : "warn",
        message: health.ok
          ? `Relay '${name}' (${target.host}) is up: ${health.detail}`
          : `Relay '${name}' (${target.host}) unreachable — exposes to ${target.domain} will fail: ${health.detail}`,
      });
    }
    return {
      healthy: checks.every((check) => check.status !== "fail"),
      checks,
      config,
      online: identity !== undefined,
      serveDenied: serveRights.status === "fail",
      funnelOn,
      gcPlan,
      gcOverdue,
      holders,
      nectard,
      packServerLive,
      proxyPresent,
    };
  }

  private async deadHolders(status: unknown): Promise<DeadHolder[]> {
    const nowMs = Date.now();
    const entries = serveEntries(status);
    const holders = await Promise.all(
      (await this.store.listEnvs()).map(async (record): Promise<DeadHolder | undefined> => {
        const serve = record.serve;
        const dead = DEAD_STATUSES.has(record.status) || Date.parse(record.expires_at) <= nowMs;
        if (serve === undefined || !dead) return undefined;
        const processHeld = await groupBelongsToEnv(serve);
        const entryHeld =
          serve.tailnet_port !== undefined &&
          serve.upstream_port !== undefined &&
          entries.some((entry) => entry.tailnetPort === serve.tailnet_port && ownsLoopbackPort(serve, loopbackProxy(entry.target)?.upstreamPort));
        const refusal = groupAlive(serve.pgid) ? ownershipRefusal(serve) : undefined;
        if (!processHeld && !entryHeld && refusal === undefined) return undefined;
        return {
          env: record.name,
          status: record.status,
          expires_at: record.expires_at,
          process: processHeld,
          ...(refusal === undefined ? {} : { ownership_refusal: refusal }),
          pgid: serve.pgid,
          serve_entry: entryHeld ? (serve.tailnet_port ?? null) : null,
        };
      }),
    );
    return holders.filter((holder): holder is DeadHolder => holder !== undefined);
  }

  private async nectardState(disabledBy?: string): Promise<NectardState> {
    if (process.platform !== "darwin" && process.platform !== "linux") return {};
    const [installed, status] = await Promise.all([readInstalledUnit(), unitStatus(this.paths, process.platform, disabledBy === undefined ? {} : { waitMs: 0 })]);
    const spec = unitSpec(this.paths);
    const expected = spec.program;
    const facts = {
      unit: status.unit,
      active: status.active,
      pid: status.pid,
      program: installed?.program ?? null,
      expected_program: expected,
      unit_nectar_home: installed?.env.NECTAR_HOME ?? null,
    };
    const unitPath = installed?.env.PATH;
    const withPath = (state: NectardState): NectardState => (unitPath === undefined ? state : { ...state, unitPath });
    if (disabledBy !== undefined) {
      return withPath({
        facts,
        check: {
          name: "nectard",
          status: "info",
          message: `nectard is disabled here (${disabledBy}); doctor --fix will not install or restart it. Unit: ${installed === undefined ? "not installed" : status.active}`,
          hint: "`nectar daemon install` installs it and clears the saved choice",
          details: [facts],
        },
      });
    }
    if (installed === undefined) {
      return {
        problem: "missing",
        facts,
        check: {
          name: "nectard",
          status: "warn",
          message: "nectard is not installed: crashed envs are not revived, envs do not come back after a reboot and gc runs only when invoked",
          hint: "nectar doctor --fix runs `nectar daemon install`; `nectar daemon uninstall` removes it",
          details: [facts],
        },
      };
    }
    if (installed.env.NECTAR_HOME !== this.paths.root) {
      return withPath({
        problem: "other-home",
        facts,
        check: {
          name: "nectard",
          status: "warn",
          message: `nectard's unit supervises NECTAR_HOME ${installed.env.NECTAR_HOME ?? "(unset)"}, not ${this.paths.root}; left alone`,
          hint: "Run doctor with that NECTAR_HOME, or `nectar daemon install` from this home if it should take over",
          details: [facts],
        },
      });
    }
    if (installed.program.join("\0") !== expected.join("\0")) {
      return withPath({
        problem: "stale",
        facts,
        check: {
          name: "nectard",
          status: "warn",
          message: `nectard's unit runs ${installed.program.slice(0, 2).join(" ")}, but this install is ${expected.slice(0, 2).join(" ")}`,
          hint: "nectar doctor --fix re-runs `nectar daemon install` so the unit points at this node and CLI",
          details: [facts],
        },
      });
    }
    const [startedMs, builtMs] = await Promise.all(
      [pidFile(this.paths), expected[1] ?? ""].map(async (file) => stat(file).then((info) => info.mtimeMs, () => undefined)),
    );
    if (status.pid !== null && startedMs !== undefined && builtMs !== undefined && builtMs > startedMs) {
      return withPath({
        problem: "stale",
        facts,
        check: {
          name: "nectard",
          status: "warn",
          message: `nectard (pid ${status.pid}) started before ${expected[1] ?? "the CLI"} was rebuilt, so it runs the old code`,
          hint: "nectar doctor --fix re-runs `nectar daemon install`, which restarts it",
          details: [facts],
        },
      });
    }
    if (status.active !== "active" && status.active !== "running") {
      return withPath({
        problem: "inactive",
        facts,
        check: {
          name: "nectard",
          status: "warn",
          message: `nectard is installed but ${status.active}`,
          hint: "nectar doctor --fix re-runs `nectar daemon install`, which restarts it",
          details: [facts],
        },
      });
    }
    return withPath({
      facts,
      check: {
        name: "nectard",
        status: "pass",
        message: `nectard is ${status.active}${status.pid === null ? "" : ` (pid ${status.pid})`} and runs this install`,
      },
    });
  }

  private async pathToolsCheck(unitPath: string | undefined): Promise<DoctorCheck> {
    const needs = new Map<string, Set<string>>();
    const need = (tool: string, env: string): void => {
      const envs = needs.get(tool) ?? new Set<string>();
      envs.add(env);
      needs.set(tool, envs);
    };
    for (const record of await this.store.listEnvs()) {
      if (record.status === "cold" || !existsSync(record.worktree)) continue;
      const recipe = await loadRecipe(record.worktree).catch(() => undefined);
      const commands = [record.serve?.cmd, record.dev?.run, recipe?.web?.serve, recipe?.web?.build, recipe?.dev?.run, recipe?.dev?.warm];
      for (const command of commands) if (command !== undefined) for (const tool of commandTools(command)) need(tool, record.name);
      for (const tool of recipe?.web?.requires ?? []) need(tool, record.name);
    }
    const missing = [];
    for (const [tool, envs] of [...needs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const onShell = await onPath(tool);
      const onUnit = unitPath === undefined ? null : await onPath(tool, unitPath);
      if (!onShell || onUnit === false) missing.push({ tool, envs: [...envs].sort(), on_path: onShell, on_nectard_path: onUnit });
    }
    if (missing.length === 0) {
      return {
        name: "path-tools",
        status: "pass",
        message:
          needs.size === 0
            ? "No env recipes on this machine need extra tools"
            : `Tools env recipes need are on PATH${unitPath === undefined ? "" : " and nectard's PATH"}: ${[...needs.keys()].sort().join(", ")}`,
      };
    }
    return {
      name: "path-tools",
      status: "warn",
      message: `Tools env recipes need are missing: ${missing
        .map((item) => `${item.tool} (${!item.on_path ? "not on PATH" : "not on nectard's PATH"}; ${item.envs.join(", ")})`)
        .join(", ")}`,
      hint: "Install the tool or put its directory on PATH, then re-run `nectar daemon install` from that shell so nectard's unit captures the same PATH",
      details: missing,
    };
  }

  private planRepairs(diagnosis: Diagnosis): DoctorAction[] {
    const actions: DoctorAction[] = [];
    const planned = (action: string, target: string, reason: string, before: unknown): DoctorAction => ({
      action,
      target,
      reason,
      status: "planned",
      before,
      after: null,
    });
    const plan = diagnosis.gcPlan;
    const pruning = plan.packs_pruned.length + plan.staging_pruned.length + plan.evidence_pruned.length;
    if (diagnosis.gcOverdue || plan.transitions.length > 0 || plan.serve_orphans.length > 0 || pruning > 0) {
      actions.push(...plan.serve_orphans.map(orphanAction));
      for (const transition of plan.transitions) {
        const holder = diagnosis.holders.find((item) => item.env === transition.env);
        actions.push(
          planned(`gc-${transition.action}`, transition.env, `gc policy: ${transition.action}`, {
            env: transition.env,
            process: holder?.process ?? false,
            serve_entry: holder?.serve_entry ?? null,
          }),
        );
      }
      actions.push(
        planned("gc", this.paths.root, diagnosis.gcOverdue ? "gc has not run in 24 h" : "gc has pending work", {
          last_gc_at: diagnosis.config.last_gc_at ?? null,
          prunes: pruning,
        }),
      );
    }
    const gcEnvs = new Set(plan.transitions.map((transition) => transition.env));
    const gcPorts = new Set(plan.serve_orphans.map((orphan) => orphan.tailnet_port));
    for (const holder of diagnosis.holders) {
      if (gcEnvs.has(holder.env) || (!holder.process && holder.serve_entry !== null && gcPorts.has(holder.serve_entry))) continue;
      actions.push(planned("release-env", holder.env, `${holder.env} is ${holder.status} but still holds its process or Serve entry`, holder));
    }
    const problem = diagnosis.nectard.problem;
    if (problem === "missing" || problem === "stale" || problem === "inactive") {
      actions.push(
        planned(problem === "missing" ? "install-nectard" : "reinstall-nectard", "nectar daemon install", `nectard is ${problem}`, diagnosis.nectard.facts),
      );
    }
    if (diagnosis.online && !diagnosis.funnelOn && !diagnosis.serveDenied) {
      const pack = { pid: diagnosis.config.pack_server_pid ?? null, port: diagnosis.config.pack_server_port, live: diagnosis.packServerLive };
      if (!diagnosis.packServerLive) actions.push(planned("start-pack-server", "pack-store", "the read-only pack server is down", pack));
      if (!diagnosis.packServerLive || !diagnosis.proxyPresent) {
        actions.push(planned("serve-pack-store", ":8440", "tailnet :8440 does not proxy to the pack server", { proxy: diagnosis.proxyPresent }));
      }
    }
    return actions;
  }

  private async runRepairs(actions: DoctorAction[]): Promise<void> {
    const settle = async (action: DoctorAction, work: () => Promise<{ ok: boolean; after: unknown }>): Promise<void> => {
      try {
        const result = await work();
        action.status = result.ok ? "done" : "failed";
        action.after = result.after;
      } catch (error) {
        action.status = "failed";
        action.error = asNectarError(error).message;
      }
    };
    const gcAction = actions.find((action) => action.action === "gc");
    if (gcAction !== undefined) {
      let report: GcReport | undefined;
      await settle(gcAction, async () => {
        report = await this.gc();
        return { ok: true, after: { last_gc_at: report.ran_at, skipped: report.skipped } };
      });
      const holders = await this.deadHolders(await serveStatus());
      const swept = report?.serve_orphans ?? [];
      const freed = swept.filter((orphan) => !actions.some((action) => isOrphanAction(action) && action.target === `:${orphan.tailnet_port}`));
      actions.splice(actions.indexOf(gcAction), 0, ...freed.map(orphanAction));
      for (const action of actions) {
        if (isOrphanAction(action)) {
          settleOrphanAction(action, swept);
        } else if (action.action.startsWith("gc-")) {
          const done = report?.transitions.some((transition) => transition.env === action.target);
          const record = await this.store.readEnv(action.target).catch(() => undefined);
          const holder = holders.find((item) => item.env === action.target);
          action.status = done === true ? "done" : "skipped";
          action.after =
            record === undefined
              ? { record: "reaped" }
              : { status: record.status, process: holder?.process ?? false, serve_entry: holder?.serve_entry ?? null };
        }
      }
    }
    const releases = actions.filter((action) => action.action === "release-env");
    for (const action of releases) {
      await settle(action, async () => {
          const record = await this.store.withLock(action.target, async () => {
            const current = await this.store.readEnv(action.target);
            await this.releaseRuntime(current);
            delete current.liveness;
            await this.store.writeEnv(current);
            return current;
          });
          const holder = (await this.deadHolders(await serveStatus())).find((item) => item.env === record.name);
          return {
            ok: holder === undefined,
            after: holder ?? { env: record.name, status: record.status, process: false, serve_entry: null, mesh_url: record.urls.mesh },
          };
        });
    }
    const lastRelease = releases.at(-1);
    if (lastRelease !== undefined) {
      const swept = await this.sweepServeOrphans(await this.store.readConfig(), false);
      const freed: DoctorAction[] = [];
      for (const orphan of swept) {
        const earlier = actions.find((action) => isOrphanAction(action) && action.target === `:${orphan.tailnet_port}`);
        if (earlier === undefined) freed.push(orphanAction(orphan));
        else if (orphan.fixed) settleOrphanAction(earlier, swept);
      }
      for (const action of freed) settleOrphanAction(action, swept);
      actions.splice(actions.indexOf(lastRelease) + 1, 0, ...freed);
    }
    for (const action of actions) {
      if (action.action === "install-nectard" || action.action === "reinstall-nectard") {
        await settle(action, async () => {
          await installUnit(this.paths);
          const deadline = Date.now() + 5_000;
          let state = await this.nectardState();
          while (state.problem !== undefined && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            state = await this.nectardState();
          }
          return { ok: state.problem === undefined, after: state.facts };
        });
      }
    }
    const startPack = actions.find((action) => action.action === "start-pack-server");
    const servePack = actions.find((action) => action.action === "serve-pack-store");
    let config = await this.store.readConfig();
    if (startPack !== undefined) {
      await settle(startPack, async () => {
        const local = await this.ensurePackServer(config);
        config = local.config;
        return { ok: true, after: { pid: config.pack_server_pid ?? null, port: config.pack_server_port, live: true, started: local.started } };
      });
    }
    if (servePack !== undefined && startPack?.status !== "failed") {
      await settle(servePack, async () => {
        const result = await servePackStore(`http://127.0.0.1:${config.pack_server_port}`);
        return { ok: result.ok, after: { proxy: result.ok, ...(result.message ? { message: result.message } : {}) } };
      });
    } else if (servePack !== undefined) {
      servePack.status = "skipped";
    }
  }

  private async hasFreePort(start: number, end: number): Promise<boolean> {
    for (let port = start; port <= end; port += 1) if (await portAvailable(port)) return true;
    return false;
  }
}
