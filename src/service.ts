import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rename } from "node:fs/promises";
import { currentBranch, installDependencies, prepareWorktree, resolveCommit, resolveRepo } from "./git.js";
import { allocatePort, portAvailable, portOpen } from "./ports.js";
import {
  currentPublisher,
  pidAlive,
  runCommand,
  runShell,
  scrubbedEnvironment,
  spawnDetached,
  spawnDetachedExecutable,
  stopProcessGroup,
} from "./commands.js";
import { expiresAt, formatRemaining, parseDuration } from "./duration.js";
import { asNectarError, NectarError } from "./errors.js";
import { envName, formatRef, isRef, parseRef, validateEnvName, branchSlug } from "./refs.js";
import { loadRecipe, selectMode } from "./recipe.js";
import { getPaths, type NectarPaths } from "./paths.js";
import { StateStore } from "./state.js";
import { logTail, prepareLog } from "./logs.js";
import {
  remoteNectar,
  servePackStore,
  serveStatus,
  serveWeb,
  statusHasFunnel,
  statusHasPort,
  statusHasProxyTarget,
  stopServe,
  tailnetIdentity,
} from "./tailscale.js";
import { createTestpackZip, currentPlatform, extractAndLaunch, extractTestpack, extractVerified, fetchVerified, fileSize, pathExists, readAndValidateManifest, sha256, writeManifest } from "./testpack.js";
import { trashPaths } from "./files.js";
import { gcTransition, packCandidates, selectPackPrunes, type GcTransition } from "./gc.js";
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
import type {
  DesktopRecipe,
  EnvRecord,
  IosRecipe,
  MachineConfig,
  Mode,
  MultiResolveResult,
  PacketFields,
  Recipe,
  ResolveResult,
  TestpackManifest,
  WebRecipe,
} from "./types.js";

const DEFAULT_TTL = 72 * 60 * 60 * 1_000;

interface PublishOptions {
  repo?: string;
  mode?: string;
  branch?: string;
  ttl?: string;
  worktree?: string;
  packet?: string;
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

  constructor(root?: string) {
    this.paths = getPaths(root);
    this.store = new StateStore(this.paths);
  }

  private async identity(): Promise<MachineIdentity> {
    const config = await this.store.readConfig();
    const live = await tailnetIdentity();
    if (live !== undefined) {
      const updated = { ...config, tailnet_host: live.host, tailnet_dns_name: live.dnsName };
      await this.store.writeConfig(updated);
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
    const repo = await resolveRepo(options.repo ?? process.cwd());
    const branch = options.branch ?? (await currentBranch(repo));
    const recipe = await loadRecipe(repo);
    const mode = selectMode(recipe, options.mode);
    const ttlMs = parseDuration(options.ttl ?? "72h", "ttl");
    const publishOptions = {
      repo,
      branch,
      recipe,
      ttlMs,
      ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
      ...(options.packet === undefined ? {} : { packet: options.packet }),
    };
    if (mode === "web") {
      const web = await this.publishWeb(publishOptions);
      return this.publishResult(web.record, this.packetFields(web.record), web.warnings);
    }
    if (mode === "ios") return this.publishIos(publishOptions);
    return this.publishDesktop(publishOptions);
  }

  private async initialRecord(options: {
    repo: string;
    branch: string;
    recipe: Recipe;
    mode: Mode;
    ttlMs: number;
    worktree?: string;
    packet?: string;
  }): Promise<{ record: EnvRecord; old?: EnvRecord; identity: MachineIdentity }> {
    const name = envName(options.recipe.name, options.branch, options.mode);
    const old = await this.store.maybeEnv(name);
    const identity = await this.identity();
    const now = new Date();
    const destination = options.worktree ?? path.join(this.paths.work, name);
    const record: EnvRecord = {
      eid: old?.eid ?? crypto.randomBytes(2).toString("hex"),
      name,
      mode: options.mode,
      app: options.recipe.name,
      repo: options.repo,
      branch: options.branch,
      commit: old?.commit ?? "unknown",
      worktree: destination,
      borrowed_worktree: options.worktree !== undefined,
      status: "publishing",
      urls: { local: null, mesh: null },
      ref: formatRef(identity.host, name),
      published_at: now.toISOString(),
      expires_at: expiresAt(now, options.ttlMs),
      last_touched_at: now.toISOString(),
      publisher: currentPublisher(),
      ...(options.packet === undefined ? {} : { packet_hint: options.packet }),
      evidence: old?.evidence ?? [],
      ...(old?.install_hash === undefined ? {} : { install_hash: old.install_hash }),
    };
    await this.store.writeEnv(record);
    return { record, ...(old === undefined ? {} : { old }), identity };
  }

  private async checkout(record: EnvRecord, old: EnvRecord | undefined, borrowed: string | undefined): Promise<EnvRecord> {
    try {
      const commit = await resolveCommit(record.repo, record.branch);
      const checkout = await prepareWorktree({
        repo: record.repo,
        branch: record.branch,
        commit,
        destination: record.worktree,
        ...(borrowed === undefined ? {} : { borrowed }),
      });
      record.worktree = checkout.worktree;
      record.borrowed_worktree = checkout.borrowed;
      record.commit = checkout.commit;
      const installHash = await installDependencies(record.worktree, old?.install_hash);
      if (installHash === undefined) delete record.install_hash;
      else record.install_hash = installHash;
      await this.store.writeEnv(record);
      return record;
    } catch (error) {
      record.status = "crashed";
      await this.store.writeEnv(record);
      throw error;
    }
  }

  private async stopRuntime(record: EnvRecord): Promise<void> {
    if (record.serve !== undefined) {
      await Promise.all([stopProcessGroup(record.serve.pgid), stopServe(record.serve.tailnet_port)]);
    }
    if (record.mode === "ios" && record.sim_udid !== undefined) await shutdownSim(record.sim_udid);
  }

  private async cleanupRuntime(record: EnvRecord): Promise<string[]> {
    const cleanupErrors: string[] = [];
    if (record.serve !== undefined) {
      const owned = record.serve;
      const [processCleanup, serveCleanup] = await Promise.allSettled([
        stopProcessGroup(owned.pgid),
        stopServe(owned.tailnet_port),
      ]);
      if (processCleanup.status === "rejected") {
        cleanupErrors.push(`process group ${owned.pgid}: ${String(processCleanup.reason)}`);
      }
      if (serveCleanup.status === "rejected" || !serveCleanup.value) {
        cleanupErrors.push(`tailscale serve :${owned.tailnet_port}: could not confirm removal`);
      }
    }
    delete record.serve;
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
    recipe: Recipe;
    ttlMs: number;
    worktree?: string;
    packet?: string;
  }): Promise<PublishedWeb> {
    if (options.recipe.web === undefined) throw new NectarError("E_NO_RECIPE", "Recipe does not declare [web]");
    const name = envName(options.recipe.name, options.branch, "web");
    return this.store.withLock(name, async () => {
      const records = await this.store.listEnvs();
      const activeWeb = records.filter((record) => record.name !== name && record.status === "serving" && record.serve !== undefined);
      const config = await this.store.readConfig();
      if (activeWeb.length >= config.serving_web_limit) {
        throw new NectarError("E_QUOTA", `Serving web-env quota (${config.serving_web_limit}) reached; run nectar gc or stop an env`);
      }
      const initial = await this.initialRecord({ ...options, mode: "web" });
      if (initial.old !== undefined) await this.stopRuntime(initial.old);
      const record = await this.checkout(initial.record, initial.old, options.worktree);
      try {
        const branchRecipe = await loadRecipe(record.worktree);
        const web = branchRecipe.web;
        if (web === undefined) throw new NectarError("E_NO_RECIPE", "Published branch does not declare [web]");
        return await this.startWeb(record, web, initial.identity, initial.old, records);
      } catch (error) {
        await this.rollbackRuntime(record, error);
        throw error;
      }
    });
  }

  private async startWeb(
    record: EnvRecord,
    recipe: WebRecipe,
    identity: MachineIdentity,
    old: EnvRecord | undefined,
    records: EnvRecord[],
  ): Promise<PublishedWeb> {
    const reservedUpstream = new Set(
      records.filter((item) => item.name !== record.name).map((item) => item.serve?.upstream_port).filter((port): port is number => port !== undefined),
    );
    reservedUpstream.add(identity.config.pack_server_port);
    const reservedTailnet = new Set(
      records.filter((item) => item.name !== record.name).map((item) => item.serve?.tailnet_port).filter((port): port is number => port !== undefined),
    );
    // Port 443 belongs to the portless proxy, even if a bad machine config includes it.
    reservedTailnet.add(443);
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
    const log = await prepareLog(this.paths, record.name, identity.config.log_max_bytes);
    const childEnv = scrubbedEnvironment({
      ...recipe.env,
      PORT: String(upstreamPort),
      NECTAR_ENV: record.name,
      NECTAR_ENV_DIR: record.worktree,
    });
    const processRecord = spawnDetached(recipe.serve, record.worktree, childEnv, log);
    record.serve = {
      cmd: recipe.serve,
      pid: processRecord.pid,
      pgid: processRecord.pgid,
      upstream_port: upstreamPort,
      tailnet_port: tailnetPort,
    };
    record.urls.local = `http://127.0.0.1:${upstreamPort}`;
    const warnings = [`portless registration is deferred in v0 — local URL degraded to ${record.urls.local}`];
    await this.store.writeEnv(record);

    const readyUrl = await this.waitReady(upstreamPort, recipe.readyPath, recipe.readyTimeoutMs);
    if (readyUrl === undefined) {
      throw new NectarError("E_SERVE_TIMEOUT", `Serve did not return HTTP 200 at ${recipe.readyPath} within ${recipe.readyTimeoutMs}ms`, {
        log_tail: await logTail(this.paths, record.name),
      });
    }
    record.urls.local = readyUrl.origin;
    warnings[0] = `portless registration is deferred in v0 — local URL degraded to ${record.urls.local}`;
    let meshReady = false;
    if (identity.online && identity.dnsName !== undefined) meshReady = await serveWeb(tailnetPort, readyUrl.origin);
    if (meshReady && identity.dnsName !== undefined) {
      record.urls.mesh = `https://${identity.dnsName}:${tailnetPort}`;
    } else {
      record.urls.mesh = null;
      warnings.push(`tailscale unavailable or logged out — mesh URL unavailable; preview_url fell back to ${record.urls.local}`);
    }
    record.status = "serving";
    delete record.failure;
    await this.store.writeEnv(record);
    return { record, warnings };
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

  private async publishDesktop(options: {
    repo: string;
    branch: string;
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
      const record = await this.checkout(initial.record, initial.old, options.worktree);
      try {
        const branchRecipe = await loadRecipe(record.worktree);
        if (branchRecipe.desktop === undefined) throw new NectarError("E_NO_RECIPE", "Published branch does not declare [desktop]");
        const packResult = await this.buildTestpack(record, branchRecipe.desktop, initial.identity, embeddedWeb?.record);
        const packetFields: PacketFields = {
          preview_url: embeddedWeb === undefined ? null : embeddedWeb.record.urls.mesh ?? embeddedWeb.record.urls.local,
          testpack_ref: record.ref,
          shell_recipe: null,
        };
        return this.publishResult(record, packetFields, embeddedWeb?.warnings ?? [], {
          sha256: packResult.sha256,
          size_bytes: packResult.size,
          ...(embeddedWeb === undefined ? {} : { web_env: embeddedWeb.record.name }),
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
        throw new NectarError("E_PLATFORM", `Pack command did not produce $NECTAR_PACK_OUT (${packOut}) or ${zipOut}`);
      }
      packRoot = await extractTestpack(zipOut, path.join(staging, "extracted"));
    }
    return { staging, packRoot, base, packDirectory };
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
    await trashPaths([finalZip], this.paths.root);
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
    const draft = await readAndValidateManifest(pack.packRoot);
    const embedUrl =
      recipe.embedUrl === "web"
        ? embeddedWeb?.urls.mesh ?? embeddedWeb?.urls.local
        : recipe.embedUrl;
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
    await trashPaths([pack.staging], this.paths.root);
    return result;
  }

  private async publishIos(options: {
    repo: string;
    branch: string;
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
        (record) => record.name !== name && record.mode === "ios" && record.status === "serving" && record.serve !== undefined,
      );
      const config = await this.store.readConfig();
      if (activeSims.length >= config.serving_sim_limit) {
        throw new NectarError("E_QUOTA", `Serving simulator quota (${config.serving_sim_limit}) reached; run nectar gc or stop an ios env`);
      }
      const initial = await this.initialRecord({ ...options, mode: "ios" });
      if (initial.old !== undefined) {
        await this.stopRuntime(initial.old);
        if (initial.old.sim_udid !== undefined) {
          initial.record.sim_udid = initial.old.sim_udid;
          initial.record.sim_device = initial.old.sim_device ?? `nectar-${name}`;
        }
      }
      const record = await this.checkout(initial.record, initial.old, options.worktree);
      try {
        const branchRecipe = await loadRecipe(record.worktree);
        const ios = branchRecipe.ios;
        if (ios === undefined) throw new NectarError("E_NO_RECIPE", "Published branch does not declare [ios]");
        const pack = await this.buildSimpack(record, ios, initial.identity);
        const warnings: string[] = [];
        let axUrl: string | null = null;
        if (ios.stream) {
          // simctl failures fail the publish (F13); serve-sim failures only degrade it (F12).
          const sim = await this.ensureSimDevice(record, ios);
          await installSimApp(sim.udid, pack.entryPath);
          await launchSimApp(sim.udid, ios.bundleId);
          try {
            const stream = await this.startSimStream(record, sim.device, ios.readyTimeoutMs, initial.identity, initial.old, records);
            warnings.push(...stream.warnings);
            const streamUrl = record.urls.mesh ?? record.urls.local;
            if (streamUrl !== null) axUrl = `${streamUrl}/ax`;
          } catch (error) {
            const cleanupErrors = await this.cleanupRuntime(record);
            warnings.push(
              `stream unavailable — publish degraded to simpack-only: ${error instanceof Error ? error.message : String(error)}${cleanupErrors.length === 0 ? "" : ` (cleanup: ${cleanupErrors.join("; ")})`}`,
            );
          }
        } else {
          warnings.push("[ios].stream is false — simpack-only publish");
        }
        await trashPaths([pack.staging], this.paths.root);
        record.status = "serving";
        await this.store.writeEnv(record);
        return this.publishResult(record, this.packetFields(record), warnings, {
          sha256: pack.sha256,
          size_bytes: pack.size,
          ...(record.sim_udid === undefined ? {} : { sim_udid: record.sim_udid }),
          ax_url: axUrl,
        });
      } catch (error) {
        await this.stopRuntime(record);
        record.status = "crashed";
        await this.store.writeEnv(record);
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
    return { ...result, entryPath: path.join(pack.packRoot, draft.entry), staging: pack.staging };
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
    records: EnvRecord[],
  ): Promise<{ warnings: string[] }> {
    const reservedUpstream = new Set(
      records.filter((item) => item.name !== record.name).map((item) => item.serve?.upstream_port).filter((port): port is number => port !== undefined),
    );
    reservedUpstream.add(identity.config.pack_server_port);
    const reservedTailnet = new Set(
      records.filter((item) => item.name !== record.name).map((item) => item.serve?.tailnet_port).filter((port): port is number => port !== undefined),
    );
    reservedTailnet.add(443);
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
    const log = await prepareLog(this.paths, record.name, identity.config.log_max_bytes);
    const command = serveSimCommand(deviceName, upstreamPort);
    const childEnv = scrubbedEnvironment({ NECTAR_ENV: record.name, NECTAR_ENV_DIR: record.worktree });
    const processRecord = spawnDetached(command, record.worktree, childEnv, log);
    record.serve = {
      cmd: command,
      pid: processRecord.pid,
      pgid: processRecord.pgid,
      upstream_port: upstreamPort,
      tailnet_port: tailnetPort,
    };
    record.urls.local = `http://127.0.0.1:${upstreamPort}`;
    const warnings: string[] = [];
    await this.store.writeEnv(record);
    const readyUrl = await this.waitReady(upstreamPort, "/", readyTimeoutMs);
    if (readyUrl === undefined) {
      throw new NectarError("E_SERVE_TIMEOUT", `serve-sim did not become ready within ${readyTimeoutMs}ms`, {
        log_tail: await logTail(this.paths, record.name),
      });
    }
    record.urls.local = readyUrl.origin;
    let meshReady = false;
    if (identity.online && identity.dnsName !== undefined) meshReady = await serveWeb(tailnetPort, readyUrl.origin);
    if (meshReady && identity.dnsName !== undefined) {
      record.urls.mesh = `https://${identity.dnsName}:${tailnetPort}`;
    } else {
      record.urls.mesh = null;
      warnings.push(`tailscale unavailable or logged out — stream URL fell back to ${record.urls.local}`);
    }
    await this.store.writeEnv(record);
    return { warnings };
  }

  private packetFields(record: EnvRecord): PacketFields {
    return {
      preview_url: record.mode === "web" || record.mode === "ios" ? record.urls.mesh ?? record.urls.local : null,
      testpack_ref: record.mode === "desktop" || record.mode === "ios" ? record.ref : null,
      shell_recipe: null,
    };
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
    if (record.status !== "serving" || record.serve === undefined) return record;
    if (!pidAlive(record.serve.pid) || !(await portOpen(record.serve.upstream_port))) {
      record.status = "crashed";
      await this.store.writeEnv(record);
    }
    return record;
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
        expires_in: formatRemaining(record.expires_at),
        publisher_bee: record.publisher.hive_bee ?? null,
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
    return {
      env: record,
      ...(record.status === "crashed" ? { log_tail: await logTail(this.paths, record.name) } : {}),
    };
  }

  private async isLocalHost(host: string, knownIdentity?: MachineIdentity): Promise<boolean> {
    const identity = knownIdentity ?? (await this.identity());
    const requested = hostAliases(host);
    const local = [identity.host, identity.dnsName, os.hostname()].flatMap((value) => [...hostAliases(value)]);
    return local.some((alias) => requested.has(alias));
  }

  private isQualified(name: string): boolean {
    return name.endsWith("--web") || name.endsWith("--desktop") || name.endsWith("--ios");
  }

  private async localResolve(name: string, host: string, isSelf: boolean, touch = true): Promise<ResolveResult | MultiResolveResult> {
    const records = this.isQualified(name)
      ? [await this.store.readEnv(validateEnvName(name))]
      : (await this.store.listEnvs()).filter((record) => record.name.startsWith(`${validateEnvName(name)}--`));
    if (records.length === 0) throw new NectarError("E_NOT_FOUND", `Environment '${name}' was not found on this machine`);
    const resolutions: ResolveResult[] = [];
    for (const original of records) {
      const record = await this.refreshLiveness(original);
      if (touch) {
        const now = new Date();
        record.last_touched_at = now.toISOString();
        record.expires_at = expiresAt(now, DEFAULT_TTL);
        await this.store.writeEnv(record);
      }
      const streamUrl = isSelf ? record.urls.local ?? record.urls.mesh : record.urls.mesh ?? record.urls.local;
      resolutions.push({
        env: record.name,
        mode: record.mode,
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
        ...(record.status === "crashed" ? { log_tail: await logTail(this.paths, record.name) } : {}),
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
    if ("resolutions" in remote) {
      return {
        ...remote,
        is_self: false,
        resolutions: remote.resolutions.map((resolution) => ({ ...resolution, is_self: false })),
      };
    }
    return { ...remote, is_self: false };
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
      throw new NectarError("E_NOT_FOUND", envelope.error?.message ?? `Host '${host}' could not resolve the environment`);
    }
    return envelope.result as T;
  }

  async open(input: string, options: { noAx?: boolean } = {}): Promise<Record<string, unknown>> {
    const resolved = await this.resolve(input);
    if ("resolutions" in resolved) {
      throw new NectarError("E_NO_MODE", `Environment '${resolved.env}' has multiple modes; use a mode-qualified ref`);
    }
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

  private async launch(target: string): Promise<void> {
    const launcher = process.env.NECTAR_LAUNCH_BIN ?? "open";
    const result = await runCommand(launcher, [target]);
    if (result.exitCode !== 0) throw new NectarError("E_NOT_FOUND", result.stderr.trim() || `Could not open ${target}`);
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
      const reserved = new Set(
        (await this.store.listEnvs())
          .map((record) => record.serve?.upstream_port)
          .filter((value): value is number => value !== undefined),
      );
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

  async touch(input: string, ttl = "72h"): Promise<Record<string, unknown>> {
    const ttlMs = parseDuration(ttl, "ttl");
    if (isRef(input)) {
      const parsed = parseRef(input);
      if (!(await this.isLocalHost(parsed.host))) return this.remoteResult(parsed.host, ["touch", parsed.env, "--ttl", ttl, "--json"]);
      input = parsed.env;
    }
    const names = this.isQualified(input)
      ? [validateEnvName(input)]
      : (await this.store.listEnvs()).filter((record) => record.name.startsWith(`${validateEnvName(input)}--`)).map((record) => record.name);
    if (names.length === 0) throw new NectarError("E_NOT_FOUND", `Environment '${input}' was not found`);
    const now = new Date();
    for (const name of names) {
      const record = await this.store.readEnv(name);
      record.last_touched_at = now.toISOString();
      record.expires_at = expiresAt(now, ttlMs);
      await this.store.writeEnv(record);
    }
    return { envs: names, touched_at: now.toISOString(), expires_at: expiresAt(now, ttlMs) };
  }

  async stop(name: string): Promise<Record<string, unknown>> {
    const record = await this.store.readEnv(validateEnvName(name));
    await this.stopRuntime(record);
    record.status = "stopped";
    await this.store.writeEnv(record);
    return { env: record.name, status: record.status };
  }

  async remove(name: string, force = false): Promise<Record<string, unknown>> {
    const record = await this.store.readEnv(validateEnvName(name));
    await this.stopRuntime(record);
    await this.releaseSim(record);
    const targets = [
      path.join(this.paths.packs, record.name),
      path.join(this.paths.evidence, record.name),
      path.join(this.paths.logs, record.name),
      this.store.envFile(record.name),
    ];
    if (!record.borrowed_worktree) targets.push(record.worktree);
    await trashPaths(targets, this.paths.root);
    await runCommand("git", ["worktree", "prune"], { cwd: record.repo }).catch(() => undefined);
    return { env: record.name, removed: true, forced: force, borrowed_worktree_preserved: record.borrowed_worktree };
  }

  async gc(options: { dryRun?: boolean } = {}): Promise<Record<string, unknown>> {
    const now = new Date();
    const report: Array<{ env: string; action: GcTransition }> = [];
    for (const snapshot of await this.store.listEnvs()) {
      const action = gcTransition(snapshot, now);
      if (action === undefined) continue;
      if (options.dryRun) {
        report.push({ env: snapshot.name, action });
        continue;
      }
      await this.store.withLock(snapshot.name, async () => {
        const record = await this.store.readEnv(snapshot.name);
        const currentAction = gcTransition(record, now);
        if (currentAction === undefined) return;
        report.push({ env: record.name, action: currentAction });
        if (currentAction === "expire") {
          await this.stopRuntime(record);
          record.status = "expired";
          await this.store.writeEnv(record);
        } else if (currentAction === "cold") {
          await this.stopRuntime(record);
          await this.releaseSim(record);
          if (!record.borrowed_worktree) await trashPaths([record.worktree], this.paths.root);
          record.status = "cold";
          await this.store.writeEnv(record);
          await runCommand("git", ["worktree", "prune"], { cwd: record.repo }).catch(() => undefined);
        } else {
          await this.stopRuntime(record);
          await this.releaseSim(record);
          if (!record.borrowed_worktree) await trashPaths([record.worktree], this.paths.root);
          await trashPaths([this.store.envFile(record.name)], this.paths.root);
          await runCommand("git", ["worktree", "prune"], { cwd: record.repo }).catch(() => undefined);
        }
      });
    }
    const config = await this.store.readConfig();
    const current = await this.store.listEnvs();
    const protectedPacks = new Set(
      current
        .filter((record) => record.status === "serving" && record.testpack !== undefined)
        .map((record) => path.join(this.paths.packs, record.name, record.testpack?.file ?? "")),
    );
    const candidates = await packCandidates(this.paths.packs, protectedPacks);
    const packPrunes = selectPackPrunes(candidates, config.pack_quota_bytes);
    if (!options.dryRun) {
      await trashPaths(packPrunes.map((file) => file.path), this.paths.root);
      await this.store.writeConfig({ ...config, last_gc_at: now.toISOString() });
    }
    return {
      dry_run: options.dryRun ?? false,
      transitions: report,
      packs_pruned: packPrunes.map((file) => ({ file: path.relative(this.paths.root, file.path), size_bytes: file.size })),
      ran_at: now.toISOString(),
    };
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
      const reserved = new Set(
        (await this.store.listEnvs())
          .map((record) => record.serve?.upstream_port)
          .filter((value): value is number => value !== undefined),
      );
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
      throw new NectarError("E_CHECKOUT", `Read-only pack server did not start on 127.0.0.1:${port}`, {
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

  async doctor(options: { fix?: boolean } = {}): Promise<Record<string, unknown>> {
    await this.store.init();
    let config = await this.store.readConfig();
    const identity = await tailnetIdentity();
    const status = await serveStatus();
    const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; message: string; fixed?: boolean }> = [];
    const portlessBin = process.env.NECTAR_PORTLESS_BIN ?? "portless";
    let portlessPresent = false;
    let portlessProxy = false;
    try {
      const version = await runCommand(portlessBin, ["--version"], { timeoutMs: 2_000 });
      portlessPresent = version.exitCode === 0;
      if (portlessPresent) {
        const proxy = await runCommand(portlessBin, ["status", "--json"], { timeoutMs: 2_000 });
        portlessProxy = proxy.exitCode === 0;
      }
    } catch {
      // Missing portless is the expected v0 degraded-local case.
    }
    checks.push({
      name: "portless",
      status: portlessPresent && portlessProxy ? "pass" : "warn",
      message: !portlessPresent
        ? "Portless is not installed; v0 web publishes intentionally degrade local URLs to loopback"
        : portlessProxy
          ? "Portless and its proxy are up (name adoption remains deferred in v0)"
          : "Portless is installed but its proxy status could not be confirmed; local URLs degrade to loopback",
    });
    checks.push({
      name: "tailscale",
      status: identity === undefined ? "fail" : "pass",
      message: identity === undefined ? "Tailscale is down or logged out; publishes will be local-only" : `Tailscale is up as ${identity.dnsName}`,
    });
    checks.push({
      name: "serve-443",
      status: statusHasPort(status, 443) ? "fail" : "pass",
      message: statusHasPort(status, 443)
        ? "Tailscale serve has a 443 entry; this conflicts with the portless proxy and Nectar will not modify it"
        : "No conflicting Tailscale serve entry on 443",
    });
    const funnelOn = statusHasFunnel(status);
    checks.push({
      name: "funnel",
      status: funnelOn ? "fail" : "pass",
      message: funnelOn
        ? "A Tailscale Funnel entry exists; Nectar never invokes Funnel and will not alter unrelated public exposure"
        : "Tailscale Funnel is off in the Serve configuration",
    });
    let packServerLive = await this.packServerAlive(config);
    let packServerFixed = false;
    let proxyPresent = statusHasProxyTarget(status, 8440, `http://127.0.0.1:${config.pack_server_port}`);
    let proxyFixed = false;
    let fixMessage = "";
    if (options.fix && identity !== undefined && !funnelOn) {
      try {
        const local = await this.ensurePackServer(config);
        config = local.config;
        packServerFixed = local.started;
        packServerLive = true;
        if (!proxyPresent || local.started) {
          const result = await servePackStore(`http://127.0.0.1:${config.pack_server_port}`);
          proxyPresent = result.ok;
          proxyFixed = result.ok;
          fixMessage = result.message;
        }
      } catch (error) {
        fixMessage = error instanceof Error ? error.message : String(error);
        packServerLive = await this.packServerAlive(config);
      }
    }
    checks.push({
      name: "pack-loopback",
      status: packServerLive ? "pass" : "fail",
      message: packServerLive
        ? `Read-only pack server PID ${config.pack_server_pid} is live on 127.0.0.1:${config.pack_server_port}`
        : `Read-only pack server PID+port chain is down${fixMessage ? `: ${fixMessage}` : "; run nectar doctor --fix"}`,
      ...(packServerFixed ? { fixed: true } : {}),
    });
    checks.push({
      name: "pack-store-8440",
      status: packServerLive && proxyPresent ? "pass" : "fail",
      message:
        packServerLive && proxyPresent
          ? `Tailnet HTTPS :8440 proxies to the read-only loopback server on ${config.pack_server_port}`
          : `Pack-store proxy chain is incomplete${fixMessage ? `: ${fixMessage}` : "; run nectar doctor --fix"}`,
      ...(proxyFixed ? { fixed: true } : {}),
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
    const packs = await packCandidates(this.paths.packs, new Set());
    const packBytes = packs.reduce((sum, file) => sum + file.size, 0);
    checks.push({
      name: "pack-quota",
      status: packBytes <= config.pack_quota_bytes ? "pass" : "warn",
      message: `${packBytes} of ${config.pack_quota_bytes} pack bytes used`,
    });
    const gcAge = config.last_gc_at === undefined ? Number.POSITIVE_INFINITY : Date.now() - new Date(config.last_gc_at).getTime();
    checks.push({
      name: "gc-recency",
      status: gcAge <= 24 * 60 * 60 * 1_000 ? "pass" : "warn",
      message: config.last_gc_at === undefined ? "GC has never run on this machine" : `Last GC: ${config.last_gc_at}`,
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
    checks.push({
      name: "tailnet-acl",
      status: "warn",
      message: "Verify tailnet ACLs restrict ports 8440-8542 to operator-owned devices",
    });
    return { healthy: checks.every((check) => check.status !== "fail"), checks };
  }

  private async hasFreePort(start: number, end: number): Promise<boolean> {
    for (let port = start; port <= end; port += 1) if (await portAvailable(port)) return true;
    return false;
  }
}
