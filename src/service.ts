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
import { NectarError } from "./errors.js";
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
import { createTestpackZip, currentPlatform, extractAndLaunch, extractTestpack, fetchVerified, fileSize, pathExists, readAndValidateManifest, sha256, writeManifest } from "./testpack.js";
import { trashPaths } from "./files.js";
import { gcTransition, packCandidates, selectPackPrunes, type GcTransition } from "./gc.js";
import type {
  DesktopRecipe,
  EnvRecord,
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
    if (record.serve === undefined) return;
    await stopProcessGroup(record.serve.pgid);
    await stopServe(record.serve.tailnet_port);
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
        await this.stopRuntime(record);
        record.status = "crashed";
        await this.store.writeEnv(record);
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
    let meshReady = false;
    if (identity.online && identity.dnsName !== undefined) meshReady = await serveWeb(tailnetPort, upstreamPort);
    if (meshReady && identity.dnsName !== undefined) {
      record.urls.mesh = `https://${identity.dnsName}:${tailnetPort}`;
    } else {
      record.urls.mesh = null;
      warnings.push(`tailscale unavailable or logged out — mesh URL unavailable; preview_url fell back to ${record.urls.local}`);
    }
    await this.store.writeEnv(record);

    const ready = await this.waitReady(upstreamPort, recipe.readyPath, recipe.readyTimeoutMs);
    if (!ready) {
      await this.stopRuntime(record);
      record.status = "crashed";
      await this.store.writeEnv(record);
      throw new NectarError("E_SERVE_TIMEOUT", `Serve did not return HTTP 200 at ${recipe.readyPath} within ${recipe.readyTimeoutMs}ms`, {
        log_tail: await logTail(this.paths, record.name),
      });
    }
    record.status = "serving";
    await this.store.writeEnv(record);
    return { record, warnings };
  }

  private async waitReady(port: number, readyPath: string, timeoutMs: number): Promise<boolean> {
    const pathPart = readyPath.startsWith("/") ? readyPath : `/${readyPath}`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${pathPart}`, { signal: AbortSignal.timeout(1_000) });
        if (response.status === 200) return true;
      } catch {
        // Process startup races are expected until the timeout.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
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

  private async buildTestpack(
    record: EnvRecord,
    recipe: DesktopRecipe,
    identity: MachineIdentity,
    embeddedWeb?: EnvRecord,
  ): Promise<{ sha256: string; size: number }> {
    const platform = currentPlatform();
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
    const built = await runShell(recipe.pack, record.worktree, env);
    if (built.exitCode !== 0) {
      record.status = "crashed";
      await this.store.writeEnv(record);
      throw new NectarError("E_INSTALL", `Desktop pack command failed: ${recipe.pack}`, {
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
    const draft = await readAndValidateManifest(packRoot);
    const publisher = record.publisher;
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
      built_at: new Date().toISOString(),
      built_by: {
        ...(publisher.hive_bee === undefined ? {} : { hive_bee: publisher.hive_bee }),
        ...(publisher.hive_session === undefined ? {} : { hive_session: publisher.hive_session }),
        host: identity.host,
      },
    };
    await writeManifest(packRoot, manifest);
    const temporaryZip = path.join(staging, `${base}.testpack.zip`);
    await createTestpackZip(packRoot, temporaryZip, `${base}.testpack`);
    const digest = await sha256(temporaryZip);
    const size = await fileSize(temporaryZip);
    const finalZip = path.join(packDirectory, `${base}.testpack.zip`);
    await trashPaths([finalZip], this.paths.root);
    await rename(temporaryZip, finalZip);
    const encodedPath = `${encodeURIComponent(record.name)}/${encodeURIComponent(path.basename(finalZip))}`;
    record.testpack = {
      file: path.basename(finalZip),
      sha256: digest,
      size_bytes: size,
      platform,
      entry: manifest.entry,
      url: identity.dnsName === undefined ? null : `https://${identity.dnsName}:8440/${encodedPath}`,
    };
    record.status = "serving";
    await this.store.writeEnv(record);
    await trashPaths([staging], this.paths.root);
    return { sha256: digest, size };
  }

  private packetFields(record: EnvRecord): PacketFields {
    return {
      preview_url: record.mode === "web" ? record.urls.mesh ?? record.urls.local : null,
      testpack_ref: record.mode === "desktop" ? record.ref : null,
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

  private async isLocalHost(host: string): Promise<boolean> {
    const identity = await this.identity();
    const osHost = (os.hostname().split(".")[0] ?? "").toLowerCase();
    return host === identity.host.toLowerCase() || host === osHost;
  }

  private isQualified(name: string): boolean {
    return name.endsWith("--web") || name.endsWith("--desktop");
  }

  private async localResolve(name: string, host: string, touch = true): Promise<ResolveResult | MultiResolveResult> {
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
      resolutions.push({
        env: record.name,
        mode: record.mode,
        urls: record.urls,
        testpack_url: record.testpack?.url ?? null,
        sha256: record.testpack?.sha256 ?? null,
        size_bytes: record.testpack?.size_bytes ?? null,
        platform: record.testpack?.platform ?? null,
        entry: record.testpack?.entry ?? null,
        host,
        status: record.status,
        ...(record.status === "crashed" ? { log_tail: await logTail(this.paths, record.name) } : {}),
      });
    }
    return this.isQualified(name) ? (resolutions[0] as ResolveResult) : { env: name, host, resolutions };
  }

  async resolve(input: string): Promise<ResolveResult | MultiResolveResult> {
    const identity = await this.identity();
    if (!isRef(input)) return this.localResolve(validateEnvName(input), identity.host);
    const parsed = parseRef(input);
    if (await this.isLocalHost(parsed.host)) return this.localResolve(parsed.env, parsed.host);
    return this.remoteResult<ResolveResult | MultiResolveResult>(parsed.host, ["resolve", parsed.env, "--json"]);
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

  async open(input: string): Promise<Record<string, unknown>> {
    const resolved = await this.resolve(input);
    if ("resolutions" in resolved) {
      throw new NectarError("E_NO_MODE", `Environment '${resolved.env}' has multiple modes; use a mode-qualified ref`);
    }
    if (resolved.mode === "web") {
      const url = resolved.urls.mesh ?? resolved.urls.local;
      if (url === null) throw new NectarError("E_NOT_FOUND", `Web environment '${resolved.env}' has no reachable URL`);
      const launcher = process.env.NECTAR_LAUNCH_BIN ?? "open";
      const result = await runCommand(launcher, [url]);
      if (result.exitCode !== 0) throw new NectarError("E_NOT_FOUND", result.stderr.trim() || `Could not open ${url}`);
      return { env: resolved.env, mode: resolved.mode, opened: url };
    }
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
    const local = await this.store.maybeEnv(resolved.env);
    const localSource =
      local?.testpack?.sha256 === resolved.sha256
        ? path.join(this.paths.packs, local.name, local.testpack.file)
        : undefined;
    const fetched = await fetchVerified({
      url: resolved.testpack_url,
      expectedSha256: resolved.sha256,
      paths: this.paths,
      ...(localSource === undefined ? {} : { localSource }),
    });
    const entry = await extractAndLaunch({
      zip: fetched.zip,
      sha: resolved.sha256,
      expectedPlatform: resolved.platform,
      expectedEntry: resolved.entry,
      paths: this.paths,
    });
    return { env: resolved.env, mode: resolved.mode, opened: entry, cache_hit: fetched.cacheHit, sha256: resolved.sha256 };
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
          if (!record.borrowed_worktree) await trashPaths([record.worktree], this.paths.root);
          record.status = "cold";
          await this.store.writeEnv(record);
          await runCommand("git", ["worktree", "prune"], { cwd: record.repo }).catch(() => undefined);
        } else {
          await this.stopRuntime(record);
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
