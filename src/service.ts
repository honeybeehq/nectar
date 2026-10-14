import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import {
  currentBranch,
  installDependencies,
  prepareWorktree,
  removeWorktree,
  resolveBranch,
  resolveCommit,
  resolveRepo,
  runGit,
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
  processBelongsToEnv,
  runCommand,
  runShell,
  scrubbedEnvironment,
  spawnDetached,
  spawnDetachedExecutable,
  stopEnvGroup,
  stopProcessGroup,
} from "./commands.js";
import { expiresAt, formatRemaining, parseDuration } from "./duration.js";
import { asNectarError, isErrorCode, NectarError } from "./errors.js";
import { appSlug, envName, formatRef, isRef, parseRef, validateEnvName, branchSlug } from "./refs.js";
import { loadRecipe, seedScenario, selectMode } from "./recipe.js";
import {
  assertDocker,
  composeFile,
  composeProject,
  composeSpec,
  composeUp,
  depEnvironment,
  depsDir,
  DOCKER_HINT,
  newPassword,
  postgresServices,
  probeDocker,
  readSecrets,
  redactedDeps,
  removeLabelled,
  assertProjectOwned,
  stopLabelled,
  writePrivateJson,
} from "./deps.js";
import { assertRuntimes, missingCommands } from "./fallbacks.js";
import { getPaths, type NectarPaths } from "./paths.js";
import { StateStore } from "./state.js";
import { logTail, prepareLog } from "./logs.js";
import {
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
  tailnetIdentity,
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
import { findStaticSite, stageStaticSite, STATIC_ROOTS, type StaticSite } from "./static-site.js";
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
import { exposureSub, relayAdd, relayHealth, relayRm } from "./relay.js";
import type {
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
}

interface MachineIdentity {
  host: string;
  dnsName?: string;
  online: boolean;
  config: MachineConfig;
}

interface PublishedWeb {
  record: EnvRecord;
  warnings: string[];
  meshError: string | null;
}

function meshWarning(outcome: ServeOutcome | undefined, fallback: string): string {
  if (outcome === undefined) return `tailscale unavailable or logged out — ${fallback}`;
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
  ran_at: string;
}

interface DeadHolder {
  env: string;
  status: EnvStatus;
  expires_at: string;
  process: boolean;
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

function ownsLoopbackPort(serve: ServeRecord | undefined, port: number | undefined): boolean {
  return port !== undefined && (serve?.upstream_port === port || serve?.proxy_port === port);
}

function loopbackPorts(records: EnvRecord[]): Set<number> {
  return new Set(
    records
      .flatMap((record) => [record.serve?.upstream_port, record.serve?.proxy_port, ...depPorts(record)])
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

export class NectarService {
  readonly paths: NectarPaths;
  readonly store: StateStore;

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
    const live = await tailnetIdentity();
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
      config,
    };
  }

  async publish(options: PublishOptions): Promise<Record<string, unknown>> {
    // Validate caller input before touching the repo — a bad --ttl is a usage
    // error, not a checkout problem.
    const ttlMs = parseDuration(options.ttl ?? DEFAULT_TTL, "ttl");
    const site = await this.staticCandidate(options);
    if (site !== undefined) return options.dryRun === true ? this.staticPlan(site, options) : this.publishStatic(site, options, ttlMs);
    const repo = await resolveRepo(options.repo ?? process.cwd());
    const slot = await resolveBranch(repo, options.branch);
    const branch = slot.branch;
    const loaded = await loadRecipe(repo);
    const recipe = options.name === undefined ? loaded : { ...loaded, name: appSlug(options.name) };
    const mode = selectMode(recipe, options.mode);
    if (options.dryRun === true) return this.recipePlan(recipe, mode, repo, slot);
    if (mode === "web") assertRuntimes(recipe);
    if (mode === "web" && Object.values(recipe.deps ?? {}).some((dep) => dep.kind === "postgres")) await assertDocker();
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
      serve: "Nectar's bundled static server (copy of the files under work/<name>)",
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
      urls: { local: null, mesh: null, public: old?.exposure?.url ?? null },
      ...(old?.exposure === undefined ? {} : { exposure: old.exposure }),
      ref: formatRef(identity.host, name),
      published_at: now.toISOString(),
      expires_at: expiresAt(now, options.ttlMs),
      last_touched_at: now.toISOString(),
      publisher: this.publisher ?? currentPublisher(),
      ...(options.packet === undefined ? {} : { packet_hint: options.packet }),
      ttl_ms: options.ttlMs,
      evidence: old?.evidence ?? [],
      ...(old?.install_hash === undefined ? {} : { install_hash: old.install_hash }),
      ...(old?.pinned === undefined ? {} : { pinned: old.pinned }),
      ...(old?.last_opened_at === undefined ? {} : { last_opened_at: old.last_opened_at }),
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

  private async stopRuntime(record: EnvRecord): Promise<void> {
    if (record.serve !== undefined) {
      await Promise.all([stopEnvGroup(record.serve.pgid, record.name), this.releaseServeEntry(record.serve)]);
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
      const owned = record.serve;
      const processCleanup = await Promise.resolve(stopEnvGroup(owned.pgid, record.name)).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (!processCleanup.ok) {
        cleanupErrors.push(`process group ${owned.pgid}: ${String(processCleanup.error)}`);
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
    if (serve.tailnet_port === undefined || serve.upstream_port === undefined) return false;
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
        const ownerAlive = owner?.serve === undefined ? false : await groupBelongsToEnv(owner.serve.pgid, owner.name);
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
      const records = await this.store.listEnvs();
      // The quota counts live web envs only — not ios streams, not silently-dead
      // servers a bee could never free by "running gc".
      const activeWeb = (
        await Promise.all(
          records
            .filter((record) => record.name !== name && record.mode === "web" && hasProbeableServe(record))
            .map(async (record) => this.refreshLiveness(record)),
        )
      ).filter((record) => holdsRuntime(record.status));
      const config = await this.store.readConfig();
      if (activeWeb.length >= config.serving_web_limit) {
        throw new NectarError("E_QUOTA", `Serving web-env quota (${config.serving_web_limit}) reached; run nectar gc or stop an env`);
      }
      if (
        old !== undefined &&
        holdsRuntime(old.status) &&
        (options.site !== undefined || (!old.borrowed_worktree && options.worktree === undefined))
      ) {
        return this.republishWeb(options, old);
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
        const depEnv = site === undefined ? await this.provisionDeps(record, loaded, options.fresh === true) : {};
        if (web.build !== undefined) await this.runBuild(record, web.build, depEnv);
        const published = await this.startWeb(record, web, initial.identity, initial.old, depEnv);
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
        if (web !== undefined) depEnv = await this.provisionDeps(record, loaded, options.fresh === true);
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
      const failure = asNectarError(error);
      throw new NectarError(
        failure.code,
        `${failure.message}; ${old.name} still serves the previous publish (${old.commit})`,
        { ...failure.details, still_serving: old.commit },
      );
    }
    await this.stopRuntime(old);
    await this.store.writeEnv(record);
    if (site === undefined && old.worktree !== destination) await this.discardWorktree(record.repo, old.worktree, old.repo);
    try {
      const published = await this.startWeb(record, web, identity, old, depEnv);
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

  private async provisionDeps(record: EnvRecord, recipe: Recipe, fresh: boolean): Promise<Record<string, string>> {
    const wanted = Object.entries(recipe.deps ?? {});
    const previous = fresh ? {} : (record.deps ?? {});
    const hadPostgres = Object.values(record.deps ?? {}).some((dep) => dep.kind === "postgres");
    const postgres = wanted.flatMap(([name, dep]) => (dep.kind === "postgres" ? [{ name, recipe: dep }] : []));
    const directory = depsDir(this.paths.work, record.name);
    if (wanted.length === 0) {
      if (record.deps === undefined) return {};
      await this.releaseDeps(record);
      await this.persistDeps(record);
      return {};
    }
    if (postgres.length > 0) await assertDocker();
    if (hadPostgres && (fresh || postgres.length === 0)) await removeLabelled(record.name, this.paths.root);
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
    const newPostgres: string[] = [];
    await this.store.withLock(PORTS_LOCK, async () => {
      const config = await this.store.readConfig();
      const reserved = loopbackPorts((await this.store.listEnvs()).filter((item) => item.name !== record.name));
      reserved.add(config.pack_server_port);
      for (const port of [record.serve?.upstream_port, record.serve?.proxy_port]) if (port !== undefined) reserved.add(port);
      for (const { name, recipe: dep } of postgres) {
        const prior = previous[name]?.kind === "postgres" ? previous[name] : undefined;
        if (prior === undefined) newPostgres.push(name);
        const port =
          prior?.port ??
          (await allocatePort({ start: config.upstream_port_start, end: config.upstream_port_end, reserved }));
        reserved.add(port);
        const password = secrets[name] ?? newPassword();
        secrets[name] = password;
        next[name] = {
          kind: "postgres",
          env: dep.env,
          image: dep.image,
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
        await assertProjectOwned(composeProject(record.name), this.paths.root);
        await this.composeUpDeps(record.name, next, secrets);
      } catch (error) {
        if (newPostgres.length > 0) await removeLabelled(record.name, this.paths.root, newPostgres).catch(() => undefined);
        if (fresh || before === undefined) delete record.deps;
        else record.deps = before;
        await this.persistDeps(record);
        if (Object.keys(postgresServices(record.deps, secrets)).length > 0) {
          await this.composeUpDeps(record.name, record.deps, secrets).catch(() => undefined);
        }
        throw error;
      }
    }
    const depEnv = depEnvironment(next, secrets);
    const seed = seedScenario(recipe);
    if ((created || newPostgres.length > 0) && seed !== undefined) await this.runSeed(record, seed, depEnv);
    return depEnv;
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
    if (Object.values(record.deps ?? {}).some((dep) => dep.kind === "postgres")) await stopLabelled(record.name, this.paths.root);
  }

  private async releaseDeps(record: EnvRecord): Promise<void> {
    if (record.deps === undefined) return;
    if (Object.values(record.deps).some((dep) => dep.kind === "postgres")) await removeLabelled(record.name, this.paths.root);
    await trashPaths([depsDir(this.paths.work, record.name)], this.paths.root);
    delete record.deps;
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
    spawnCommand: (upstreamPort: number) => { pid: number; pgid: number; cmd: string },
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
      for (const port of statusPorts(status)) reservedTailnet.add(port);
      const foreignPort = old?.serve !== undefined && (await this.foreignServeAt(old.serve, status)) ? old.serve.tailnet_port : undefined;
      if (old?.serve?.tailnet_port !== undefined && foreignPort === undefined) reservedTailnet.delete(old.serve.tailnet_port);
      const upstreamPort = await allocatePort({
        start: identity.config.upstream_port_start,
        end: identity.config.upstream_port_end,
        reserved: reservedUpstream,
        ...(old?.serve?.upstream_port === undefined ? {} : { preferred: old.serve.upstream_port }),
      });
      const tailnetPort = await allocatePort({
        start: identity.config.tailnet_port_start,
        end: identity.config.tailnet_port_end,
        reserved: reservedTailnet,
        ...(old?.serve?.tailnet_port === undefined ? {} : { preferred: old.serve.tailnet_port }),
      });
      const spawned = spawnCommand(upstreamPort);
      record.serve = {
        cmd: spawned.cmd,
        pid: spawned.pid,
        pgid: spawned.pgid,
        upstream_port: upstreamPort,
        tailnet_port: tailnetPort,
        ...(proxyPort === undefined ? {} : { proxy_port: proxyPort }),
      };
      record.urls.local = `http://127.0.0.1:${upstreamPort}`;
      await this.store.writeEnv(record);
      return { upstreamPort, tailnetPort, ...(foreignPort === undefined ? {} : { foreignPort }) };
    });
  }

  private async startWeb(
    record: EnvRecord,
    recipe: WebRecipe,
    identity: MachineIdentity,
    old: EnvRecord | undefined,
    depEnv: Record<string, string>,
  ): Promise<PublishedWeb> {
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
    record.urls.local = readyUrl.origin;
    warnings[0] = `portless registration is deferred in v0 — local URL degraded to ${record.urls.local}`;
    let mesh: ServeOutcome | undefined;
    if (identity.online && identity.dnsName !== undefined) mesh = await serveWeb(tailnetPort, await this.meshTarget(record));
    if (mesh?.ok === true && identity.dnsName !== undefined) {
      record.urls.mesh = `https://${identity.dnsName}:${tailnetPort}`;
    } else {
      record.urls.mesh = null;
      warnings.push(meshWarning(mesh, `mesh URL unavailable; preview_url fell back to ${record.urls.local}`));
    }
    record.status = "serving";
    delete record.failure;
    delete record.liveness;
    await this.store.writeEnv(record);
    return { record, warnings, meshError: mesh === undefined || mesh.ok ? null : mesh.message };
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
    record.serve = { cmd: recipe.run, pid: child.pid, pgid: child.pgid };
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
          public_url: record.exposure?.url ?? null,
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
        throw new NectarError("E_QUOTA", `Serving simulator quota (${config.serving_sim_limit}) reached; run nectar gc or stop an ios env`);
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
      warnings.push(meshWarning(mesh, `stream URL fell back to ${record.urls.local}`));
    }
    await this.store.writeEnv(record);
    return { warnings };
  }

  private packetFields(record: EnvRecord): PacketFields {
    return packetFieldsFor(record.mode, record.ref, record.urls, record.exposure?.url ?? null);
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
      const serve = record.serve;
      if (serve.upstream_port === undefined) return { revived: false, reason: "no_upstream_port" };
      const identity = await this.identity();
      if (options.kill && (await processBelongsToEnv(serve.pid, record.name))) await stopProcessGroup(serve.pgid);
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
          await this.composeUpDeps(record.name, record.deps, await readSecrets(depsDir(this.paths.work, record.name)));
        } catch (error) {
          return fail("E_DEPS", asNectarError(error).message);
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
      let spawned: { pid: number; pgid: number };
      try {
        spawned = spawnDetached(cmd, record.worktree, childEnv, log);
      } catch (error) {
        return fail("E_CHECKOUT", asNectarError(error).message);
      }
      record.serve = { ...serve, cmd, pid: spawned.pid, pgid: spawned.pgid, started_at: new Date().toISOString() };
      await this.store.writeEnv(record);
      const readyUrl = await this.waitReady(serve.upstream_port, readyPath, readyTimeoutMs);
      if (readyUrl === undefined) {
        await stopProcessGroup(spawned.pgid);
        return fail("E_SERVE_TIMEOUT", `Serve did not return HTTP 200 at ${readyPath} within ${readyTimeoutMs}ms`);
      }
      record.urls.local = readyUrl.origin;
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
        if (record.mode === "web" && holdsRuntime(record.status)) asserted = await this.assertMesh(record, identity);
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
    const direct = record.urls.local ?? `http://127.0.0.1:${record.serve?.upstream_port}`;
    const proxyPort = record.serve?.proxy_port;
    if (proxyPort === undefined || record.serve?.upstream_port === undefined) return direct;
    const upstream = await probeProxy(proxyPort, record.name);
    return upstream === record.serve.upstream_port ? `http://127.0.0.1:${proxyPort}` : direct;
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
        restored = (await serveWeb(tailnetPort, record.urls.local)).ok;
      },
      { bestEffort: true },
    );
    return restored;
  }

  async touchView(name: string): Promise<string | undefined> {
    return (await this.touchRecord(name, new Date()))?.expires_at;
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

  async list(options: { mode?: string; status?: string } = {}): Promise<Record<string, unknown>> {
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
      if (!(await this.isLocalHost(parsed.host))) return this.remoteResult(parsed.host, ["show", parsed.env, "--json"]);
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
        packet_fields: this.packetFields(record),
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
    const remote = await this.remoteResult<ResolveResult | MultiResolveResult>(parsed.host, ["resolve", parsed.env, "--json"]);
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
        await stopProcessGroup(child.pgid);
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
        return this.remoteResult(parsed.host, ["touch", parsed.env, ...(ttl === undefined ? [] : ["--ttl", ttl]), "--json"]);
      }
      input = parsed.env;
    }
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
        (holdsRuntime(current.status) || current.status === "publishing" || current.status === "crashed")
      ) {
        current.status = "stopped";
      }
      delete current.liveness;
      await this.store.writeEnv(current);
      return current;
    });
    return { env: record.name, status: record.status };
  }

  async remove(name: string, force = false): Promise<Record<string, unknown>> {
    return this.store.withLock(validateEnvName(name), async () => {
      const record = await this.store.readEnv(name);
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
      return { env: record.name, removed: true, forced: force, borrowed_worktree_preserved: record.borrowed_worktree };
    });
  }

  // Remove a live public route (nctr.site relay, D21). The relay's own hourly prune is
  // the backstop; this is the proactive half so a stopped/expired env stops answering
  // publicly at once. Best-effort: the relay being unreachable must not block gc/stop.
  private async tearDownExposure(record: EnvRecord): Promise<void> {
    if (record.exposure === undefined) return;
    const config = await this.store.readConfig();
    const target = config.exposures?.[record.exposure.target];
    if (target !== undefined) await relayRm(target, record.exposure.sub);
    delete record.exposure;
    record.urls.public = null;
  }

  async expose(
    input: string,
    options: { to: string; gate?: "password" | "none"; password?: string; public?: boolean; ttl?: string; exposeInteractive?: boolean },
  ): Promise<Record<string, unknown>> {
    if (isRef(input)) {
      const parsed = parseRef(input);
      if (!(await this.isLocalHost(parsed.host))) {
        const flags = [
          "expose", parsed.env, "--to", options.to, "--json",
          ...(options.gate === undefined ? [] : ["--gate", options.gate]),
          ...(options.password === undefined ? [] : ["--password", options.password]),
          ...(options.public === true ? ["--public"] : []),
          ...(options.ttl === undefined ? [] : ["--ttl", options.ttl]),
          ...(options.exposeInteractive === true ? ["--expose-interactive"] : []),
        ];
        return this.remoteResult(parsed.host, flags);
      }
      input = parsed.env;
    }
    const name = validateEnvName(input);
    return this.store.withLock(name, async () => {
      const config = await this.store.readConfig();
      const target = config.exposures?.[options.to];
      if (target === undefined) {
        throw new NectarError("E_EXPOSE", `No exposure target '${options.to}' in machine config (~/.nectar/nectar.json → exposures)`);
      }
      if (target.kind !== "relay") throw new NectarError("E_EXPOSE", `Exposure kind '${target.kind}' is not implemented in v0.2`);
      const record = await this.refreshLiveness(await this.store.readEnv(name));
      if (record.status !== "serving") {
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
      const password = gate === "password" ? options.password ?? crypto.randomBytes(9).toString("base64url") : undefined;
      const expiresEpoch = options.ttl
        ? Math.floor((Date.now() + parseDuration(options.ttl, "ttl")) / 1000)
        : Math.floor(new Date(record.expires_at).getTime() / 1000);
      const sub = record.exposure?.sub ?? exposureSub(record, isPublic);
      const added = await relayAdd({ target, sub, upstream, expiresEpoch, gate, ...(password === undefined ? {} : { password }) });
      record.exposure = {
        target: options.to,
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
        gate,
        ...(password === undefined ? {} : { password, credentials: { user: "reviewer", password } }),
        expires_at: record.exposure.expires_at,
        packet_fields: this.packetFields(record),
      };
    });
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
      const url = record.exposure.url;
      await this.tearDownExposure(record);
      await this.store.writeEnv(record);
      return { env: record.name, unexposed: true, was: url };
    });
  }

  async gc(options: { dryRun?: boolean } = {}): Promise<GcReport> {
    const now = new Date();
    const config = await this.store.readConfig();
    const orphanReport = await this.sweepServeOrphans(config, options.dryRun === true);
    const report: Array<{ env: string; action: GcTransition }> = [];
    const skipped: Array<{ env: string; reason: string }> = [];
    for (const snapshot of await this.store.listEnvs()) {
      const action = gcTransition(snapshot, now, config.idle_stop_ms);
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
          const currentAction = gcTransition(record, now, config.idle_stop_ms);
          if (currentAction === undefined) return;
          report.push({ env: record.name, action: currentAction });
          if (currentAction === "idle-stop") {
            await this.stopRuntime(record);
            delete record.serve;
            record.status = "warm";
            await this.store.writeEnv(record);
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
          }
        });
      } catch (error) {
        const nectarError = asNectarError(error);
        skipped.push({ env: snapshot.name, reason: nectarError.code === "E_BUSY" ? "busy" : nectarError.message });
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
      await stopProcessGroup(child.pgid);
      throw new NectarError("E_INTERNAL", `Read-only pack server did not start on 127.0.0.1:${port}`, {
        log_tail: await logTail(this.paths, "pack-store"),
      });
    }
    const updated: MachineConfig = {
      ...config,
      pack_server_port: port,
      pack_server_pid: child.pid,
      pack_server_pgid: child.pgid,
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

  async enableDaemon(): Promise<void> {
    const config = await this.store.readConfig();
    if (config.daemon === undefined) return;
    delete config.daemon;
    await this.store.writeConfig(config);
  }

  private async diagnose(noDaemon = false): Promise<Diagnosis> {
    const config = await this.store.readConfig();
    const identity = await tailnetIdentity();
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
    checks.push({
      name: "tailscale",
      status: identity === undefined ? "fail" : "pass",
      message:
        tailscale.source === "none"
          ? `No tailscale CLI found in NECTAR_TAILSCALE_BIN, PATH, ${TAILSCALE_FALLBACKS.join(", ")}; publishes will be local-only`
          : identity === undefined
            ? `Tailscale CLI ${tailscale.path} (${tailscale.source}) reports Tailscale down or logged out; publishes will be local-only`
            : `Tailscale is up as ${identity.dnsName} via ${tailscale.path} (${tailscale.source})`,
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
    const depsUsers = (await this.store.listEnvs())
      .filter((record) => Object.values(record.deps ?? {}).some((dep) => dep.kind === "postgres"))
      .map((record) => record.name);
    const docker = await probeDocker();
    checks.push({
      name: "docker",
      status: docker.ok ? "pass" : depsUsers.length > 0 ? "fail" : "warn",
      message: docker.ok
        ? `${docker.message}; [deps] postgres can run here`
        : `${docker.message}; ${depsUsers.length > 0 ? `envs with [deps] postgres cannot start: ${depsUsers.join(", ")}` : "publishing an app with [deps] postgres will fail with E_PLATFORM"}`,
      binary: docker.binary,
      ...(docker.ok ? {} : { hint: DOCKER_HINT }),
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
        const processHeld = await groupBelongsToEnv(serve.pgid, record.name);
        const entryHeld =
          serve.tailnet_port !== undefined &&
          serve.upstream_port !== undefined &&
          entries.some((entry) => entry.tailnetPort === serve.tailnet_port && ownsLoopbackPort(serve, loopbackProxy(entry.target)?.upstreamPort));
        if (!processHeld && !entryHeld) return undefined;
        return {
          env: record.name,
          status: record.status,
          expires_at: record.expires_at,
          process: processHeld,
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
